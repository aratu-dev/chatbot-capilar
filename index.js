const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const P = require('pino')
const fs = require('fs')
const path = require('path')

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────────────────

// ✅ CORRIGIDO: sem acento e sem ponto final para comparação flexível
const MENSAGEM_GATILHO = 'quero conhecer a clinica'
const COMANDOS_REINICIO = ['menu', 'reiniciar', 'comecar', 'começar']

const MENSAGEM_FINAL = `✅ *Perfeito!* Já tenho informações suficientes para o seu pré-atendimento.

Nossa terapeuta capilar vai conseguir te atender com mais direcionamento 💚

📅 Para dar o próximo passo, clique no link abaixo e agende sua consulta:

👉 https://calendly.com/SEU_LINK_AQUI

_Se precisar, é só me chamar._ 😊`

const CAMINHO_CSV = path.join(__dirname, 'leads.csv')
const CAMINHO_ESTADO = path.join(__dirname, 'estado.json')

// ─── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function normalizarTexto(texto = '') {
  return texto
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
    ''
  ).trim()
}

function formatarPerguntaComOpcoes(etapa) {
  if (!etapa.opcoes || etapa.opcoes.length === 0) {
    return etapa.pergunta
  }

  const lista = etapa.opcoes
    .map((opcao, index) => `${index + 1} - ${opcao.label}`)
    .join('\n')

  return `${etapa.pergunta}\n\n${lista}`
}

async function enviarPergunta(sock, jid, etapa) {
  await delay(3000)
  await sock.sendMessage(jid, { text: formatarPerguntaComOpcoes(etapa) })
}

function validarNome(texto) {
  return texto.trim().length >= 2
}

function validarIdade(texto) {
  const idade = parseInt(texto, 10)
  return !isNaN(idade) && idade >= 1 && idade <= 120
}

function interpretarOpcao(etapa, respostaTexto) {
  if (!etapa.opcoes || etapa.opcoes.length === 0) return null

  const respostaNormalizada = normalizarTexto(respostaTexto)

  // 1) Número da opção
  const numero = parseInt(respostaNormalizada, 10)
  if (!isNaN(numero) && numero >= 1 && numero <= etapa.opcoes.length) {
    return etapa.opcoes[numero - 1].label
  }

  // 2) Label exato ou alias exato
  for (const opcao of etapa.opcoes) {
    const labelNormalizado = normalizarTexto(opcao.label)
    if (respostaNormalizada === labelNormalizado) return opcao.label
    if (opcao.aliases?.some(alias => normalizarTexto(alias) === respostaNormalizada)) {
      return opcao.label
    }
  }

  // 3) Correspondência parcial
  for (const opcao of etapa.opcoes) {
    const candidatos = [opcao.label, ...(opcao.aliases || [])]
    for (const candidato of candidatos) {
      const candNorm = normalizarTexto(candidato)
      if (respostaNormalizada.includes(candNorm) || candNorm.includes(respostaNormalizada)) {
        return opcao.label
      }
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

function escaparCSV(valor = '') {
  const texto = String(valor).replace(/"/g, '""')
  return `"${texto}"`
}

function formatarDataHora() {
  return new Date().toLocaleString('pt-BR')
}

function extrairTelefone(jid = '') {
  return jid.replace('@s.whatsapp.net', '')
}

function garantirArquivoCSV() {
  if (!fs.existsSync(CAMINHO_CSV)) {
    const cabecalho = [
      'dataHora', 'telefone', 'nome', 'idade',
      'dorPrincipal', 'intensidade', 'tempoProblema',
      'tratamentoAnterior', 'objetivoAtual', 'quimica'
    ].join(';')
    fs.writeFileSync(CAMINHO_CSV, cabecalho + '\n', 'utf8')
    console.log('📄 Arquivo leads.csv criado.')
  }
}

function salvarLeadCSV(jid, respostas) {
  garantirArquivoCSV()
  const linha = [
    escaparCSV(formatarDataHora()),
    escaparCSV(extrairTelefone(jid)),
    escaparCSV(respostas.nome || ''),
    escaparCSV(respostas.idade || ''),
    escaparCSV(respostas.dorPrincipal || ''),
    escaparCSV(respostas.intensidade || ''),
    escaparCSV(respostas.tempoProblema || ''),
    escaparCSV(respostas.tratamentoAnterior || ''),
    escaparCSV(respostas.objetivoAtual || ''),
    escaparCSV(respostas.quimica || '')
  ].join(';')
  fs.appendFileSync(CAMINHO_CSV, linha + '\n', 'utf8')
  console.log('💾 Lead salvo no CSV.')
}

// ✅ NOVO: persiste o estado dos usuários em disco
function carregarEstado() {
  try {
    if (fs.existsSync(CAMINHO_ESTADO)) {
      return JSON.parse(fs.readFileSync(CAMINHO_ESTADO, 'utf8'))
    }
  } catch (e) {
    console.warn('⚠️ Não foi possível carregar estado.json, iniciando vazio.')
  }
  return {}
}

function salvarEstado(usuarios) {
  try {
    fs.writeFileSync(CAMINHO_ESTADO, JSON.stringify(usuarios, null, 2), 'utf8')
  } catch (e) {
    console.error('Erro ao salvar estado:', e)
  }
}

// ─── FLUXO DE PRÉ-ATENDIMENTO ────────────────────────────────────────────────

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
      { label: 'Falta de crescimento', aliases: ['nao cresce', 'nao cresce', 'crescimento', 'demora a crescer'] },
      { label: 'Ressecamento / frizz', aliases: ['ressecamento', 'frizz', 'ressecado', 'seco'] }
    ]
  },
  {
    campo: 'intensidade',
    pergunta: 'E isso tem te incomodado em qual nível?',
    opcoes: [
      { label: 'Pouco, mas quero cuidar', aliases: ['pouco', 'leve', 'quero cuidar'] },
      { label: 'Médio, já está me preocupando', aliases: ['medio', 'medio', 'preocupando', 'me preocupa'] },
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
      { label: 'Sim, com profissional', aliases: ['com profissional', 'clinica', 'clinica'] },
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
      { label: 'Entender o que está acontecendo', aliases: ['entender', 'descobrir', 'saber o que esta acontecendo'] }
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

// ─── ESTADO DOS USUÁRIOS ─────────────────────────────────────────────────────

let usuarios = carregarEstado()

// ─── FUNÇÃO PRINCIPAL ────────────────────────────────────────────────────────

async function iniciarBot() {
  garantirArquivoCSV()

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR Code abaixo com seu WhatsApp:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode
      const deveReconectar = codigo !== DisconnectReason.loggedOut
      console.log('⚠️ Conexão encerrada. Código:', codigo, '| Reconectando:', deveReconectar)
      if (deveReconectar) {
        setTimeout(() => iniciarBot(), 3000)
      } else {
        console.log('🔴 Sessão encerrada. Delete a pasta auth_info e rode novamente.')
      }
    }

    if (connection === 'open') {
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

    const textoNormalizado = normalizarTexto(texto)

    try {
      // Reinício manual
      if (COMANDOS_REINICIO.includes(textoNormalizado)) {
        delete usuarios[jid]
        salvarEstado(usuarios)
        await sock.sendMessage(jid, {
          text: '🔄 Atendimento reiniciado.\n\nPara começar, envie:\n*Olá, quero conhecer a clínica.*'
        })
        return
      }

      // ✅ CORRIGIDO: comparação flexível com .includes()
      if (!usuarios[jid]) {
        if (textoNormalizado.includes(MENSAGEM_GATILHO)) {
          usuarios[jid] = { etapa: 0, respostas: {} }
          salvarEstado(usuarios)
          await enviarPergunta(sock, jid, fluxo[0])
        }
        return
      }

      const estadoUsuario = usuarios[jid]
      const etapaAtual = fluxo[estadoUsuario.etapa]
      if (!etapaAtual) return

      const respostaValida = validarResposta(etapaAtual, texto)

      if (!respostaValida) {
        if (etapaAtual.campo === 'idade') {
          await sock.sendMessage(jid, { text: 'Por favor, me informe sua idade usando apenas números. Ex.: *35*' })
        } else if (etapaAtual.opcoes) {
          await sock.sendMessage(jid, { text: 'Pode me responder com o número da opção ou com o texto.\n\nExemplo: *1* ou *Queda de cabelo*' })
        } else {
          await sock.sendMessage(jid, { text: 'Pode me responder novamente, por favor?' })
        }
        return
      }

      let respostaFinal = texto
      if (etapaAtual.opcoes) {
        respostaFinal = interpretarOpcao(etapaAtual, texto)
      }

      estadoUsuario.respostas[etapaAtual.campo] = respostaFinal
      estadoUsuario.etapa += 1
      salvarEstado(usuarios)

      if (estadoUsuario.etapa < fluxo.length) {
        const proximaPergunta = fluxo[estadoUsuario.etapa]

        if (proximaPergunta.campo === 'idade') {
          const nome = estadoUsuario.respostas.nome
          await delay(3000)
          await sock.sendMessage(jid, { text: `Prazer, *${nome}*! 😊` })
          await enviarPergunta(sock, jid, proximaPergunta)
          return
        }

        await enviarPergunta(sock, jid, proximaPergunta)
      } else {
        console.log('\n===== NOVO LEAD =====')
        console.log('WhatsApp:', jid)
        console.log('Respostas:', estadoUsuario.respostas)
        console.log('=====================\n')

        salvarLeadCSV(jid, estadoUsuario.respostas)

        await delay(3000)
        await sock.sendMessage(jid, { text: MENSAGEM_FINAL })

        delete usuarios[jid]
        salvarEstado(usuarios)
      }
    } catch (err) {
      console.error('Erro ao processar mensagem:', err)
    }
  })
}

iniciarBot()
