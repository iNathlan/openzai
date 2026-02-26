import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { existsSync } from 'node:fs'
puppeteer.use(StealthPlugin())
const PORT = 9223;
const PROFILE_DIR = path.join(homedir(), '.config', 'opencode', 'brave-zai-profile');
const CONFIG_DIR = path.join(homedir(), '.config', 'opencode');
const COOKIES_FILE = path.join(CONFIG_DIR, 'zai-cookies.json');
export default async function zaiPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: 'zai',
     
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || auth.type !== 'api' || !auth.key) return {}
        return {
          apiKey: 'browser-session',
         
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            try {
                const browser = await getPersistentBrowser();
                let page = (await browser.pages()).find((p: any) => p.url().includes('chat.z.ai'));
                if (!page) {
                    page = (await browser.pages())[0] || await browser.newPage();
                    await page.goto('https://chat.z.ai', { waitUntil: 'networkidle0' });
                    await new Promise(r => setTimeout(r, 3000));
                }
                // Extrai dados do body (mensagens, tools, configs)
                let bodyData: any = {};
                if (init?.body) {
                    const bodyStr = typeof init.body === 'string' ? init.body : await (init.body as Blob).text();
                    try { bodyData = JSON.parse(bodyStr); } catch(e) {}
                }
                const messages = bodyData.messages || [];
                const tools = bodyData.tools || [];
                const temperature = bodyData.temperature ?? 1;
                const topP = bodyData.top_p ?? 1;
                const maxTokens = bodyData.max_tokens ?? 131072;
                // Injeta prompt para tools se existirem
                let toolsPrompt = "";
                if (tools.length > 0) {
                    toolsPrompt = `
<system_tools>
You have access to the following tools. To use a tool, reply with a JSON object in the format:
\`\`\`tool_call
{ "name": "tool_name", "arguments": { ... } }
\`\`\`
Available Tools:
${JSON.stringify(tools, null, 2)}
</system_tools>
`;
                }
                // Formata histórico completo
                const formattedHistory = messages.map((m: any) => {
                    let content = "";
                    if (m.role === 'tool') {
                        content = `[TOOL RESULT for ${m.tool_call_id || ''}]:\n${m.content}`;
                    } else if (typeof m.content === 'string') {
                        content = m.content;
                    } else if (Array.isArray(m.content)) {
                        content = m.content.map((p: any) => p.text || (p.type === 'image_url' ? '[Image]' : '')).join("\n");
                    }
                    return `[${m.role.toUpperCase()}]:\n${content}`;
                }).join("\n\n---\n\n");
                const fullPrompt = `${toolsPrompt}\n\n${formattedHistory}`;
                console.log(`🧠 Enviando prompt (${fullPrompt.length} chars)...`);
                // Input via clipboard para eficiência
                const inputSelector = 'textarea, [contenteditable="true"]';
                await page.waitForSelector(inputSelector, { timeout: 5000 });
                await page.click(inputSelector, { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 100));
                await page.evaluate((text) => navigator.clipboard.writeText(text), fullPrompt);
                await page.keyboard.down('Control');
                await page.keyboard.press('V');
                await page.keyboard.up('Control');
                await new Promise(r => setTimeout(r, 300));
                // Prepara stream
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const encoder = new TextEncoder();
                // Processa resposta
                (async () => {
                    try {
                        const responsePromise = page.waitForResponse((response: any) => response.url().includes('/api/v2/chat/completions'), { timeout: 180000 });
                        await page.keyboard.press('Enter');
                        console.log('⏳ Aguardando stream...');
                        const response = await responsePromise;
                        const text = await response.text();
                        const lines = text.split('\n').filter(l => l.trim());
                        let accumulatedText = "";
                        for (const line of lines) {
                            try {
                                let jsonStr = line.startsWith('data: ') ? line.substring(6) : line;
                                if (jsonStr === '[DONE]') continue;
                                const json = JSON.parse(jsonStr);
                                if (json.type === 'chat:completion' && json.data) {
                                    const content = json.data.delta_content || '';
                                    const phase = json.data.phase || '';
                                    const isDone = json.data.done;
                                    accumulatedText += content;
                                    const chunk = {
                                        id: "chatcmpl-zai",
                                        object: "chat.completion.chunk",
                                        created: Math.floor(Date.now() / 1000),
                                        model: "glm-5",
                                        choices: [{
                                            index: 0,
                                            delta: { content: phase === 'thinking' ? `💭 ${content}` : content },
                                            finish_reason: isDone ? "stop" : null
                                        }]
                                    };
                                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                                }
                            } catch (e) {}
                        }
                        // Detecta tool calls
                        const toolMatch = accumulatedText.match(/```tool_call\s*([\s\S]*?)\s*```/);
                        if (toolMatch) {
                            try {
                                const toolData = JSON.parse(toolMatch[1]);
                                const toolChunk = {
                                    id: "chatcmpl-zai-tool",
                                    object: "chat.completion.chunk",
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            content: null,
                                            tool_calls: [{
                                                index: 0,
                                                id: `call_${Date.now()}`,
                                                type: "function",
                                                function: {
                                                    name: toolData.name,
                                                    arguments: JSON.stringify(toolData.arguments)
                                                }
                                            }]
                                        },
                                        finish_reason: "tool_calls"
                                    }]
                                };
                                await writer.write(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`));
                            } catch (err) {}
                        }
                        await writer.write(encoder.encode("data: [DONE]\n\n"));
                    } catch (err: any) {
                        console.error("❌ Erro:", err.message);
                    } finally {
                        await writer.close();
                    }
                })();
                return new Response(readable, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
                });
            } catch (err: any) {
                console.error('❌ Erro:', err.message);
                return new Response(JSON.stringify({ error: err.message }), { status: 500 })
            }
          },
        }
      },
      methods: [
        {
          type: 'oauth',
          label: 'Conectar com z.ai (Automático)',
          async authorize() {
            return {
              url: 'about:blank',
              instructions: 'O navegador abrirá. Faça login e aguarde a captura automática.',
              method: 'auto',
              async callback() {
                const browser = await getPersistentBrowser();
                return await captureZaiCookiesAuto(browser, input);
              },
            }
          },
        },
      ],
    },
  }
}
// Função otimizada para captura de cookies (com loop para HttpOnly, stealth e detecção robusta)
async function captureZaiCookiesAuto(browser: any, input: PluginInput): Promise<{ success: boolean; cookies?: string }> {
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.goto('https://z.ai', { waitUntil: 'networkidle2' });
    console.log('⏳ Aguardando login...');
    let found = false;
    let attempts = 0;
    const maxAttempts = 150;
    while (!found && attempts < maxAttempts) {
      if (!browser.isConnected()) throw new Error('Navegador fechado.');
      const cookies = await page.cookies('https://chat.z.ai', 'https://z.ai');
      const hasToken = cookies.some(c => c.name === 'token' || c.name === 'oauth_id_token');
      if (hasToken) {
        found = true;
        const relevantCookies = cookies.filter(c => c.domain.includes('z.ai') || c.name === 'token' || c.name === 'oauth_id_token');
        const cookieString = relevantCookies.map(c => `${c.name}=${c.value}`).join('; ');
        await input.client.auth.set({
          path: { id: 'zai' },
          body: { type: 'api', key: cookieString },
        });
        console.log('✅ Cookies capturados e salvos!');
        return { success: true, cookies: cookieString };
      }
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }
    throw new Error('Timeout: Login não detectado.');
  } catch (error: any) {
    console.error('❌ Erro na captura:', error.message);
    return { success: false };
  } finally {
    // Não fecha o browser, mantém persistente
  }
}
// Funções de suporte (merge de path finding, launch, persistent)
async function getPersistentBrowser() {
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });
  } catch (e) {
    return launchNew();
  }
}
async function launchNew() {
  const bravePath = findBravePath();
  if (!bravePath) throw new Error("Brave não encontrado. Verifique o caminho.");
  console.log(`📂 Abrindo: ${bravePath}`);
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: bravePath,
    userDataDir: PROFILE_DIR,
    args: [`--remote-debugging-port=${PORT}`, '--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto('https://chat.z.ai', { waitUntil: 'networkidle2' });
  return browser;
}
function findBravePath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const paths = [
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  } else if (platform === 'darwin') {
    return '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  } else {
    return 'brave-browser';
  }
  return "";
}
