const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const P = require('pino')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────────────────

const MENSAGEM_GATILHO = 'quero conhecer a clinica'
const COMANDOS_REINICIO = ['menu', 'reiniciar', 'comecar', 'começar']

const MENSAGEM_FINAL_AGENDAR = `✅ *Perfeito!* Já tenho tudo que preciso para o seu pré-atendimento.

Nossa terapeuta capilar vai conseguir te atender com muito mais direcionamento 💚

📅 Clique no link abaixo e escolha o melhor horário para você:

👉 https://calendly.com/SEU_LINK_AQUI

_Qualquer dúvida, é só chamar aqui._ 😊`

const MENSAGEM_FINAL_ATENDENTE = `Combinado! 😊 Vou chamar uma de nossas atendentes para tirar todas as suas dúvidas.

⏳ Em breve alguém entrará em contato com você por aqui.

_Enquanto isso, fique à vontade para dar uma olhada no nosso Instagram_ 💚`

// ─── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Simula tempo de digitação proporcional ao tamanho da mensagem
function tempoDigitacao(texto = '') {
  const base = 1500
  const porCaractere = 30
  const maximo = 4000
  return Math.min(base + texto.length * porCaractere, maximo)
}

function normalizarTexto(texto = '') {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function extrairTextoMensagem(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  ).trim()
}

function formatarPerguntaComOpcoes(etapa) {
  if (!etapa.opcoes || etapa.opcoes.length === 0) return etapa.pergunta
  const lista = etapa.opcoes.map((o, i) => `${i + 1} - ${o.label}`).join('\n')
  return `${etapa.pergunta}\n\n${lista}`
}

async function enviarMensagem(sock, jid, texto) {
  await delay(tempoDigitacao(texto))
  await sock.sendMessage(jid, { text: texto })
}

async function enviarPergunta(sock, jid, etapa) {
  await enviarMensagem(sock, jid, formatarPerguntaComOpcoes(etapa))
}

function validarNome(texto) { return String(texto).trim().length >= 2 }
function validarIdade(texto) {
  const n = parseInt(texto, 10)
  return !isNaN(n) && n >= 1 && n <= 120
}

function interpretarOpcao(etapa, respostaTexto) {
  if (!etapa.opcoes || etapa.opcoes.length === 0) return null
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
  return String(texto).trim().length > 0
}

// ─── FLUXO DE PRÉ-ATENDIMENTO ────────────────────────────────────────────────

const fluxo = [
  {
    campo: 'nome',
    pergunta: '👋 Olá! Seja bem-vindo(a) à *Clínica de Terapia Capilar* ✨\n\nAntes de começarmos, qual é o seu nome?'
  },
  {
    campo: 'idade',
    // pergunta gerada dinamicamente com o nome — veja processarMensagem()
    pergunta: 'Pra gente te atender da melhor forma, me conta: qual a sua idade?'
  },
  {
    campo: 'dorPrincipal',
    pergunta: 'Entendido! Agora me conta uma coisa 👇\n\nQual problema tem te incomodado mais no seu cabelo ultimamente?',
    opcoes: [
      { label: 'Queda de cabelo', aliases: ['queda', 'cai muito', 'cabelo caindo', 'queda capilar'] },
      { label: 'Falta de crescimento', aliases: ['nao cresce', 'crescimento', 'demora a crescer'] },
      { label: 'Ressecamento / frizz', aliases: ['ressecamento', 'frizz', 'ressecado', 'seco'] }
    ]
  },
  {
    campo: 'intensidade',
    pergunta: 'E em qual nível isso tem te incomodado?',
    opcoes: [
      { label: 'Pouco, mas quero cuidar', aliases: ['pouco', 'leve', 'quero cuidar'] },
      { label: 'Médio, já está me preocupando', aliases: ['medio', 'preocupando', 'me preocupa'] },
      { label: 'Muito, está afetando minha autoestima', aliases: ['muito', 'autoestima', 'demais', 'bastante'] }
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
      { label: 'Sim, com profissional', aliases: ['com profissional', 'clinica', 'profissional'] },
      { label: 'Sim, por conta própria', aliases: ['por conta propria', 'sozinho', 'sozinha', 'em casa'] },
      { label: 'Ainda não, estou buscando ajuda agora', aliases: ['ainda nao', 'primeira vez', 'buscando ajuda', 'nao'] }
    ]
  },
  {
    campo: 'objetivoAtual',
    pergunta: 'Hoje, o que você mais busca?',
    opcoes: [
      { label: 'Resolver o problema de vez', aliases: ['resolver', 'de vez', 'solucionar'] },
      { label: 'Melhorar a aparência do cabelo', aliases: ['melhorar aparencia', 'aparencia'] },
      { label: 'Entender o que está acontecendo', aliases: ['entender', 'descobrir', 'saber'] }
    ]
  },
  {
    campo: 'quimica',
    pergunta: 'Você usa química nos fios com frequência?',
    opcoes: [
      { label: 'Sim, com frequência', aliases: ['sim', 'frequencia', 'uso quimica', 'uso'] },
      { label: 'Raramente', aliases: ['raramente', 'as vezes', 'de vez em quando'] },
      { label: 'Não uso', aliases: ['nao uso', 'nunca', 'sem quimica', 'nao'] }
    ]
  },
  // ── BIFURCAÇÃO FINAL ──────────────────────────────────────────────────────
  {
    campo: 'proximoPasso',
    pergunta: (nome) => `Muito obrigada, *${nome}*! 🙏 Com essas informações nossa terapeuta já consegue te atender com muito mais direcionamento.\n\nComo você prefere prosseguir?`,
    opcoes: [
      { label: 'Quero agendar minha consulta agora', aliases: ['agendar', 'agendar agora', 'consulta', 'marcar'] },
      { label: 'Prefiro tirar dúvidas com uma atendente', aliases: ['duvidas', 'atendente', 'falar', 'conversar', 'tirar duvidas'] }
    ]
  }
]

// ─── PERSISTÊNCIA NO POSTGRES ─────────────────────────────────────────────────

async function buscarSessao(telefone) {
  try {
    return await prisma.session.findUnique({ where: { phone: telefone } })
  } catch {
    return null
  }
}

async function salvarSessao(telefone, dados) {
  try {
    await prisma.session.upsert({
      where: { phone: telefone },
      update: { data: dados, updatedAt: new Date() },
      create: { phone: telefone, data: dados }
    })
  } catch (e) {
    console.error('Erro ao salvar sessão:', e.message)
  }
}

async function removerSessao(telefone) {
  try {
    await prisma.session.deleteMany({ where: { phone: telefone } })
  } catch { }
}

async function salvarLeadBanco(telefone, respostas) {
  try {
    await prisma.lead.upsert({
      where: { phone: telefone },
      update: {
        nome: respostas.nome,
        idade: respostas.idade,
        dorPrincipal: respostas.dorPrincipal,
        intensidade: respostas.intensidade,
        tempoProblema: respostas.tempoProblema,
        tratamentoAnterior: respostas.tratamentoAnterior,
        objetivoAtual: respostas.objetivoAtual,
        quimica: respostas.quimica,
        proximoPasso: respostas.proximoPasso,
        updatedAt: new Date()
      },
      create: {
        phone: telefone,
        nome: respostas.nome,
        idade: respostas.idade,
        dorPrincipal: respostas.dorPrincipal,
        intensidade: respostas.intensidade,
        tempoProblema: respostas.tempoProblema,
        tratamentoAnterior: respostas.tratamentoAnterior,
        objetivoAtual: respostas.objetivoAtual,
        quimica: respostas.quimica,
        proximoPasso: respostas.proximoPasso,
        status: 'Novo'
      }
    })
    console.log('💾 Lead salvo no banco:', respostas.nome, '|', telefone)
  } catch (e) {
    console.error('Erro ao salvar lead:', e.message)
  }
}

// ─── PROCESSAMENTO DE MENSAGENS ───────────────────────────────────────────────

// Proteção contra flood: guarda último timestamp por número
const ultimaMensagem = new Map()

async function processarMensagem(sock, jid, texto) {
  const telefone = jid.replace('@s.whatsapp.net', '')
  const agora = Date.now()

  // Ignora mensagens duplicadas em menos de 2 segundos
  const ultima = ultimaMensagem.get(telefone) || 0
  if (agora - ultima < 2000) return
  ultimaMensagem.set(telefone, agora)

  const textoNorm = normalizarTexto(texto)

  // Comando de reinício
  if (COMANDOS_REINICIO.includes(textoNorm)) {
    await removerSessao(telefone)
    await enviarMensagem(sock, jid, '🔄 Atendimento reiniciado!\n\nPara começar, envie:\n*Olá, quero conhecer a clínica.*')
    return
  }

  const sessao = await buscarSessao(telefone)
  const dados = sessao?.data || null

  // Sem sessão ativa — aguarda gatilho
  if (!dados || !dados.ativo) {
    if (textoNorm.includes(MENSAGEM_GATILHO)) {
      await salvarSessao(telefone, { etapa: 0, respostas: {}, ativo: true })
      await enviarPergunta(sock, jid, fluxo[0])
    }
    return
  }

  const etapaAtual = fluxo[dados.etapa]
  if (!etapaAtual) return

  // Valida resposta
  if (!validarResposta(etapaAtual, texto)) {
    if (etapaAtual.campo === 'idade') {
      await enviarMensagem(sock, jid, 'Por favor, me informe sua idade usando apenas números. Ex.: *28*')
    } else if (etapaAtual.opcoes) {
      await enviarMensagem(sock, jid, 'Pode responder com o número da opção ou com o texto mesmo 😊\n\nEx.: *1* ou *Queda de cabelo*')
    } else {
      await enviarMensagem(sock, jid, 'Pode me responder novamente, por favor?')
    }
    return
  }

  // Interpreta resposta
  const respostaFinal = etapaAtual.opcoes
    ? interpretarOpcao(etapaAtual, texto)
    : texto.trim()

  const respostasAtualizadas = { ...(dados.respostas || {}), [etapaAtual.campo]: respostaFinal }
  const novaEtapa = dados.etapa + 1

  // Mensagem especial ao registrar o nome
  if (etapaAtual.campo === 'nome') {
    const primeiroNome = respostaFinal.split(' ')[0]
    await delay(1000)
    await enviarMensagem(sock, jid, `Prazer, *${primeiroNome}*! 😊`)
  }

  // Fim do fluxo
  if (novaEtapa >= fluxo.length) {
    await salvarSessao(telefone, { etapa: novaEtapa, respostas: respostasAtualizadas, ativo: false })
    await salvarLeadBanco(telefone, respostasAtualizadas)

    console.log('\n===== NOVO LEAD =====')
    console.log('WhatsApp:', telefone)
    console.log('Respostas:', respostasAtualizadas)
    console.log('Próximo passo:', respostaFinal)
    console.log('=====================\n')

    // Bifurcação baseada na escolha final
    if (respostaFinal === 'Quero agendar minha consulta agora') {
      await enviarMensagem(sock, jid, MENSAGEM_FINAL_AGENDAR)
    } else {
      await enviarMensagem(sock, jid, MENSAGEM_FINAL_ATENDENTE)
    }

    await removerSessao(telefone)
    return
  }

  // Avança para próxima etapa
  await salvarSessao(telefone, { etapa: novaEtapa, respostas: respostasAtualizadas, ativo: true })

  const proximaEtapa = fluxo[novaEtapa]

  // Pergunta da bifurcação final usa o nome
  if (proximaEtapa.campo === 'proximoPasso') {
    const nome = respostasAtualizadas.nome?.split(' ')[0] || ''
    const pergunta = typeof proximaEtapa.pergunta === 'function'
      ? proximaEtapa.pergunta(nome)
      : proximaEtapa.pergunta
    const lista = proximaEtapa.opcoes.map((o, i) => `${i + 1} - ${o.label}`).join('\n')
    await enviarMensagem(sock, jid, `${pergunta}\n\n${lista}`)
    return
  }

  await enviarPergunta(sock, jid, proximaEtapa)
}

// ─── BOT PRINCIPAL ────────────────────────────────────────────────────────────

let tentativasReconexao = 0

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR Code abaixo com seu WhatsApp:\n')
      qrcode.generate(qr, { small: true })
      console.log('\n')
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode
      const deveReconectar = codigo !== DisconnectReason.loggedOut

      console.log('⚠️ Conexão encerrada. Código:', codigo)

      if (deveReconectar) {
        // Backoff exponencial: 3s, 6s, 12s, máx 30s
        tentativasReconexao++
        const espera = Math.min(3000 * Math.pow(2, tentativasReconexao - 1), 30000)
        console.log(`🔄 Reconectando em ${espera / 1000}s... (tentativa ${tentativasReconexao})`)
        setTimeout(() => iniciarBot(), espera)
      } else {
        console.log('🔴 Sessão encerrada pelo WhatsApp. Delete a pasta auth_info e reinicie.')
        process.exit(1)
      }
    }

    if (connection === 'open') {
      tentativasReconexao = 0
      console.log('✅ Bot conectado ao WhatsApp com sucesso!')
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

    try {
      await processarMensagem(sock, jid, texto)
    } catch (err) {
      console.error('Erro ao processar mensagem:', err.message)
    }
  })
}

iniciarBot()
