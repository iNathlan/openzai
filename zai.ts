import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { existsSync } from 'node:fs'

// 1. Ativa modo oculto para evitar bloqueios
puppeteer.use(StealthPlugin())

// CONFIGURAÇÕES FIXAS
const PORT = 9223;
const PROFILE_DIR = path.join(homedir(), '.config', 'opencode', 'brave-zai-profile');

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
                // 2. Conecta ao Navegador Persistente (Singleton)
                const browser = await getPersistentBrowser();
                let page = (await browser.pages()).find((p: any) => p.url().includes('chat.z.ai'));
                if (!page) {
                    page = (await browser.pages())[0] || await browser.newPage();
                    await page.goto('https://chat.z.ai', { waitUntil: 'networkidle0' });
                }

                // 3. Extrai Contexto e Ferramentas
                let bodyData: any = {};
                if (init?.body) {
                    const bodyStr = typeof init.body === 'string' ? init.body : await (init.body as Blob).text();
                    try { bodyData = JSON.parse(bodyStr); } catch(e) {}
                }
                const messages = bodyData.messages || [];
                const tools = bodyData.tools || [];

                // 4. Injeta System Prompt para Tool Use (Agente)
                let toolsPrompt = "";
                if (tools.length > 0) {
                    toolsPrompt = `
<system_tools>
Você é um agente com acesso a ferramentas locais. Para usar uma ferramenta, responda EXATAMENTE no formato JSON abaixo:
\`\`\`tool_call
{ "name": "nome_da_funcao", "arguments": { "param": "valor" } }
\`\`\`
Ferramentas disponíveis:
 ${JSON.stringify(tools, null, 2)}
</system_instructions>
`;
                }

                // 5. Formata o histórico (evita repetição)
                const formattedHistory = messages.map((m: any) => {
                    let content = "";
                    if (m.role === 'tool') {
                        content = `[TOOL RESULT]:\n${m.content}`;
                    } else if (typeof m.content === 'string') {
                        content = m.content;
                    } else if (Array.isArray(m.content)) {
                        content = m.content.map((p: any) => p.text || "").join("\n");
                    }
                    return `[${m.role.toUpperCase()}]:\n${content}`;
                }).join("\n\n---\n\n");

                const fullPrompt = `${toolsPrompt}\n\n${formattedHistory}`;

                console.log(`🧠 Contexto: ${fullPrompt.length} chars`);

                // 6. Envia via Clipboard (Instantâneo)
                const inputSelector = 'textarea, [contenteditable="true"]';
                await page.waitForSelector(inputSelector, { timeout: 5000 });
                
                // Limpa e Cola
                await page.click(inputSelector, { clickCount: 3 });
                await page.keyboard.press('Backspace');
                
                await page.evaluate((text) => navigator.clipboard.writeText(text), fullPrompt);
                await page.keyboard.down('Control');
                await page.keyboard.press('V');
                await page.keyboard.up('Control');
                await new Promise(r => setTimeout(r, 300));

                // 7. Prepara Interceptação de Stream
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const encoder = new TextEncoder();

                // Processa a resposta em background
                (async () => {
                    try {
                        // Intercepta a resposta da rede
                        const response = await page.waitForResponse((res: any) => 
                            res.url().includes('/api/v2/chat/completions'), 
                            { timeout: 180000 }
                        );

                        // Captura o stream do body (Node Stream)
                        const stream = response.body;
                        if (!stream) throw new Error("No stream body");

                        const reader = stream.getReader();
                        const decoder = new TextDecoder();
                        let accumulatedText = "";

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            const chunkText = decoder.decode(value, { stream: true });
                            const lines = chunkText.split('\n');

                            for (const line of lines) {
                                if (!line.trim() || line.startsWith(':')) continue;
                                
                                try {
                                    let jsonStr = line.startsWith('data: ') ? line.substring(6) : line;
                                    if (jsonStr === '[DONE]') continue;
                                    
                                    const json = JSON.parse(jsonStr);
                                    if (json.type === 'chat:completion' && json.data) {
                                        const content = json.data.delta_content || '';
                                        const isDone = json.data.done;
                                        
                                        accumulatedText += content;

                                        // Traduz para formato OpenAI
                                        const chunk: any = {
                                            id: "chatcmpl-zai",
                                            object: "chat.completion.chunk",
                                            choices: [{
                                                index: 0,
                                                delta: { content: content },
                                                finish_reason: isDone ? "stop" : null
                                            }]
                                        };

                                        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                                    }
                                } catch (e) { /* Ignora erros de parse parciais */ }
                            }
                        }

                        // 8. Pós-processamento: Detecta Tool Calls
                        const toolMatch = accumulatedText.match(/```tool_call\s*([\s\S]*?)\s*```/);
                        if (toolMatch) {
                            try {
                                const toolData = JSON.parse(toolMatch[1]);
                                console.log(`🔧 Tool detectada: ${toolData.name}`);
                                
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
                            } catch(err) { console.error("Tool parse error", err); }
                        }

                        await writer.write(encoder.encode("data: [DONE]\n\n"));
                    } catch (err: any) {
                        console.error("❌ Erro no processamento:", err.message);
                    } finally {
                        await writer.close();
                    }
                })();

                // Dispara o envio
                await page.keyboard.press('Enter');

                return new Response(readable, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' }
                });

            } catch (err: any) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500 })
            }
          },
        }
      },

      methods: [
        {
          type: 'oauth',
          label: 'Autenticar Z.ai',
          async authorize() {
            return {
              url: 'about:blank',
              instructions: 'O navegador abrirá. Logue e aguarde.',
              method: 'auto',
              async callback() {
                const browser = await getPersistentBrowser();
                return await detectAuth(browser, input);
              },
            }
          },
        },
      ],
    },
  }
}

// --- FUNÇÕES AUXILIARES ---

async function getPersistentBrowser() {
    try {
        // Tenta conectar a um navegador já aberto (Porta 9223)
        return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });
    } catch (e) {
        return launchNew();
    }
}

async function launchNew() {
    const bravePath = findBravePath();
    if (!bravePath) throw new Error("Brave não encontrado. Verifique o caminho na função findBravePath.");
    
    console.log(`📂 Abrindo navegador: ${bravePath}`);
    await fs.mkdir(PROFILE_DIR, { recursive: true });

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: bravePath,
      userDataDir: PROFILE_DIR,
      args: [
          `--remote-debugging-port=${PORT}`, // Porta fixa para reconexão
          '--no-sandbox', 
          '--disable-blink-features=AutomationControlled'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.goto('https://chat.z.ai', { waitUntil: 'networkidle0' });
    return browser;
}

function findBravePath(): string {
  // ════════════════════════════════════════════════════
  // SE O AUTOMÁTICO FALHAR, COLE O CAMINHO AQUI:
  // Ex: const MANUAL_PATH = "C:\\Users\\nathalan\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
  const MANUAL_PATH = ""; 
  // ════════════════════════════════════════════════════

  if (MANUAL_PATH && existsSync(MANUAL_PATH)) return MANUAL_PATH;
  if (process.platform !== 'win32') return '/usr/bin/brave-browser';

  // Busca automática no Windows
  const userPath = path.join(homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
  if (existsSync(userPath)) return userPath;

  const localApp = process.env.LOCALAPPDATA;
  if (localApp) {
      const p = path.join(localApp, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
      if (existsSync(p)) return p;
  }

  // Fallbacks
  if (existsSync('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')) 
      return 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

  return "";
}

async function detectAuth(browser: any, input: PluginInput): Promise<{ success: boolean; cookies?: string }> {
    let page = (await browser.pages())[0];
    try {
        if (!page.url().includes('z.ai')) await page.goto('https://chat.z.ai', { waitUntil: 'networkidle2' });
    } catch(e) {}
    
    console.log('⏳ Aguardando login...');
    
    for(let i=0; i<180; i++) {
        try {
            const cookies = await page.cookies('https://chat.z.ai', 'https://z.ai');
            if (cookies.some((c: any) => c.name === 'token')) {
                const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
                await input.client.auth.set({ path: { id: 'zai' }, body: { type: 'api', key: cookieString } });
                console.log('✅ Logado! Pode usar a CLI.');
                return { success: true, cookies: cookieString };
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000));
    }
    return { success: false };
}
