/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  Z.AI PLUGIN - VERSÃO OTIMIZADA E MESCLADA                                 ║
 * ║  Funcionalidades:                                                          ║
 * ║  • Autenticação OAuth com captura automática de cookies                   ║
 * ║  • Navegador persistente (porta 9223) para sessão contínua               ║
 * ║  • Streaming de resposta em tempo real                                     ║
 * ║  • Suporte completo a ferramentas (Tools)                                 ║
 * ║  • Tradução de formato Z.ai → OpenAI                                      ║
 * ║  • Input via clipboard para contextos grandes                             ║
 * ║  • Detecção e execução de Tool Calls                                      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { existsSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÕES GLOBAIS
// ═══════════════════════════════════════════════════════════════════════════════

// Ativa modo Stealth para evitar detecção de automação
puppeteer.use(StealthPlugin())

// Porta fixa para manter o navegador vivo entre requisições
const REMOTE_DEBUGGING_PORT = 9223

// Diretório do perfil do navegador (isola sessão)
const PROFILE_DIR = path.join(homedir(), '.config', 'opencode', 'brave-zai-profile')

// URL base da API Z.ai
const ZAI_BASE_URL = 'https://chat.z.ai'

// Timeout padrão para operações (em ms)
const DEFAULT_TIMEOUT = 180000 // 3 minutos

// ═══════════════════════════════════════════════════════════════════════════════
// TIPOS E INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

interface ZaiChunk {
  type: string
  data: {
    delta_content?: string
    phase?: 'thinking' | 'answering'
    done?: boolean
  }
}

interface OpenAIChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: string | null
  }>
}

interface ToolCallData {
  name: string
  arguments: Record<string, any>
}

interface BrowserManager {
  getBrowser(): Promise<any>
  getPage(): Promise<any>
  closeBrowser(): Promise<void>
}

// ═══════════════════════════════════════════════════════════════════════════════
// GERENCIADOR DE NAVEGADOR (SINGLETON)
// ═══════════════════════════════════════════════════════════════════════════════

class PersistentBrowserManager implements BrowserManager {
  private browser: any = null
  private page: any = null
  private isWarmingUp = false

  /**
   * Obtém ou cria uma conexão com o navegador persistente
   */
  async getBrowser(): Promise<any> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser
    }

    // Tenta conectar a um navegador já aberto
    try {
      this.browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${REMOTE_DEBUGGING_PORT}`,
        defaultViewport: null
      })
      console.log('✅ Conectado ao navegador existente')
      return this.browser
    } catch (e) {
      // Navegador não está rodando, precisa iniciar
      return await this.launchNewBrowser()
    }
  }

  /**
   * Obtém a página ativa do Z.ai
   */
  async getPage(): Promise<any> {
    const browser = await this.getBrowser()
    
    // Procura página existente do Z.ai
    const pages = await browser.pages()
    let page = pages.find((p: any) => p.url().includes('chat.z.ai'))
    
    if (!page) {
      page = pages[0] || await browser.newPage()
      await this.navigateToZai(page)
    }
    
    this.page = page
    return page
  }

  /**
   * Navega para o Z.ai e aguarda carregamento
   */
  private async navigateToZai(page: any): Promise<void> {
    this.isWarmingUp = true
    console.log('🌐 Navegando para Z.ai...')
    
    await page.goto(ZAI_BASE_URL, { waitUntil: 'networkidle0' })
    
    // Tempo para scripts de segurança carregarem
    await this.sleep(3000)
    
    this.isWarmingUp = false
    console.log('✅ Página pronta')
  }

  /**
   * Inicia um novo navegador
   */
  private async launchNewBrowser(): Promise<any> {
    const bravePath = this.findBravePath()
    
    if (!bravePath) {
      throw new Error(this.getBraveNotFoundMessage())
    }
    
    console.log(`🚀 Iniciando navegador: ${bravePath}`)
    
    // Garante que o diretório do perfil existe
    await fs.mkdir(PROFILE_DIR, { recursive: true })
    
    this.browser = await puppeteer.launch({
      headless: false,
      executablePath: bravePath,
      userDataDir: PROFILE_DIR,
      args: [
        `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    })
    
    const page = (await this.browser.pages())[0] || await this.browser.newPage()
    await this.navigateToZai(page)
    
    return this.browser
  }

  /**
   * Encontra o executável do Brave Browser
   */
  private findBravePath(): string {
    // ══════════════════════════════════════════════════════════════════
    // SE O AUTOMÁTICO FALHAR, COLE O CAMINHO COMPLETO AQUI:
    // Exemplo Windows: "C:\\Users\\SeuUsuario\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
    // Exemplo Linux: "/usr/bin/brave-browser"
    // Exemplo macOS: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    const MANUAL_PATH = ""
    // ══════════════════════════════════════════════════════════════════
    
    if (MANUAL_PATH && existsSync(MANUAL_PATH)) {
      return MANUAL_PATH
    }

    // Linux/Mac
    if (process.platform !== 'win32') {
      const linuxPaths = [
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      ]
      for (const p of linuxPaths) {
        if (existsSync(p)) return p
      }
      return '/usr/bin/brave-browser'
    }

    // Windows - tenta vários locais comuns
    const windowsPaths = [
      // Usuário atual (mais comum)
      path.join(homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      // Via variável de ambiente
      process.env.LOCALAPPDATA ? 
        path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : '',
      // Program Files
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      // Outras partições
      'D:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]

    for (const p of windowsPaths) {
      if (p && existsSync(p)) return p
    }

    return ""
  }

  /**
   * Mensagem de erro quando o Brave não é encontrado
   */
  private getBraveNotFoundMessage(): string {
    return `
╔════════════════════════════════════════════════════════════════════╗
║  ERRO: Navegador Brave não encontrado!                             ║
║                                                                    ║
║  1. Verifique se o Brave Browser está instalado                   ║
║  2. Encontre o arquivo "brave.exe" no seu computador              ║
║  3. Edite a variável MANUAL_PATH neste arquivo com o caminho      ║
║                                                                    ║
║  Caminhos comuns:                                                  ║
║  Windows: C:\\Users\\[Usuario]\\AppData\\Local\\BraveSoftware\\...     ║
║  Linux:   /usr/bin/brave-browser                                   ║
║  macOS:   /Applications/Brave Browser.app/Contents/MacOS/...      ║
╚════════════════════════════════════════════════════════════════════╝
`
  }

  /**
   * Fecha o navegador
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch (e) {
        // Ignora erros ao fechar
      }
      this.browser = null
      this.page = null
    }
  }

  /**
   * Aguarda o navegador terminar de aquecer
   */
  async waitForWarmup(): Promise<void> {
    while (this.isWarmingUp) {
      await this.sleep(100)
    }
  }

  /**
   * Utilitário de sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Instância global do gerenciador
const browserManager = new PersistentBrowserManager()

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITÁRIOS DE AUTENTICAÇÃO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detecta quando o usuário faz login e captura os cookies
 */
async function detectAuthAndCaptureCookies(
  browser: any, 
  input: PluginInput
): Promise<{ success: boolean; cookies?: string }> {
  const pages = await browser.pages()
  let page = pages[0]
  
  try {
    if (!page.url().includes('z.ai')) {
      await page.goto(ZAI_BASE_URL, { waitUntil: 'networkidle2' })
    }
  } catch (e) {
    // Página pode já estar no local certo
  }
  
  console.log('⏳ Aguardando login...')
  console.log('   → Faça login na janela do navegador aberta')
  
  // Loop de detecção (aguarda até 6 minutos)
  for (let i = 0; i < 180; i++) {
    try {
      const cookies = await page.cookies('https://chat.z.ai', 'https://z.ai')
      const hasToken = cookies.some((c: any) => c.name === 'token')
      
      if (hasToken) {
        const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ')
        
        // Salva no auth.json do sistema
        await input.client.auth.set({
          path: { id: 'zai' },
          body: { type: 'api', key: cookieString }
        })
        
        console.log('✅ Login detectado e cookies salvos!')
        console.log('   → Você já pode usar a CLI')
        
        return { success: true, cookies: cookieString }
      }
    } catch (e) {
      // Ignora erros temporários
    }
    
    await new Promise(r => setTimeout(r, 2000))
  }
  
  console.log('❌ Tempo esgotado aguardando login')
  return { success: false }
}

/**
 * Extrai o token do cookie string
 */
function extractTokenFromCookies(cookieString: string): string | null {
  const match = cookieString.match(/token=([^;]+)/)
  return match ? match[1] : null
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITÁRIOS DE STREAMING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converte chunk do Z.ai para formato OpenAI
 */
function convertZaiToOpenAI(content: string, isDone: boolean): OpenAIChunk {
  return {
    id: "chatcmpl-zai",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-5",
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: isDone ? "stop" : null
    }]
  }
}

/**
 * Cria chunk de tool call no formato OpenAI
 */
function createToolCallChunk(toolData: ToolCallData): OpenAIChunk {
  return {
    id: "chatcmpl-zai-tool",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-5",
    choices: [{
      index: 0,
      delta: {
        content: null,
        tool_calls: [{
          index: 0,
          id: `call_${Date.now()}`,
          type: 'function',
          function: {
            name: toolData.name,
            arguments: JSON.stringify(toolData.arguments)
          }
        }]
      },
      finish_reason: "tool_calls"
    }]
  }
}

/**
 * Detecta tool calls no texto da resposta
 */
function detectToolCalls(text: string): ToolCallData | null {
  const match = text.match(/```tool_call\s*([\s\S]*?)\s*```/)
  if (!match) return null
  
  try {
    return JSON.parse(match[1])
  } catch (e) {
    console.error('❌ Erro ao parsear tool call:', e)
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESSADOR DE MENSAGENS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Prepara o prompt completo com histórico e ferramentas
 */
function preparePrompt(messages: any[], tools: any[]): string {
  // Instruções de ferramentas (se houver)
  let toolsPrompt = ""
  if (tools.length > 0) {
    toolsPrompt = `
<system_tools>
Você é um agente com acesso a ferramentas do sistema. Para usar uma ferramenta, 
responda EXATAMENTE no formato JSON abaixo:

\`\`\`tool_call
{ "name": "nome_da_funcao", "arguments": { "parametro": "valor" } }
\`\`\`

Ferramentas disponíveis:
${JSON.stringify(tools, null, 2)}
</system_tools>
`
  }

  // Formata o histórico de mensagens
  const formattedHistory = messages.map(m => {
    let content = ""
    
    if (m.role === 'tool') {
      content = `[TOOL RESULT para ${m.tool_call_id}]:\n${m.content}`
    } else if (typeof m.content === 'string') {
      content = m.content
    } else if (Array.isArray(m.content)) {
      // Extrai texto de partes (incluindo texto de imagens)
      content = m.content
        .map((p: any) => {
          if (p.type === 'text') return p.text
          if (p.type === 'image_url') return '[Imagem fornecida]'
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    
    return `[${m.role.toUpperCase()}]:\n${content}`
  }).join('\n\n---\n\n')

  return `${toolsPrompt}\n\n${formattedHistory}`
}

/**
 * Envia mensagem via clipboard (instantâneo para textos grandes)
 */
async function sendMessageViaClipboard(page: any, message: string): Promise<void> {
  const inputSelector = 'textarea, [contenteditable="true"]'
  
  // Aguarda o campo de input estar disponível
  await page.waitForSelector(inputSelector, { timeout: 5000 })
  
  // Seleciona todo o conteúdo existente
  await page.click(inputSelector, { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await new Promise(r => setTimeout(r, 100))
  
  // Escreve no clipboard e cola (muito mais rápido que digitar)
  await page.evaluate((text) => navigator.clipboard.writeText(text), message)
  
  await page.keyboard.down('Control')
  await page.keyboard.press('V')
  await page.keyboard.up('Control')
  
  await new Promise(r => setTimeout(r, 300))
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESSADOR DE RESPOSTA STREAM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Processa a resposta do Z.ai e envia para o writer
 */
async function processStreamResponse(
  page: any,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
): Promise<void> {
  try {
    // Intercepta a resposta da API
    const response = await page.waitForResponse(
      (response: any) => response.url().includes('/api/v2/chat/completions'),
      { timeout: DEFAULT_TIMEOUT }
    )
    
    const text = await response.text()
    const lines = text.split('\n').filter((l: string) => l.trim().length > 0)
    
    let accumulatedText = ""
    
    for (const line of lines) {
      try {
        // Remove prefixo "data: " se existir
        let jsonStr = line.startsWith('data: ') ? line.substring(6) : line
        if (jsonStr === '[DONE]') continue
        
        const json: ZaiChunk = JSON.parse(jsonStr)
        
        if (json.type === 'chat:completion' && json.data) {
          const content = json.data.delta_content || ''
          const phase = json.data.phase
          const isDone = json.data.done
          
          accumulatedText += content
          
          // Ignora fase de "thinking" para saída limpa
          if (phase !== 'thinking') {
            const chunk = convertZaiToOpenAI(content, isDone || false)
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
        }
      } catch (e) {
        // Ignora erros de parse em fragments parciais
      }
    }
    
    // Pós-processamento: Detecta tool calls no texto acumulado
    const toolCall = detectToolCalls(accumulatedText)
    if (toolCall) {
      console.log(`🔧 Tool detectada: ${toolCall.name}`)
      const toolChunk = createToolCallChunk(toolCall)
      await writer.write(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`))
    }
    
    // Envia sinal de fim
    await writer.write(encoder.encode("data: [DONE]\n\n"))
    
  } catch (err: any) {
    console.error('❌ Erro no processamento:', err.message)
    throw err
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLUGIN PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

export default async function zaiPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: 'zai',
      
      /**
       * Carrega a autenticação salva e configura o fetch customizado
       */
      async loader(getAuth) {
        const auth = await getAuth()
        
        // Se não houver auth, retorna vazio (precisa autenticar)
        if (!auth || auth.type !== 'api' || !auth.key) {
          return {}
        }

        return {
          apiKey: 'browser-session',
          
          /**
           * Fetch customizado que usa o navegador como proxy
           */
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            try {
              // 1. Obtém o navegador e página
              const browser = await browserManager.getBrowser()
              const page = await browserManager.getPage()
              
              // Aguarda warmup se estiver em andamento
              await browserManager.waitForWarmup()
              
              // 2. Extrai dados do corpo da requisição
              let bodyData: any = {}
              if (init?.body) {
                const bodyStr = typeof init.body === 'string' 
                  ? init.body 
                  : await (init.body as Blob).text()
                try { 
                  bodyData = JSON.parse(bodyStr) 
                } catch (e) {}
              }
              
              const messages = bodyData.messages || []
              const tools = bodyData.tools || []
              
              console.log(`🧠 Processando requisição (${messages.length} mensagens, ${tools.length} ferramentas)`)
              
              // 3. Prepara o prompt completo
              const fullPrompt = preparePrompt(messages, tools)
              
              // 4. Envia a mensagem via clipboard
              await sendMessageViaClipboard(page, fullPrompt)
              
              // 5. Configura o stream de resposta
              const { readable, writable } = new TransformStream()
              const writer = writable.getWriter()
              const encoder = new TextEncoder()
              
              // 6. Processa a resposta em background
              ;(async () => {
                try {
                  // Envia a mensagem (Enter)
                  await page.keyboard.press('Enter')
                  console.log('⏳ Aguardando resposta...')
                  
                  // Processa o stream
                  await processStreamResponse(page, writer, encoder)
                  
                } catch (err: any) {
                  console.error('❌ Erro no stream:', err.message)
                } finally {
                  await writer.close()
                }
              })()
              
              // 7. Retorna o stream imediatamente
              return new Response(readable, {
                status: 200,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive'
                }
              })
              
            } catch (err: any) {
              console.error('❌ Erro fatal:', err.message)
              
              // Se for erro de conexão, limpa o browser para reconexão
              if (err.message.includes('connect') || err.message.includes('ECONNREFUSED')) {
                await browserManager.closeBrowser()
              }
              
              return new Response(
                JSON.stringify({ 
                  error: err.message,
                  hint: 'Tente executar o comando de autenticação novamente'
                }), 
                { status: 500 }
              )
            }
          },
        }
      },

      /**
       * Métodos de autenticação disponíveis
       */
      methods: [
        {
          type: 'oauth',
          label: 'Conectar com Z.ai (Automático)',
          async authorize() {
            return {
              url: 'about:blank',
              instructions: 'O navegador será aberto automaticamente. Faça login na sua conta Z.ai e aguarde a confirmação.',
              method: 'auto',
              
              async callback() {
                try {
                  const browser = await browserManager.getBrowser()
                  const result = await detectAuthAndCaptureCookies(browser, input)
                  
                  return result.success
                    ? { type: 'success', key: result.cookies, provider: 'zai' }
                    : { type: 'failed' }
                    
                } catch (err: any) {
                  console.error('❌ Erro na autenticação:', err.message)
                  return { type: 'failed' }
                }
              },
            }
          },
        },
      ],
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS ADICIONAIS (para uso externo se necessário)
// ═══════════════════════════════════════════════════════════════════════════════

export { 
  browserManager,
  detectAuthAndCaptureCookies,
  preparePrompt,
  convertZaiToOpenAI,
  createToolCallChunk,
  detectToolCalls
}

export type { 
  ZaiChunk, 
  OpenAIChunk, 
  ToolCallData, 
  BrowserManager 
}
