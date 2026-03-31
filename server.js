const express = require('express')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = 3001

const CAMINHO_CSV = path.join(__dirname, 'leads.csv')
const CAMINHO_STATUS = path.join(__dirname, 'lead_status.json')

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

function escaparHtml(texto = '') {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function lerStatus() {
  try {
    if (!fs.existsSync(CAMINHO_STATUS)) {
      return {}
    }

    const conteudo = fs.readFileSync(CAMINHO_STATUS, 'utf8')
    return conteudo ? JSON.parse(conteudo) : {}
  } catch (error) {
    console.error('Erro ao ler lead_status.json:', error)
    return {}
  }
}

function salvarStatus(statusMap) {
  try {
    fs.writeFileSync(CAMINHO_STATUS, JSON.stringify(statusMap, null, 2), 'utf8')
  } catch (error) {
    console.error('Erro ao salvar lead_status.json:', error)
  }
}

function parseLinhaCSV(linha) {
  const valores = []
  let atual = ''
  let dentroAspas = false

  for (let i = 0; i < linha.length; i++) {
    const char = linha[i]
    const prox = linha[i + 1]

    if (char === '"') {
      if (dentroAspas && prox === '"') {
        atual += '"'
        i++
      } else {
        dentroAspas = !dentroAspas
      }
    } else if (char === ';' && !dentroAspas) {
      valores.push(atual)
      atual = ''
    } else {
      atual += char
    }
  }

  valores.push(atual)
  return valores
}

function lerLeadsCSV() {
  try {
    if (!fs.existsSync(CAMINHO_CSV)) {
      return []
    }

    const conteudo = fs.readFileSync(CAMINHO_CSV, 'utf8').trim()

    if (!conteudo) {
      return []
    }

    const linhas = conteudo.split(/\r?\n/).filter(Boolean)

    if (linhas.length <= 1) {
      return []
    }

    const cabecalho = parseLinhaCSV(linhas[0])

    return linhas.slice(1).map((linha, index) => {
      const valores = parseLinhaCSV(linha)
      const lead = {}

      cabecalho.forEach((coluna, i) => {
        lead[coluna] = valores[i] || ''
      })

      lead._id = `${lead.telefone || 'sem-telefone'}_${lead.dataHora || index}`
      return lead
    })
  } catch (error) {
    console.error('Erro ao ler leads.csv:', error)
    return []
  }
}

function contarPorStatus(leads, statusMap) {
  const totais = {
    total: leads.length,
    novo: 0,
    contatoFeito: 0,
    agendado: 0
  }

  for (const lead of leads) {
    const status = statusMap[lead._id] || 'Novo'

    if (status === 'Novo') totais.novo++
    if (status === 'Contato feito') totais.contatoFeito++
    if (status === 'Agendado') totais.agendado++
  }

  return totais
}

function renderPagina(leads, statusMap, busca = '') {
  const termo = busca.trim().toLowerCase()

  const leadsFiltrados = termo
    ? leads.filter((lead) => {
        const campos = [
          lead.nome,
          lead.telefone,
          lead.idade,
          lead.dorPrincipal,
          lead.objetivoAtual,
          lead.dataHora
        ]
          .join(' ')
          .toLowerCase()

        return campos.includes(termo)
      })
    : leads

  const totais = contarPorStatus(leadsFiltrados, statusMap)

  const linhas = leadsFiltrados
    .slice()
    .reverse()
    .map((lead) => {
      const statusAtual = statusMap[lead._id] || 'Novo'
      const classeStatus =
        statusAtual === 'Agendado'
          ? 'status-agendado'
          : statusAtual === 'Contato feito'
          ? 'status-contato'
          : 'status-novo'

      return `
        <tr>
          <td>${escaparHtml(lead.dataHora || '-')}</td>
          <td>
            <div class="nome">${escaparHtml(lead.nome || '-')}</div>
            <div class="subinfo">Idade: ${escaparHtml(lead.idade || '-')}</div>
          </td>
          <td>${escaparHtml(lead.telefone || '-')}</td>
          <td>${escaparHtml(lead.dorPrincipal || '-')}</td>
          <td>${escaparHtml(lead.intensidade || '-')}</td>
          <td>${escaparHtml(lead.objetivoAtual || '-')}</td>
          <td>
            <form method="POST" action="/status" class="status-form">
              <input type="hidden" name="id" value="${escaparHtml(lead._id)}" />
              <input type="hidden" name="busca" value="${escaparHtml(busca)}" />
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
                <p><strong>Tempo do problema:</strong> ${escaparHtml(lead.tempoProblema || '-')}</p>
                <p><strong>Tratamento anterior:</strong> ${escaparHtml(lead.tratamentoAnterior || '-')}</p>
                <p><strong>Química:</strong> ${escaparHtml(lead.quimica || '-')}</p>
              </div>
            </details>
          </td>
        </tr>
      `
    })
    .join('')

  return `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Painel de Leads</title>
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #f5f7fb;
        color: #1f2937;
      }

      .container {
        max-width: 1280px;
        margin: 0 auto;
        padding: 24px;
      }

      .topo {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 24px;
      }

      .titulo h1 {
        margin: 0;
        font-size: 30px;
      }

      .titulo p {
        margin: 6px 0 0;
        color: #6b7280;
      }

      .acoes {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }

      .busca-form {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .busca-form input {
        min-width: 260px;
        padding: 12px 14px;
        border: 1px solid #d1d5db;
        border-radius: 12px;
        background: #fff;
      }

      .busca-form button,
      .link-limpar {
        padding: 12px 16px;
        border: 0;
        border-radius: 12px;
        background: #111827;
        color: #fff;
        text-decoration: none;
        cursor: pointer;
      }

      .link-limpar {
        background: #6b7280;
        display: inline-flex;
        align-items: center;
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }

      .card {
        background: #fff;
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.06);
      }

      .card h3 {
        margin: 0 0 8px;
        font-size: 15px;
        color: #6b7280;
        font-weight: 600;
      }

      .card .numero {
        font-size: 32px;
        font-weight: 700;
      }

      .tabela-wrap {
        background: #fff;
        border-radius: 20px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.06);
        overflow: hidden;
      }

      .tabela-scroll {
        overflow-x: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1100px;
      }

      thead {
        background: #111827;
        color: #fff;
      }

      th, td {
        text-align: left;
        padding: 14px 16px;
        border-bottom: 1px solid #e5e7eb;
        vertical-align: top;
      }

      tbody tr:hover {
        background: #f9fafb;
      }

      .nome {
        font-weight: 700;
      }

      .subinfo {
        margin-top: 4px;
        font-size: 13px;
        color: #6b7280;
      }

      .select-status {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        font-weight: 700;
        outline: none;
        cursor: pointer;
      }

      .status-novo {
        background: #fef3c7;
        color: #92400e;
      }

      .status-contato {
        background: #dbeafe;
        color: #1d4ed8;
      }

      .status-agendado {
        background: #dcfce7;
        color: #166534;
      }

      details summary {
        cursor: pointer;
        color: #111827;
        font-weight: 600;
      }

      .detalhes {
        margin-top: 10px;
        color: #4b5563;
        font-size: 14px;
        line-height: 1.5;
      }

      .vazio {
        padding: 48px 20px;
        text-align: center;
        color: #6b7280;
      }

      @media (max-width: 768px) {
        .container {
          padding: 16px;
        }

        .titulo h1 {
          font-size: 24px;
        }

        .busca-form input {
          min-width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="topo">
        <div class="titulo">
          <h1>Leads Clínica Capilar</h1>
          <p>Painel local para visualizar e organizar os pré-atendimentos.</p>
        </div>

        <div class="acoes">
          <form class="busca-form" method="GET" action="/">
            <input
              type="text"
              name="busca"
              placeholder="Buscar por nome, telefone, dor..."
              value="${escaparHtml(busca)}"
            />
            <button type="submit">Buscar</button>
            <a class="link-limpar" href="/">Limpar</a>
          </form>
        </div>
      </div>

      <div class="cards">
        <div class="card">
          <h3>Total de leads</h3>
          <div class="numero">${totais.total}</div>
        </div>
        <div class="card">
          <h3>Novos</h3>
          <div class="numero">${totais.novo}</div>
        </div>
        <div class="card">
          <h3>Contato feito</h3>
          <div class="numero">${totais.contatoFeito}</div>
        </div>
        <div class="card">
          <h3>Agendados</h3>
          <div class="numero">${totais.agendado}</div>
        </div>
      </div>

      <div class="tabela-wrap">
        <div class="tabela-scroll">
          ${
            leadsFiltrados.length > 0
              ? `
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Lead</th>
                    <th>Telefone</th>
                    <th>Dor principal</th>
                    <th>Intensidade</th>
                    <th>Objetivo</th>
                    <th>Status</th>
                    <th>Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  ${linhas}
                </tbody>
              </table>
            `
              : `<div class="vazio">Nenhum lead encontrado.</div>`
          }
        </div>
      </div>
    </div>
  </body>
  </html>
  `
}

app.get('/', (req, res) => {
  const busca = req.query.busca || ''
  const leads = lerLeadsCSV()
  const statusMap = lerStatus()

  res.send(renderPagina(leads, statusMap, busca))
})

app.post('/status', (req, res) => {
  const { id, status, busca = '' } = req.body

  if (!id || !status) {
    return res.redirect('/')
  }

  const statusPermitidos = ['Novo', 'Contato feito', 'Agendado']
  if (!statusPermitidos.includes(status)) {
    return res.redirect('/')
  }

  const statusMap = lerStatus()
  statusMap[id] = status
  salvarStatus(statusMap)

  const query = busca ? `?busca=${encodeURIComponent(busca)}` : ''
  res.redirect('/' + query)
})

app.listen(PORT, () => {
  console.log(`🌐 Painel de leads rodando em http://localhost:${PORT}`)
})