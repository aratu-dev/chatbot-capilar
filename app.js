const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const P = require('pino')
const fs = require('fs')
const path = require('path')
const http = require('http')

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────────────────

const MENSAGEM_GATILHO = 'quero conhecer a clinica'
const COMANDOS_REINICIO = ['menu', 'reiniciar', 'comecar', 'começar']
const PORT = process.env.PORT || 3000

const MENSAGEM_FINAL = `✅ *Perfeito!* Já tenho informações suficientes para o seu pré-atendimento.

Nossa terapeuta capilar vai conseguir te atender com mais direcionamento 💚

📅 Para dar o próximo passo, clique no link abaixo e agende sua consulta:

👉 https://calendly.com/SEU_LINK_AQUI

_Se precisar, é só me chamar._ 😊`

const CAMINHO_CSV = path.join(__dirname, 'leads.csv')
const CAMINHO_ESTADO = path.join(__dirname, 'estado.json')

// ─── ESTADO GLOBAL DO BOT ────────────────────────────────────────────────────

const botState = {
  status: 'aguardando', // 'aguardando' | 'qrcode' | 'conectado'
  qrcode: null
}

// ─── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function normalizarTexto(texto = '') {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function extrairTextoMensagem(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  ).trim()
}

function formatarPerguntaComOpcoes(etapa) {
  if (!etapa.opcoes || etapa.opcoes.length === 0) return etapa.pergunta
  const lista = etapa.opcoes.map((o, i) => `${i + 1} - ${o.label}`).join('\n')
  return `${etapa.pergunta}\n\n${lista}`
}

async function enviarPergunta(sock, jid, etapa) {
  await delay(3000)
  await sock.sendMessage(jid, { text: formatarPerguntaComOpcoes(etapa) })
}

function validarNome(t) { return t.trim().length >= 2 }
function validarIdade(t) { const n = parseInt(t, 10); return !isNaN(n) && n >= 1 && n <= 120 }

function interpretarOpcao(etapa, respostaTexto) {
  if (!etapa.opcoes) return null
  const r = normalizarTexto(respostaTexto)
  const num = parseInt(r, 10)
  if (!isNaN(num) && num >= 1 && num <= etapa.opcoes.length) return etapa.opcoes[num - 1].label
  for (const o of etapa.opcoes) {
    if (r === normalizarTexto(o.label)) return o.label
    if (o.aliases?.some(a => normalizarTexto(a) === r)) return o.label
  }
  for (const o of etapa.opcoes) {
    const candidatos = [o.label, ...(o.aliases || [])]
    for (const c of candidatos) {
      const cn = normalizarTexto(c)
      if (r.includes(cn) || cn.includes(r)) return o.label
    }
  }
  return null
}

function validarResposta(etapa, texto) {
  if (etapa.campo === 'nome') return validarNome(texto)
  if (etapa.campo === 'idade') return validarIdade(texto)
  if (etapa.opcoes) return interpretarOpcao(etapa, texto) !== null
  return texto.trim().length > 0
}

function escaparCSV(v = '') { return `"${String(v).replace(/"/g, '""')}"` }
function formatarDataHora() { return new Date().toLocaleString('pt-BR') }
function extrairTelefone(jid = '') { return jid.replace('@s.whatsapp.net', '') }

function garantirArquivoCSV() {
  if (!fs.existsSync(CAMINHO_CSV)) {
    const h = ['dataHora','telefone','nome','idade','dorPrincipal','intensidade','tempoProblema','tratamentoAnterior','objetivoAtual','quimica'].join(';')
    fs.writeFileSync(CAMINHO_CSV, h + '\n', 'utf8')
  }
}

function salvarLeadCSV(jid, r) {
  garantirArquivoCSV()
  const linha = [
    escaparCSV(formatarDataHora()), escaparCSV(extrairTelefone(jid)),
    escaparCSV(r.nome), escaparCSV(r.idade), escaparCSV(r.dorPrincipal),
    escaparCSV(r.intensidade), escaparCSV(r.tempoProblema),
    escaparCSV(r.tratamentoAnterior), escaparCSV(r.objetivoAtual), escaparCSV(r.quimica)
  ].join(';')
  fs.appendFileSync(CAMINHO_CSV, linha + '\n', 'utf8')
  console.log('💾 Lead salvo.')
}

function carregarEstado() {
  try { if (fs.existsSync(CAMINHO_ESTADO)) return JSON.parse(fs.readFileSync(CAMINHO_ESTADO, 'utf8')) }
  catch (e) { console.warn('⚠️ estado.json não encontrado, iniciando vazio.') }
  return {}
}

function salvarEstado(u) {
  try { fs.writeFileSync(CAMINHO_ESTADO, JSON.stringify(u, null, 2), 'utf8') }
  catch (e) { console.error('Erro ao salvar estado:', e) }
}

function escHtml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ─── FLUXO ───────────────────────────────────────────────────────────────────

const fluxo = [
  { campo: 'nome', pergunta: '👋 Olá! Seja bem-vindo(a) à *Terapia Capilar* ✨\n\nAntes de começarmos, qual é o seu nome?' },
  { campo: 'idade', pergunta: 'Pra gente te atender da melhor forma, me conta: qual a sua idade?' },
  { campo: 'dorPrincipal', pergunta: 'Entendi. Agora me conta uma coisa 👇\n\nQual problema mais tem te incomodado no seu cabelo ultimamente?',
    opcoes: [
      { label: 'Queda de cabelo', aliases: ['queda', 'cai muito', 'cabelo caindo'] },
      { label: 'Falta de crescimento', aliases: ['nao cresce', 'crescimento', 'demora a crescer'] },
      { label: 'Ressecamento / frizz', aliases: ['ressecamento', 'frizz', 'ressecado', 'seco'] }
    ]
  },
  { campo: 'intensidade', pergunta: 'E isso tem te incomodado em qual nível?',
    opcoes: [
      { label: 'Pouco, mas quero cuidar', aliases: ['pouco', 'leve'] },
      { label: 'Médio, já está me preocupando', aliases: ['medio', 'preocupando'] },
      { label: 'Muito, está afetando minha autoestima', aliases: ['muito', 'autoestima', 'bastante'] }
    ]
  },
  { campo: 'tempoProblema', pergunta: 'Há quanto tempo você percebe esse problema?',
    opcoes: [
      { label: 'Menos de 1 mês', aliases: ['menos de 1 mes', 'recente'] },
      { label: 'De 1 a 6 meses', aliases: ['alguns meses'] },
      { label: 'Mais de 6 meses', aliases: ['muito tempo', 'faz tempo'] }
    ]
  },
  { campo: 'tratamentoAnterior', pergunta: 'Você já tentou algum tratamento antes?',
    opcoes: [
      { label: 'Sim, com profissional', aliases: ['com profissional', 'clinica'] },
      { label: 'Sim, por conta própria', aliases: ['por conta propria', 'sozinho', 'sozinha', 'em casa'] },
      { label: 'Ainda não, estou buscando ajuda agora', aliases: ['ainda nao', 'primeira vez'] }
    ]
  },
  { campo: 'objetivoAtual', pergunta: 'Hoje, o que você mais busca?',
    opcoes: [
      { label: 'Resolver o problema de vez', aliases: ['resolver', 'de vez'] },
      { label: 'Melhorar a aparência do cabelo', aliases: ['melhorar aparencia', 'aparencia'] },
      { label: 'Entender o que está acontecendo', aliases: ['entender', 'descobrir'] }
    ]
  },
  { campo: 'quimica', pergunta: 'Você faz uso de química nos fios com frequência?',
    opcoes: [
      { label: 'Sim, com frequência', aliases: ['sim', 'frequencia', 'uso quimica'] },
      { label: 'Raramente', aliases: ['raramente', 'as vezes', 'de vez em quando'] },
      { label: 'Não uso', aliases: ['nao uso', 'nunca', 'sem quimica'] }
    ]
  }
]

// ─── ESTADO ───────────────────────────────────────────────────────────────────

let usuarios = carregarEstado()

// ─── BOT ─────────────────────────────────────────────────────────────────────

async function iniciarBot() {
  garantirArquivoCSV()
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      botState.status = 'qrcode'
      botState.qrcode = await QRCode.toDataURL(qr)
      console.log('📱 QR Code disponível em: /qrcode')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      botState.status = 'aguardando'
      botState.qrcode = null
      const codigo = lastDisconnect?.error?.output?.statusCode
      const reconectar = codigo !== DisconnectReason.loggedOut
      console.log('⚠️ Conexão encerrada. Código:', codigo)
      if (reconectar) setTimeout(() => iniciarBot(), 3000)
      else console.log('🔴 Sessão encerrada. Delete auth_info e reinicie.')
    }

    if (connection === 'open') {
      botState.status = 'conectado'
      botState.qrcode = null
      console.log('✅ Bot conectado!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message || msg.key?.fromMe) return
    const jid = msg.key.remoteJid
    if (!jid || jid.endsWith('@g.us')) return
    const texto = extrairTextoMensagem(msg)
    if (!texto) return
    const tn = normalizarTexto(texto)

    try {
      if (COMANDOS_REINICIO.includes(tn)) {
        delete usuarios[jid]
        salvarEstado(usuarios)
        await sock.sendMessage(jid, { text: '🔄 Atendimento reiniciado.\n\nPara começar, envie:\n*Olá, quero conhecer a clínica.*' })
        return
      }

      if (!usuarios[jid]) {
        if (tn.includes(MENSAGEM_GATILHO)) {
          usuarios[jid] = { etapa: 0, respostas: {} }
          salvarEstado(usuarios)
          await enviarPergunta(sock, jid, fluxo[0])
        }
        return
      }

      const eu = usuarios[jid]
      const etapaAtual = fluxo[eu.etapa]
      if (!etapaAtual) return

      if (!validarResposta(etapaAtual, texto)) {
        if (etapaAtual.campo === 'idade') {
          await sock.sendMessage(jid, { text: 'Por favor, me informe sua idade usando apenas números. Ex.: *35*' })
        } else if (etapaAtual.opcoes) {
          await sock.sendMessage(jid, { text: 'Pode me responder com o número da opção ou com o texto.\n\nExemplo: *1* ou *Queda de cabelo*' })
        } else {
          await sock.sendMessage(jid, { text: 'Pode me responder novamente, por favor?' })
        }
        return
      }

      eu.respostas[etapaAtual.campo] = etapaAtual.opcoes ? interpretarOpcao(etapaAtual, texto) : texto
      eu.etapa += 1
      salvarEstado(usuarios)

      if (eu.etapa < fluxo.length) {
        const prox = fluxo[eu.etapa]
        if (prox.campo === 'idade') {
          await delay(3000)
          await sock.sendMessage(jid, { text: `Prazer, *${eu.respostas.nome}*! 😊` })
        }
        await enviarPergunta(sock, jid, prox)
      } else {
        salvarLeadCSV(jid, eu.respostas)
        console.log('🆕 Novo lead:', eu.respostas.nome, '|', extrairTelefone(jid))
        await delay(3000)
        await sock.sendMessage(jid, { text: MENSAGEM_FINAL })
        delete usuarios[jid]
        salvarEstado(usuarios)
      }
    } catch (err) {
      console.error('Erro:', err)
    }
  })
}

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────

function lerLeads() {
  if (!fs.existsSync(CAMINHO_CSV)) return []
  const linhas = fs.readFileSync(CAMINHO_CSV, 'utf8').trim().split('\n')
  if (linhas.length <= 1) return []
  const cab = linhas[0].split(';').map(c => c.replace(/"/g, '').trim())
  return linhas.slice(1).map(linha => {
    const vals = linha.match(/("([^"]|"")*"|[^;]*)/g) || []
    const obj = {}
    cab.forEach((c, i) => { obj[c] = (vals[i] || '').replace(/^"|"$/g, '').replace(/""/g, '"').trim() })
    return obj
  }).filter(l => l.nome)
}

function paginaQRCode() {
  const img = botState.qrcode
    ? `<img src="${botState.qrcode}" alt="QR Code" style="width:220px;height:220px;border-radius:12px;">`
    : `<div style="width:220px;height:220px;background:#f5f5f7;border-radius:12px;display:flex;align-items:center;justify-content:center;">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18" stroke="#aeaeb2" stroke-width="2"/>
          <path d="M20 12v4M20 24v4" stroke="#aeaeb2" stroke-width="2" stroke-linecap="round"/>
          <circle cx="20" cy="20" r="2" fill="#aeaeb2"/>
        </svg>
      </div>`

  const statusLabel = {
    aguardando: 'Aguardando QR Code…',
    qrcode: 'Escaneie com o WhatsApp',
    conectado: 'Bot conectado!'
  }[botState.status]

  const statusColor = {
    aguardando: '#ff9f0a',
    qrcode: '#0071e3',
    conectado: '#34c759'
  }[botState.status]

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${botState.status === 'conectado' ? '5;url=/' : '4'}">
<title>Conectar Bot — Terapia Capilar</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#f5f5f7;min-height:100vh;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
  .card{background:#fff;border-radius:20px;padding:40px 36px;width:340px;text-align:center;border:1px solid rgba(0,0,0,0.08);box-shadow:0 4px 24px rgba(0,0,0,0.08)}
  .brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:28px}
  .brand-icon{width:32px;height:32px;background:#1d1d1f;border-radius:8px;display:flex;align-items:center;justify-content:center}
  .brand-name{font-size:15px;font-weight:600;color:#1d1d1f}
  .qr-wrap{display:flex;align-items:center;justify-content:center;margin-bottom:24px}
  .status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};margin-right:7px;vertical-align:middle}
  .status-text{font-size:14px;font-weight:500;color:#1d1d1f;vertical-align:middle}
  .hint{font-size:12px;color:#aeaeb2;margin-top:10px;line-height:1.6}
  .success-icon{width:64px;height:64px;background:#e9f8ee;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
  .btn{display:inline-block;margin-top:20px;padding:10px 24px;background:#1d1d1f;color:#fff;border-radius:20px;font-size:13px;font-weight:500;text-decoration:none;transition:opacity .15s}
  .btn:hover{opacity:.8}
</style>
</head>
<body>
<div class="card">
  <div class="brand">
    <div class="brand-icon">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="6" r="3.5" fill="white"/>
        <path d="M2 15c0-3.866 3.134-6 7-6s7 2.134 7 6" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </div>
    <span class="brand-name">Terapia Capilar</span>
  </div>

  ${botState.status === 'conectado' ? `
  <div class="success-icon">
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M6 14l5.5 5.5L22 8" stroke="#34c759" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <div class="status-text" style="font-size:17px;font-weight:600;">Bot conectado!</div>
  <p class="hint" style="margin-top:8px;">Redirecionando para o dashboard…</p>
  <a href="/" class="btn">Ver dashboard</a>
  ` : `
  <div class="qr-wrap">${img}</div>
  <div>
    <span class="status-dot"></span>
    <span class="status-text">${statusLabel}</span>
  </div>
  <p class="hint">
    ${botState.status === 'qrcode'
      ? 'Abra o WhatsApp → Aparelhos conectados → Conectar aparelho'
      : 'O QR Code aparecerá em instantes. Esta página atualiza automaticamente.'}
  </p>
  `}
</div>
</body>
</html>`
}

function gerarDashboard(leads) {
  const total = leads.length
  const hoje = new Date().toLocaleDateString('pt-BR')
  const contagemDor = {}, contagemObj = {}
  leads.forEach(l => {
    if (l.dorPrincipal) contagemDor[l.dorPrincipal] = (contagemDor[l.dorPrincipal] || 0) + 1
    if (l.objetivoAtual) contagemObj[l.objetivoAtual] = (contagemObj[l.objetivoAtual] || 0) + 1
  })
  const dorMaisComum = Object.entries(contagemDor).sort((a,b) => b[1]-a[1])[0]?.[0] || '—'
  const objMaisComum = Object.entries(contagemObj).sort((a,b) => b[1]-a[1])[0]?.[0] || '—'

  const linhas = leads.slice().reverse().map(l => {
    // Limpa telefone legado que pode conter @lid, @s.whatsapp.net ou outros sufixos
    const tel = (l.telefone || '').replace(/@.*/g, '').replace(/[^0-9+]/g, '')
    // Se idade vier com "anos" embutido (dados legados), extrai só o número
    const idade = (l.idade || '').replace(/[^0-9]/g, '')
    return `
    <tr data-nome="${escHtml(l.nome)}" data-tel="${escHtml(tel)}" data-nome-original="${escHtml(l.nome)}" data-tel-original="${escHtml(tel)}">
      <td>
        <div class="lead-name">${escHtml(l.nome)}</div>
        <div class="lead-phone">${escHtml(tel) || '—'}</div>
      </td>
      <td><span class="badge">${escHtml(idade) || '—'} anos</span></td>
      <td>${escHtml(l.dorPrincipal) || '—'}</td>
      <td>${escHtml(l.intensidade) || '—'}</td>
      <td>${escHtml(l.tempoProblema) || '—'}</td>
      <td>${escHtml(l.tratamentoAnterior) || '—'}</td>
      <td>${escHtml(l.objetivoAtual) || '—'}</td>
      <td>${escHtml(l.quimica) || '—'}</td>
      <td class="date-cell">${escHtml(l.dataHora)}</td>
    </tr>`
  }).join('')

  const statusBot = botState.status === 'conectado'
    ? `<span class="bot-status connected"><span class="dot"></span>Bot online</span>`
    : `<a href="/qrcode" class="bot-status offline"><span class="dot"></span>Bot offline — conectar</a>`

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terapia Capilar — Leads</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#f5f5f7;--surface:#fff;--surface2:#f5f5f7;
    --border:rgba(0,0,0,.08);--border2:rgba(0,0,0,.12);
    --text:#1d1d1f;--text2:#6e6e73;--text3:#aeaeb2;
    --accent:#0071e3;--success:#34c759;--warn:#ff9f0a;
    --r-md:12px;--r-lg:16px;
    --sh-sm:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
    --sh-md:0 4px 16px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.04);
    --font:'Inter',-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;
  }
  body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
  .topbar{background:rgba(255,255,255,.85);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;padding:0 32px;height:56px;display:flex;align-items:center;justify-content:space-between}
  .topbar-brand{display:flex;align-items:center;gap:10px}
  .topbar-icon{width:28px;height:28px;background:var(--text);border-radius:7px;display:flex;align-items:center;justify-content:center}
  .topbar-title{font-size:15px;font-weight:600;letter-spacing:-.2px}
  .topbar-right{display:flex;align-items:center;gap:12px}
  .topbar-date{font-size:13px;color:var(--text2)}
  .bot-status{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;padding:5px 12px;border-radius:20px;text-decoration:none}
  .bot-status.connected{background:#e9f8ee;color:#1a7a39}
  .bot-status.offline{background:#fff3e0;color:#b35a00;border:1px solid rgba(255,159,10,.3)}
  .bot-status .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .refresh-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;background:var(--surface);border:1px solid var(--border2);border-radius:20px;font-size:13px;font-weight:500;color:var(--text);cursor:pointer;text-decoration:none;font-family:var(--font);transition:background .15s}
  .refresh-btn:hover{background:var(--surface2)}
  .page{max-width:1280px;margin:0 auto;padding:32px 32px 64px}
  .page-header{margin-bottom:32px}
  .page-header h1{font-size:28px;font-weight:600;letter-spacing:-.5px;margin-bottom:4px}
  .page-header p{font-size:15px;color:var(--text2)}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
  .metric-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:20px 22px;box-shadow:var(--sh-sm);transition:box-shadow .2s}
  .metric-card:hover{box-shadow:var(--sh-md)}
  .metric-label{font-size:12px;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
  .metric-value{font-size:32px;font-weight:600;letter-spacing:-1px;line-height:1;margin-bottom:6px}
  .metric-sub{font-size:12px;color:var(--text3)}
  .metric-card.accent{border-color:var(--accent)}.metric-card.accent .metric-value{color:var(--accent)}
  .search-wrap{position:relative;width:260px}
  .search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text3);display:flex;align-items:center}
  .search-input{width:100%;height:34px;padding:0 32px 0 34px;background:var(--surface2);border:1px solid var(--border2);border-radius:20px;font-size:13px;font-family:var(--font);color:var(--text);outline:none;transition:all .15s}
  .search-input::placeholder{color:var(--text3)}
  .search-input:focus{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,113,227,.12)}
  .search-clear{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:var(--text3);border:none;border-radius:50%;width:16px;height:16px;display:none;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .15s}
  .search-clear:hover{background:var(--text2)}.search-clear.visible{display:flex}
  .table-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--sh-sm);overflow:hidden}
  .table-header{padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
  .table-header-title{font-size:15px;font-weight:600;letter-spacing:-.2px}
  .table-count{font-size:12px;color:var(--text2);background:var(--surface2);padding:3px 10px;border-radius:20px;font-weight:500}
  .table-scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  thead th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;background:var(--surface2);border-bottom:1px solid var(--border);white-space:nowrap}
  tbody tr{border-bottom:1px solid var(--border);transition:background .1s}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:var(--surface2)}
  tbody td{padding:13px 16px;vertical-align:middle;line-height:1.4}
  .lead-name{font-weight:500;font-size:14px}
  .lead-phone{font-size:12px;color:var(--text3);margin-top:2px;font-variant-numeric:tabular-nums}
  .badge{display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:12px;font-weight:500;color:var(--text2);white-space:nowrap}
  .date-cell{color:var(--text3);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .empty-state{padding:80px 24px;text-align:center}
  .empty-icon{width:48px;height:48px;background:var(--surface2);border-radius:14px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
  .empty-state h3{font-size:17px;font-weight:600;margin-bottom:6px;letter-spacing:-.2px}
  .empty-state p{font-size:14px;color:var(--text2);max-width:280px;margin:0 auto;line-height:1.6}
  .no-results{padding:60px 24px;text-align:center;display:none}
  .no-results.visible{display:block}
  .no-results p{font-size:14px;color:var(--text2)}
  mark{background:#fff3b0;color:inherit;border-radius:2px;padding:0 1px}
  @media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}.page{padding:24px 20px 48px}.topbar{padding:0 20px}}
  @media(max-width:540px){.metrics{grid-template-columns:1fr 1fr;gap:12px}.page-header h1{font-size:22px}}
</style>
</head>
<body>
<nav class="topbar">
  <div class="topbar-brand">
    <div class="topbar-icon">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="5" r="3" fill="white"/>
        <path d="M2 13c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </div>
    <span class="topbar-title">Terapia Capilar</span>
  </div>
  <div class="topbar-right">
    ${statusBot}
    <span class="topbar-date">Atualizado em ${hoje}</span>
    <a href="/" class="refresh-btn">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M11.5 6.5A5 5 0 1 1 6.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <polyline points="8.5,1 11.5,1 11.5,4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
      Atualizar
    </a>
  </div>
</nav>

<div class="page">
  <div class="page-header">
    <h1>Leads do Chatbot</h1>
    <p>Pré-atendimentos coletados automaticamente via WhatsApp</p>
  </div>

  <div class="metrics">
    <div class="metric-card accent">
      <div class="metric-label">Total de leads</div>
      <div class="metric-value">${total}</div>
      <div class="metric-sub">pré-atendimentos concluídos</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Queixa mais comum</div>
      <div class="metric-value" style="font-size:18px;letter-spacing:-.3px;padding-top:6px">${escHtml(dorMaisComum)}</div>
      <div class="metric-sub">principal demanda</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Objetivo mais buscado</div>
      <div class="metric-value" style="font-size:15px;letter-spacing:-.2px;padding-top:10px;line-height:1.3">${escHtml(objMaisComum)}</div>
      <div class="metric-sub">entre todos os leads</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Arquivo CSV</div>
      <div class="metric-value" style="font-size:18px;letter-spacing:-.3px;padding-top:6px">leads.csv</div>
      <div class="metric-sub">atualizado em tempo real</div>
    </div>
  </div>

  <div class="table-card">
    <div class="table-header">
      <span class="table-header-title">Todos os leads</span>
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="search-wrap">
          <span class="search-icon">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/>
              <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
          </span>
          <input id="search-input" class="search-input" type="text" placeholder="Buscar por nome ou telefone…" autocomplete="off" oninput="filtrarLeads(this.value)"/>
          <button class="search-clear" id="search-clear" onclick="limparBusca()" title="Limpar">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1 1l6 6M7 1L1 7" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <span class="table-count" id="table-count">${total} ${total === 1 ? 'registro' : 'registros'}</span>
      </div>
    </div>

    ${total === 0 ? `
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <circle cx="11" cy="7" r="4" stroke="#aeaeb2" stroke-width="1.5"/>
          <path d="M3 19c0-4.418 3.582-7 8-7s8 2.582 8 7" stroke="#aeaeb2" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
      <h3>Nenhum lead ainda</h3>
      <p>Quando alguém concluir o fluxo do chatbot, aparecerá aqui automaticamente.</p>
    </div>
    ` : `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Contato</th><th>Idade</th><th>Queixa principal</th><th>Intensidade</th>
            <th>Tempo do problema</th><th>Tratamento anterior</th><th>Objetivo</th><th>Química</th><th>Data</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <div class="no-results" id="no-results">
      <p>Nenhum resultado para "<strong id="no-results-term"></strong>"</p>
    </div>
    `}
  </div>
</div>

<script>
  function normalizar(str) {
    return (str||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim()
  }
  function highlight(text,term){
    if(!term)return text
    var chars='\\^$.|?*+()[]{}'
    var escaped=term.split('').map(function(c){return chars.indexOf(c)>=0?'\\'+c:c}).join('')
    return text.replace(new RegExp('('+escaped+')','gi'),'<mark>$1</mark>')
  }
  const totalLeads=${total}
  function filtrarLeads(valor){
    const termo=normalizar(valor)
    const rows=document.querySelectorAll('tbody tr')
    const clearBtn=document.getElementById('search-clear')
    const counter=document.getElementById('table-count')
    const noResults=document.getElementById('no-results')
    const noResultsTerm=document.getElementById('no-results-term')
    clearBtn.classList.toggle('visible',valor.length>0)
    let visiveis=0
    rows.forEach(row=>{
      const nome=normalizar(row.dataset.nome)
      const tel=normalizar(row.dataset.tel)
      if(!termo||nome.includes(termo)||tel.includes(termo)){
        row.style.display=''
        if(termo){
          row.querySelector('.lead-name').innerHTML=highlight(row.dataset.nomeOriginal,valor)
          row.querySelector('.lead-phone').innerHTML=highlight(row.dataset.telOriginal,valor)
        }else{
          row.querySelector('.lead-name').innerHTML=row.dataset.nomeOriginal
          row.querySelector('.lead-phone').innerHTML=row.dataset.telOriginal
        }
        visiveis++
      }else{row.style.display='none'}
    })
    counter.textContent=termo?visiveis+' '+(visiveis===1?'resultado':'resultados'):totalLeads+' '+(totalLeads===1?'registro':'registros')
    if(noResults){noResultsTerm.textContent=valor;noResults.classList.toggle('visible',visiveis===0&&termo.length>0)}
  }
  function limparBusca(){const i=document.getElementById('search-input');i.value='';filtrarLeads('');i.focus()}
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();document.getElementById('search-input').focus()}
    if(e.key==='Escape')limparBusca()
  })
</script>
</body>
</html>`
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]

  if (url === '/qrcode') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(paginaQRCode())
  } else if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: botState.status }))
  } else if (url === '/api/leads') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(lerLeads()))
  } else if (url === '/' || url === '/leads') {
    const leads = lerLeads()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(gerarDashboard(leads))
  } else {
    res.writeHead(404)
    res.end('Not found')
  }
})

// ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando na porta ${PORT}`)
  console.log(`📊 Dashboard:  http://localhost:${PORT}`)
  console.log(`📱 QR Code:    http://localhost:${PORT}/qrcode\n`)
})

iniciarBot()
