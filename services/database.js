const prisma = require('../db')

async function buscarSessao(phone) {
  return prisma.leadSession.findUnique({
    where: { phone }
  })
}

async function criarOuAtualizarSessao(phone, dados = {}) {
  return prisma.leadSession.upsert({
    where: { phone },
    update: {
      ...dados,
      updatedAt: new Date()
    },
    create: {
      phone,
      ...dados
    }
  })
}

async function atualizarSessao(phone, dados = {}) {
  return prisma.leadSession.update({
    where: { phone },
    data: {
      ...dados,
      updatedAt: new Date()
    }
  })
}

async function removerSessao(phone) {
  return prisma.leadSession.deleteMany({
    where: { phone }
  })
}

async function salvarLead(phone, jid, respostas) {
  return prisma.lead.upsert({
    where: { phone },
    update: {
      jid,
      nome: respostas.nome || null,
      idade: respostas.idade ? parseInt(respostas.idade, 10) : null,
      dorPrincipal: respostas.dorPrincipal || null,
      intensidade: respostas.intensidade || null,
      tempoProblema: respostas.tempoProblema || null,
      tratamentoAnterior: respostas.tratamentoAnterior || null,
      objetivoAtual: respostas.objetivoAtual || null,
      quimica: respostas.quimica || null,
      updatedAt: new Date()
    },
    create: {
      phone,
      jid,
      nome: respostas.nome || null,
      idade: respostas.idade ? parseInt(respostas.idade, 10) : null,
      dorPrincipal: respostas.dorPrincipal || null,
      intensidade: respostas.intensidade || null,
      tempoProblema: respostas.tempoProblema || null,
      tratamentoAnterior: respostas.tratamentoAnterior || null,
      objetivoAtual: respostas.objetivoAtual || null,
      quimica: respostas.quimica || null
    }
  })
}

async function atualizarStatusLead(phone, status) {
  return prisma.lead.update({
    where: { phone },
    data: { status }
  })
}

async function listarLeads() {
  return prisma.lead.findMany({
    orderBy: { createdAt: 'desc' }
  })
}

module.exports = {
  buscarSessao,
  criarOuAtualizarSessao,
  atualizarSessao,
  removerSessao,
  salvarLead,
  atualizarStatusLead,
  listarLeads
}