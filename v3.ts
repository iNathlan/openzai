import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { existsSync } from 'node:fs'

puppeteer.use(StealthPlugin())

// ==================== CONFIGURAÇÕES GLOBAIS (NUNCA MUDE AQUI) ====================
const PORT = 9223
const PROFILE_DIR = path.join(homedir(), '.config', 'opencode', 'brave-zai-profile')
const MANUAL_BRAVE_PATH = "" // ← COLE AQUI O CAMINHO COMPLETO DO brave.exe SE O AUTO-FIND FALHAR

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
              // 1. Navegador persistente (conecta ou abre)
              const browser = await getPersistentBrowser()
              let page = (await browser.pages()).find((p: any) => p.url().includes('chat.z.ai'))
              if (!page) {
                page = (await browser.pages())[0] || await browser.newPage()
                await page.goto('https://chat.z.ai', { waitUntil: 'networkidle0' })
                await new Promise(r => setTimeout(r, 3000)) // warmup Shumei
              }

              // 2. Extrai TUDO do corpo (mensagens, tools, configs do opencode.json)
              let bodyData: any = {}
              if (init?.body) {
                const bodyStr = typeof init.body === 'string' ? init.body : await (init.body as Blob).text()
                try { bodyData = JSON.parse(bodyStr) } catch (_) {}
              }
              const messages = bodyData.messages || []
              const tools = bodyData.tools || []
              const temperature = bodyData.temperature ?? 1
              const topP = bodyData.topP ?? 1
              const maxTokens = bodyData.max_tokens ?? 131072

              // 3. Injeta instruções de TOOLS (funciona perfeitamente)
              let toolsPrompt = ""
              if (tools.length > 0) {
                toolsPrompt = `
<system_tools>
Você é um agente com ferramentas locais. Para usar uma ferramenta responda EXATAMENTE assim (nada mais, nada menos):

\`\`\`tool_call
{ "name": "nome_da_funcao", "arguments": { "param": "valor" } }
\`\`\`

Ferramentas disponíveis:
${JSON.stringify(tools, null, 2)}
</system_tools>
`
              }

              // 4. Formata histórico completo (inclui resultados de tools anteriores)
              const formattedHistory = messages.map((m: any) => {
                let content = ""
                if (m.role === 'tool') content = `[TOOL RESULT for ${m.tool_call_id}]:\n${m.content}`
                else if (typeof m.content === 'string') content = m.content
                else if (Array.isArray(m.content)) content = m.content.map((p: any) => p.text || "").join("\n")
                return `[${m.role.toUpperCase()}]:\n${content}`
              }).join("\n\n---\n\n")

              const fullPrompt = `${toolsPrompt}\n\n${formattedHistory}`.trim()

              console.log(`🧠 Enviando contexto (${fullPrompt.length} chars) + tools(${tools.length}) para o navegador aberto...`)

              // 5. Envia via Clipboard (rápido e humano)
              const inputSelector = 'textarea, [contenteditable="true"], div[role="textbox"]'
              await page.waitForSelector(inputSelector, { timeout: 10000 })

              await page.click(inputSelector, { clickCount: 3 })
              await page.keyboard.press('Backspace')
              await new Promise(r => setTimeout(r, 100))

              await page.evaluate((text: string) => navigator.clipboard.writeText(text), fullPrompt)
              await page.keyboard.down('Control')
              await page.keyboard.press('V')
              await page.keyboard.up('Control')
              await new Promise(r => setTimeout(r, 400))

              // 6. Prepara stream SSE para CLI
              const { readable, writable } = new TransformStream()
              const writer = writable.getWriter()
              const encoder = new TextEncoder()

              // 7. Processamento em background (captura resposta real da rede)
              ;(async () => {
                try {
                  const responsePromise = page.waitForResponse((resp: any) =>
                    resp.url().includes('/api/v2/chat/completions') || resp.url().includes('/chat'),
                    { timeout: 180000 }
                  )

                  await page.keyboard.press('Enter') // Envia de verdade no navegador aberto
                  console.log('⏳ Enviado! Aguardando resposta do z.ai (visível no navegador)...')

                  const response = await responsePromise
                  const text = await response.text()

                  const lines = text.split('\n').filter((l: string) => l.trim().length > 0)
                  let accumulated = ""

                  for (const line of lines) {
                    try {
                      let jsonStr = line.startsWith('data: ') ? line.substring(6) : line
                      if (jsonStr === '[DONE]') continue

                      const json = JSON.parse(jsonStr)
                      if (json.type === 'chat:completion' && json.data) {
                        const content = json.data.delta_content || ''
                        const phase = json.data.phase || ''
                        const isDone = json.data.done

                        accumulated += content

                        const chunk: any = {
                          id: "chatcmpl-zai",
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: "glm-5",
                          choices: [{
                            index: 0,
                            delta: { content: phase === 'thinking' ? `💭 ${content}` : content },
                            finish_reason: isDone ? "stop" : null
                          }]
                        }
                        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                      }
                    } catch (_) {}
                  }

                  // 8. DETECÇÃO DE TOOL CALL (funciona 100%)
                  const toolMatch = accumulated.match(/```tool_call\s*([\s\S]*?)\s*```/)
                  if (toolMatch) {
                    try {
                      const toolData = JSON.parse(toolMatch[1])
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
                      }
                      await writer.write(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`))
                      console.log(`🔧 Tool detectada e enviada para CLI: ${toolData.name}`)
                    } catch (e) { console.error("Falha ao parsear tool_call", e) }
                  }

                  await writer.write(encoder.encode("data: [DONE]\n\n"))
                } catch (err: any) {
                  console.error("❌ Erro no stream:", err.message)
                } finally {
                  await writer.close()
                }
              })()

              return new Response(readable, {
                status: 200,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive'
                }
              })

            } catch (err: any) {
              console.error('❌ Erro crítico no fetch:', err.message)
              return new Response(JSON.stringify({ error: err.message }), { status: 500 })
            }
          }
        }
      },

      methods: [
        {
          type: 'oauth',
          label: 'Conectar z.ai (MASTER - Navegador Aberto + Tools)',
          async authorize() {
            return {
              url: 'about:blank',
              instructions: 'O Brave abrirá. Faça login normalmente. O plugin detecta automaticamente e mantém o navegador aberto para sempre.',
              method: 'auto',
              async callback() {
                const browser = await getPersistentBrowser()
                const result = await detectAuth(browser, input)
                return result.success
                  ? { type: 'success', key: result.cookies, provider: 'zai' }
                  : { type: 'failed' }
              }
            }
          }
        }
      ]
    }
  }
}

// ====================== FUNÇÕES AUXILIARES ======================
async function getPersistentBrowser() {
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  } catch (_) {
    return launchNew()
  }
}

async function launchNew() {
  let bravePath = findBravePath()
  if (!bravePath) throw new Error("Brave não encontrado. Edite MANUAL_BRAVE_PATH no topo do arquivo.")

  console.log(`🚀 Iniciando navegador PERSISTENTE: ${bravePath}`)
  await fs.mkdir(PROFILE_DIR, { recursive: true })

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: bravePath,
    userDataDir: PROFILE_DIR,
    args: [
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  })

  const page = (await browser.pages())[0] || await browser.newPage()
  await page.goto('https://chat.z.ai', { waitUntil: 'networkidle0' })
  return browser
}

function findBravePath(): string {
  if (MANUAL_BRAVE_PATH && existsSync(MANUAL_BRAVE_PATH)) return MANUAL_BRAVE_PATH

  if (process.platform !== 'win32') return '/usr/bin/brave-browser'

  const paths = [
    path.join(homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : '',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
  ]

  for (const p of paths) if (p && existsSync(p)) return p
  return ""
}

async function detectAuth(browser: any, input: PluginInput): Promise<{ success: boolean; cookies?: string }> {
  let page = (await browser.pages())[0]
  if (!page.url().includes('z.ai')) await page.goto('https://chat.z.ai', { waitUntil: 'networkidle2' })

  console.log('⏳ Aguardando login no navegador aberto... (faça login normalmente)')

  for (let i = 0; i < 180; i++) {
    try {
      const cookies = await page.cookies('https://chat.z.ai', 'https://z.ai')
      if (cookies.some((c: any) => c.name === 'token')) {
        const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ')
        await input.client.auth.set({
          path: { id: 'zai' },
          body: { type: 'api', key: cookieString }
        })
        console.log('✅ Login capturado! O navegador ficará aberto. Agora use o CLI normalmente.')
        return { success: true, cookies: cookieString }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 2000))
  }
  return { success: false }
}
