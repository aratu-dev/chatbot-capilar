const http = require('http')
const https = require('https')

const {
  buscarSessao,
  criarOuAtualizarSessao,
  atualizarSessao,
  removerSessao,
  salvarLead,
  atualizarStatusLead,
  listarLeads
} = require('./services/database')

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────────────────

const MENSAGEM_GATILHO = 'quero conhecer a clinica'
const COMANDOS_REINICIO = ['menu', 'reiniciar', 'comecar', 'começar']
const PORT = process.env.PORT || 3000

// Evolution API — configure estas variáveis no Railway
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL         // Ex: https://evolution.seudominio.com
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY         // Chave gerada na Evolution API
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE       // Nome da instância criada (ex: "terapia-capilar")

// Token de segurança para verificar que o webhook veio da Evolution API
const EVOLUTION_WEBHOOK_TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN || ''

const MENSAGEM_FINAL = `✅ *Perfeito!* Já tenho informações suficientes para o seu pré-atendimento.

Nossa terapeuta capilar vai conseguir te atender com mais direcionamento 💚

📅 Para dar o próximo passo, clique no link abaixo e agende sua consulta:

👉 https://calendly.com/SEU_LINK_AQUI

_Se precisar, é só me chamar._ 😊`

// Proteção contra mensagens duplicadas (Evolution pode reenviar o webhook)
// Guarda os últimos 500 IDs de mensagens processadas em memória
const mensagensProcessadas = new Set()
const MAX_IDS_CACHE = 500

const botState = { status: 'evolution_api' }

// ─── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function normalizarTexto(texto = '') {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function validarNome(t) {
  return String(t).trim().length >= 2
}

function validarIdade(t) {
  const n = parseInt(t, 10)
  return !isNaN(n) && n >= 1 && n <= 120
}

function interpretarOpcao(etapa, respostaTexto) {
  if (!etapa.opcoes) return null

  const r = normalizarTexto(respostaTexto)
  const num = parseInt(r, 10)

  if (!isNaN(num) && num >= 1 && num <= etapa.opcoes.length) {
    return etapa.opcoes[num - 1].label
  }

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
  return String(texto).trim().length > 0
}

function formatarPerguntaComOpcoes(etapa) {
  if (!etapa.opcoes || etapa.opcoes.length === 0) return etapa.pergunta
  const lista = etapa.opcoes.map((o, i) => `${i + 1} - ${o.label}`).join('\n')
  return `${etapa.pergunta}\n\n${lista}`
}

function escHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatarData(data) {
  if (!data) return '-'
  return new Date(data).toLocaleString('pt-BR')
}

function contarPorStatus(leads) {
  const t = { total: leads.length, novo: 0, contatoFeito: 0, agendado: 0 }
  for (const lead of leads) {
    const s = lead.status || 'Novo'
    if (s === 'Novo') t.novo++
    if (s === 'Contato feito') t.contatoFeito++
    if (s === 'Agendado') t.agendado++
  }
  return t
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => { resolve(body) })
    req.on('error', reject)
  })
}

function parseFormBody(rawBody = '') {
  const params = {}
  rawBody.split('&').forEach(pair => {
    const [k, v] = pair.split('=')
    if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '))
  })
  return params
}

function parseQuery(url) {
  const params = {}
  const qs = url.split('?')[1] || ''
  qs.split('&').forEach(pair => {
    const [k, v] = pair.split('=')
    if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '))
  })
  return params
}

function responderJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function responderTexto(res, statusCode, texto) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(texto)
}

// ─── EVOLUTION API — ENVIO ────────────────────────────────────────────────────

async function enviarMensagemWhatsApp(numero, texto) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
    throw new Error('Variáveis EVOLUTION_API_URL, EVOLUTION_API_KEY ou EVOLUTION_INSTANCE não configuradas.')
  }

  // A Evolution API espera o número no formato internacional sem + e sem @
  // Ex: 5521999999999
  const numeroLimpo = String(numero).replace(/\D/g, '')

  const body = JSON.stringify({
    number: numeroLimpo,
    text: texto
  })

  const urlCompleta = new URL(`/message/sendText/${EVOLUTION_INSTANCE}`, EVOLUTION_API_URL)

  const options = {
    hostname: urlCompleta.hostname,
    port: urlCompleta.port || (urlCompleta.protocol === 'https:' ? 443 : 80),
    path: urlCompleta.pathname,
    method: 'POST',
    headers: {
      'apikey': EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }

  const lib = urlCompleta.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (apiRes) => {
      let data = ''
      apiRes.on('data', chunk => { data += chunk })
      apiRes.on('end', () => {
        if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
          resolve(data)
        } else {
          reject(new Error(`Erro ${apiRes.statusCode}: ${data}`))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function enviarPergunta(numero, etapa) {
  await delay(2000)
  await enviarMensagemWhatsApp(numero, formatarPerguntaComOpcoes(etapa))
}

// ─── EVOLUTION API — RECEBIMENTO ──────────────────────────────────────────────

/**
 * A Evolution API envia webhooks com este formato:
 * {
 *   event: "messages.upsert",
 *   instance: "nome-da-instancia",
 *   data: {
 *     key: { remoteJid: "5521999999999@s.whatsapp.net", fromMe: false, id: "MSG_ID" },
 *     message: { conversation: "texto aqui" },
 *     messageType: "conversation"
 *   }
 * }
 */
function extrairEventosEvolution(payload) {
  const eventos = []

  // Ignora eventos que não são de mensagem recebida
  const eventosAceitos = ['messages.upsert', 'MESSAGES_UPSERT']
  if (!eventosAceitos.includes(payload?.event)) return eventos

  const data = payload?.data

  // A Evolution API pode enviar um array ou um objeto único em data
  const mensagens = Array.isArray(data) ? data : [data]

  for (const msg of mensagens) {
    if (!msg) continue

    const key = msg.key || {}

    // Ignora mensagens enviadas pelo próprio bot
    if (key.fromMe) continue

    // Ignora grupos
    const remoteJid = key.remoteJid || ''
    if (remoteJid.endsWith('@g.us')) continue

    const messageId = key.id || null

    // Extrai o número limpo (remove @s.whatsapp.net)
    const from = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '')
    if (!from) continue

    // Extrai o texto da mensagem (vários tipos possíveis)
    const message = msg.message || {}
    const texto = (
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      msg.body ||  // fallback para alguns formatos alternativos
      ''
    ).trim()

    if (!texto) continue

    eventos.push({ from, texto, messageId })
  }

  return eventos
}

// ─── LÓGICA DO FLUXO ─────────────────────────────────────────────────────────

async function processarMensagemWhatsApp(numero, texto) {
  const tn = normalizarTexto(texto)

  if (COMANDOS_REINICIO.includes(tn)) {
    await removerSessao(numero)
    await enviarMensagemWhatsApp(
      numero,
      '🔄 Atendimento reiniciado.\n\nPara começar, envie:\n*Olá, quero conhecer a clínica.*'
    )
    return
  }

  let sessao = await buscarSessao(numero)

  if (!sessao || !sessao.ativo) {
    if (tn.includes(MENSAGEM_GATILHO)) {
      await criarOuAtualizarSessao(numero, { etapa: 0, respostas: {}, ativo: true })
      await enviarPergunta(numero, fluxo[0])
    }
    return
  }

  const etapaAtual = fluxo[sessao.etapa]
  if (!etapaAtual) return

  if (!validarResposta(etapaAtual, texto)) {
    if (etapaAtual.campo === 'idade') {
      await enviarMensagemWhatsApp(numero, 'Por favor, me informe sua idade usando apenas números. Ex.: *35*')
    } else if (etapaAtual.opcoes) {
      await enviarMensagemWhatsApp(numero, 'Pode me responder com o número da opção ou com o texto.\n\nExemplo: *1* ou *Queda de cabelo*')
    } else {
      await enviarMensagemWhatsApp(numero, 'Pode me responder novamente, por favor?')
    }
    return
  }

  const respostaFinal = etapaAtual.opcoes
    ? interpretarOpcao(etapaAtual, texto)
    : texto

  const respostasAtualizadas = { ...(sessao.respostas || {}), [etapaAtual.campo]: respostaFinal }
  const novaEtapa = sessao.etapa + 1

  await atualizarSessao(numero, {
    etapa: novaEtapa,
    respostas: respostasAtualizadas,
    ativo: novaEtapa < fluxo.length
  })

  if (novaEtapa < fluxo.length) {
    const prox = fluxo[novaEtapa]
    if (prox.campo === 'idade') {
      await delay(2000)
      await enviarMensagemWhatsApp(numero, `Prazer, *${respostasAtualizadas.nome}*! 😊`)
    }
    await enviarPergunta(numero, prox)
  } else {
    await salvarLead(numero, numero, respostasAtualizadas)
    console.log('🆕 Novo lead:', respostasAtualizadas.nome, '|', numero)
    await delay(2000)
    await enviarMensagemWhatsApp(numero, MENSAGEM_FINAL)
    await removerSessao(numero)
  }
}

// ─── FLUXO DE PERGUNTAS ───────────────────────────────────────────────────────

const fluxo = [
  {
    campo: 'nome',
    pergunta: '👋 Olá! Seja bem-vindo(a) à *Terapia Capilar* ✨\n\nAntes de começarmos, qual é o seu nome?'
  },
  {
    campo: 'idade',
    pergunta: 'Pra gente te atender da melhor forma, me conta: qual a sua idade?'
  },
  {
    campo: 'dorPrincipal',
    pergunta: 'Entendi. Agora me conta uma coisa 👇\n\nQual problema mais tem te incomodado no seu cabelo ultimamente?',
    opcoes: [
      { label: 'Queda de cabelo', aliases: ['queda', 'cai muito', 'cabelo caindo', 'queda capilar'] },
      { label: 'Falta de crescimento', aliases: ['nao cresce', 'crescimento', 'demora a crescer'] },
      { label: 'Ressecamento / frizz', aliases: ['ressecamento', 'frizz', 'ressecado', 'seco'] }
    ]
  },
  {
    campo: 'intensidade',
    pergunta: 'E isso tem te incomodado em qual nível?',
    opcoes: [
      { label: 'Pouco, mas quero cuidar', aliases: ['pouco', 'leve'] },
      { label: 'Médio, já está me preocupando', aliases: ['medio', 'preocupando', 'me preocupa'] },
      { label: 'Muito, está afetando minha autoestima', aliases: ['muito', 'autoestima', 'bastante'] }
    ]
  },
  {
    campo: 'tempoProblema',
    pergunta: 'Há quanto tempo você percebe esse problema?',
    opcoes: [
      { label: 'Menos de 1 mês', aliases: ['menos de 1 mes', 'menos de um mes', 'recente'] },
      { label: 'De 1 a 6 meses', aliases: ['1 a 6 meses', 'alguns meses'] },
      { label: 'Mais de 6 meses', aliases: ['mais de 6 meses', 'muito tempo', 'faz tempo'] }
    ]
  },
  {
    campo: 'tratamentoAnterior',
    pergunta: 'Você já tentou algum tratamento antes?',
    opcoes: [
      { label: 'Sim, com profissional', aliases: ['com profissional', 'clinica'] },
      { label: 'Sim, por conta própria', aliases: ['por conta propria', 'sozinho', 'sozinha', 'em casa'] },
      { label: 'Ainda não, estou buscando ajuda agora', aliases: ['ainda nao', 'primeira vez', 'buscando ajuda'] }
    ]
  },
  {
    campo: 'objetivoAtual',
    pergunta: 'Hoje, o que você mais busca?',
    opcoes: [
      { label: 'Resolver o problema de vez', aliases: ['resolver', 'de vez', 'solucionar'] },
      { label: 'Melhorar a aparência do cabelo', aliases: ['melhorar aparencia', 'aparencia'] },
      { label: 'Entender o que está acontecendo', aliases: ['entender', 'descobrir'] }
    ]
  },
  {
    campo: 'quimica',
    pergunta: 'Você faz uso de química nos fios com frequência?',
    opcoes: [
      { label: 'Sim, com frequência', aliases: ['sim', 'frequencia', 'uso quimica'] },
      { label: 'Raramente', aliases: ['raramente', 'as vezes', 'de vez em quando'] },
      { label: 'Não uso', aliases: ['nao uso', 'nunca', 'sem quimica'] }
    ]
  }
]

// ─── PÁGINAS HTML ─────────────────────────────────────────────────────────────

function gerarDashboard(leads, busca) {
  const termo = (busca || '').trim().toLowerCase()
  const leadsFiltrados = termo
    ? leads.filter(l =>
        [l.nome, l.phone, l.idade, l.dorPrincipal, l.objetivoAtual, formatarData(l.createdAt)]
          .join(' ').toLowerCase().includes(termo)
      )
    : leads

  const totais = contarPorStatus(leadsFiltrados)
  const hoje = new Date().toLocaleDateString('pt-BR')

  const contagemDor = {}
  const contagemObj = {}
  leads.forEach(l => {
    if (l.dorPrincipal) contagemDor[l.dorPrincipal] = (contagemDor[l.dorPrincipal] || 0) + 1
    if (l.objetivoAtual) contagemObj[l.objetivoAtual] = (contagemObj[l.objetivoAtual] || 0) + 1
  })

  const dorMaisComum = Object.entries(contagemDor).sort((a, b) => b[1] - a[1])[0]?.[0] || '—'
  const objMaisComum = Object.entries(contagemObj).sort((a, b) => b[1] - a[1])[0]?.[0] || '—'

  const linhas = leadsFiltrados.map(l => {
    const statusAtual = l.status || 'Novo'
    const classeStatus =
      statusAtual === 'Agendado' ? 'status-agendado'
      : statusAtual === 'Contato feito' ? 'status-contato'
      : 'status-novo'

    return `
    <tr>
      <td>
        <div class="lead-name">${escHtml(l.nome || '-')}</div>
        <div class="lead-phone">${escHtml(l.phone || '-')}</div>
      </td>
      <td><span class="badge">${escHtml(l.idade || '-')} anos</span></td>
      <td>${escHtml(l.dorPrincipal || '-')}</td>
      <td>${escHtml(l.intensidade || '-')}</td>
      <td>${escHtml(l.objetivoAtual || '-')}</td>
      <td>
        <form method="POST" action="/status">
          <input type="hidden" name="phone" value="${escHtml(l.phone || '')}"/>
          <input type="hidden" name="busca" value="${escHtml(busca || '')}"/>
          <select name="status" class="select-status ${classeStatus}" onchange="this.form.submit()">
            <option value="Novo" ${statusAtual === 'Novo' ? 'selected' : ''}>Novo</option>
            <option value="Contato feito" ${statusAtual === 'Contato feito' ? 'selected' : ''}>Contato feito</option>
            <option value="Agendado" ${statusAtual === 'Agendado' ? 'selected' : ''}>Agendado</option>
          </select>
        </form>
      </td>
      <td>
        <details>
          <summary>Ver mais</summary>
          <div class="detalhes">
            <p><strong>Tempo:</strong> ${escHtml(l.tempoProblema || '-')}</p>
            <p><strong>Tratamento anterior:</strong> ${escHtml(l.tratamentoAnterior || '-')}</p>
            <p><strong>Química:</strong> ${escHtml(l.quimica || '-')}</p>
            <p><strong>Data:</strong> ${escHtml(formatarData(l.createdAt))}</p>
          </div>
        </details>
      </td>
    </tr>`
  }).join('')

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
    --accent:#0071e3;
    --r-md:12px;--r-lg:16px;
    --sh-sm:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
    --sh-md:0 4px 16px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.04);
    --font:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  }
  body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
  .topbar{background:rgba(255,255,255,.85);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;padding:0 32px;height:56px;display:flex;align-items:center;justify-content:space-between}
  .topbar-brand{display:flex;align-items:center;gap:10px}
  .topbar-icon{width:28px;height:28px;background:var(--text);border-radius:7px;display:flex;align-items:center;justify-content:center}
  .topbar-title{font-size:15px;font-weight:600;letter-spacing:-.2px}
  .topbar-right{display:flex;align-items:center;gap:12px}
  .topbar-date{font-size:13px;color:var(--text2)}
  .bot-status{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;padding:5px 12px;border-radius:20px;background:#e9f8ee;color:#1a7a39}
  .bot-status .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .refresh-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;background:var(--surface);border:1px solid var(--border2);border-radius:20px;font-size:13px;font-weight:500;color:var(--text);text-decoration:none;transition:background .15s}
  .refresh-btn:hover{background:var(--surface2)}
  .page{max-width:1280px;margin:0 auto;padding:32px 32px 64px}
  .page-header{margin-bottom:32px}
  .page-header h1{font-size:28px;font-weight:600;letter-spacing:-.5px;margin-bottom:4px}
  .page-header p{font-size:15px;color:var(--text2)}
  .metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;margin-bottom:32px}
  .metric-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:20px 22px;box-shadow:var(--sh-sm);transition:box-shadow .2s}
  .metric-card:hover{box-shadow:var(--sh-md)}
  .metric-label{font-size:12px;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
  .metric-value{font-size:32px;font-weight:600;letter-spacing:-1px;line-height:1;margin-bottom:6px}
  .metric-sub{font-size:12px;color:var(--text3)}
  .metric-card.accent{border-color:var(--accent)}.metric-card.accent .metric-value{color:var(--accent)}
  .busca-form{display:flex;gap:8px;margin-bottom:24px}
  .busca-input{flex:1;max-width:360px;padding:10px 16px;border:1px solid var(--border2);border-radius:20px;font-size:14px;font-family:var(--font);background:var(--surface);color:var(--text);outline:none;transition:border-color .15s}
  .busca-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,113,227,.12)}
  .busca-btn{padding:10px 20px;background:var(--text);color:#fff;border:none;border-radius:20px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--font)}
  .busca-limpar{padding:10px 16px;background:var(--surface2);color:var(--text2);border:1px solid var(--border2);border-radius:20px;font-size:13px;font-weight:500;text-decoration:none;display:inline-flex;align-items:center}
  .table-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--sh-sm);overflow:hidden}
  .table-header{padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
  .table-header-title{font-size:15px;font-weight:600;letter-spacing:-.2px}
  .table-count{font-size:12px;color:var(--text2);background:var(--surface2);padding:3px 10px;border-radius:20px;font-weight:500}
  .table-scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:900px}
  thead th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;background:var(--surface2);border-bottom:1px solid var(--border);white-space:nowrap}
  tbody tr{border-bottom:1px solid var(--border);transition:background .1s}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:var(--surface2)}
  tbody td{padding:13px 16px;vertical-align:middle;line-height:1.4}
  .lead-name{font-weight:500;font-size:14px}
  .lead-phone{font-size:12px;color:var(--text3);margin-top:2px}
  .badge{display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:12px;font-weight:500;color:var(--text2)}
  .select-status{border:none;border-radius:999px;padding:7px 14px;font-weight:600;font-size:12px;outline:none;cursor:pointer;font-family:var(--font)}
  .status-novo{background:#fef3c7;color:#92400e}
  .status-contato{background:#dbeafe;color:#1d4ed8}
  .status-agendado{background:#dcfce7;color:#166534}
  details summary{cursor:pointer;font-size:13px;font-weight:500;color:var(--accent)}
  .detalhes{margin-top:10px;font-size:13px;color:var(--text2);line-height:1.8}
  .empty-state{padding:80px 24px;text-align:center}
  .empty-state h3{font-size:17px;font-weight:600;margin-bottom:6px}
  .empty-state p{font-size:14px;color:var(--text2);max-width:280px;margin:0 auto;line-height:1.6}
  @media(max-width:1100px){.metrics{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:900px){.page{padding:24px 20px 48px}.topbar{padding:0 20px}}
  @media(max-width:540px){.metrics{grid-template-columns:1fr 1fr;gap:12px}.page-header h1{font-size:22px}}
</style>
</head>
<body>
<nav class="topbar">
  <div class="topbar-brand">
    <div class="topbar-icon">
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="6" r="3.5" fill="white"/>
        <path d="M2 15c0-3.866 3.134-6 7-6s7 2.134 7 6" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </div>
    <span class="topbar-title">Terapia Capilar</span>
  </div>
  <div class="topbar-right">
    <span class="topbar-date">${hoje}</span>
    <span class="bot-status"><span class="dot"></span>Evolution API ativa</span>
    <a href="/" class="refresh-btn">Atualizar</a>
  </div>
</nav>

<div class="page">
  <div class="page-header">
    <h1>Dashboard de Leads</h1>
    <p>Acompanhe os pré-atendimentos em tempo real.</p>
  </div>

  <div class="metrics">
    <div class="metric-card accent">
      <div class="metric-label">Total de leads</div>
      <div class="metric-value">${totais.total}</div>
      <div class="metric-sub">captados até agora</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Queixa mais comum</div>
      <div class="metric-value" style="font-size:20px;line-height:1.2">${escHtml(dorMaisComum)}</div>
      <div class="metric-sub">mais recorrente</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Objetivo principal</div>
      <div class="metric-value" style="font-size:20px;line-height:1.2">${escHtml(objMaisComum)}</div>
      <div class="metric-sub">mais buscado</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Novos leads</div>
      <div class="metric-value" style="color:#92400e">${totais.novo}</div>
      <div class="metric-sub">aguardando contato</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Contato feito</div>
      <div class="metric-value" style="color:#1d4ed8">${totais.contatoFeito}</div>
      <div class="metric-sub">em andamento</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Agendados</div>
      <div class="metric-value" style="color:#166534">${totais.agendado}</div>
      <div class="metric-sub">consulta marcada</div>
    </div>
  </div>

  <form class="busca-form" method="GET" action="/">
    <input class="busca-input" type="text" name="busca" placeholder="Buscar por nome, telefone, dor…" value="${escHtml(busca || '')}"/>
    <button class="busca-btn" type="submit">Buscar</button>
    ${busca ? `<a class="busca-limpar" href="/">Limpar</a>` : ''}
  </form>

  <div class="table-card">
    <div class="table-header">
      <span class="table-header-title">Todos os leads</span>
      <span class="table-count">${leadsFiltrados.length} ${leadsFiltrados.length === 1 ? 'registro' : 'registros'}</span>
    </div>
    ${leadsFiltrados.length === 0 ? `
    <div class="empty-state">
      <h3>${busca ? 'Nenhum resultado encontrado' : 'Nenhum lead ainda'}</h3>
      <p>${busca ? `Nenhum lead encontrado para "${escHtml(busca)}".` : 'Quando alguém concluir o fluxo do chatbot, aparecerá aqui automaticamente.'}</p>
    </div>` : `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Contato</th><th>Idade</th><th>Queixa principal</th>
            <th>Intensidade</th><th>Objetivo</th><th>Status</th><th>Detalhes</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`}
  </div>
</div>
</body>
</html>`
}

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0]
  const query = parseQuery(req.url)

  try {
    if (urlPath === '/ping') {
      responderTexto(res, 200, 'ok')
      return
    }

    // ── WEBHOOK DA EVOLUTION API ──────────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/webhook') {
      // Responde 200 imediatamente para a Evolution API não reenviar
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))

      // Processa em background sem bloquear a resposta
      setImmediate(async () => {
        try {
          const rawBody = await parseBody(req).catch(() => '{}')
          let payload = {}

          try { payload = rawBody ? JSON.parse(rawBody) : {} } catch { return }

          // Verificação opcional de token de segurança
          // A Evolution API pode enviar um header customizado configurado por você
          if (EVOLUTION_WEBHOOK_TOKEN) {
            const tokenRecebido = req.headers['apikey'] || req.headers['x-webhook-token'] || ''
            if (tokenRecebido !== EVOLUTION_WEBHOOK_TOKEN) {
              console.warn('⚠️ Webhook recebido com token inválido, ignorando.')
              return
            }
          }

          const eventos = extrairEventosEvolution(payload)

          for (const evento of eventos) {
            // Deduplicação: ignora mensagem que já foi processada
            if (evento.messageId) {
              if (mensagensProcessadas.has(evento.messageId)) {
                console.log('⏭️ Mensagem duplicada ignorada:', evento.messageId)
                continue
              }
              mensagensProcessadas.add(evento.messageId)

              // Limpa o cache se ficar grande demais
              if (mensagensProcessadas.size > MAX_IDS_CACHE) {
                const [primeiro] = mensagensProcessadas
                mensagensProcessadas.delete(primeiro)
              }
            }

            await processarMensagemWhatsApp(evento.from, evento.texto)
          }
        } catch (err) {
          console.error('Erro ao processar webhook Evolution:', err)
        }
      })

      return
    }

    // ── ROTA DE TESTE DE ENVIO ────────────────────────────────────────────────
    if (req.method === 'GET' && urlPath === '/teste-envio') {
      const numero = query.numero
      if (!numero) {
        responderTexto(res, 400, 'Informe ?numero=55DDDNUMERO')
        return
      }
      const resultado = await enviarMensagemWhatsApp(numero, 'Teste enviado pela Evolution API 🚀')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(resultado)
      return
    }

    // ── ATUALIZAÇÃO DE STATUS DO LEAD ─────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/status') {
      const rawBody = await parseBody(req)
      const body = parseFormBody(rawBody)
      const { phone, status, busca = '' } = body
      const permitidos = ['Novo', 'Contato feito', 'Agendado']
      if (phone && status && permitidos.includes(status)) {
        await atualizarStatusLead(phone, status)
      }
      const qs = busca ? `?busca=${encodeURIComponent(busca)}` : ''
      res.writeHead(302, { Location: '/' + qs })
      res.end()
      return
    }

    // ── APIs JSON ─────────────────────────────────────────────────────────────
    if (urlPath === '/api/status') {
      responderJson(res, 200, { status: botState.status })
      return
    }

    if (urlPath === '/api/leads') {
      const leads = await listarLeads()
      responderJson(res, 200, leads)
      return
    }

    // ── DASHBOARD ─────────────────────────────────────────────────────────────
    if (urlPath === '/' || urlPath === '/leads') {
      const leads = await listarLeads()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(gerarDashboard(leads, query.busca || ''))
      return
    }

    responderTexto(res, 404, 'Not found')
  } catch (error) {
    console.error('Erro no servidor:', error)
    responderTexto(res, 500, error.message || 'Erro interno')
  }
})

server.on('request', (req) => {
  console.log(`→ ${req.method} ${req.url}`)
})

server.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando na porta ${PORT}`)
  console.log(`📊 Dashboard:       http://localhost:${PORT}`)
  console.log(`📩 Webhook:         http://localhost:${PORT}/webhook`)
  console.log(`🧪 Teste de envio:  http://localhost:${PORT}/teste-envio?numero=55DDDNUMERO\n`)
})
