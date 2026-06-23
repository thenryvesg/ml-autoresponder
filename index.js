require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const TOKENS_PATH = process.env.RENDER
  ? path.join('/data', 'tokens.json')
  : path.join(__dirname, 'tokens.json');

const PENDENTES_PATH = process.env.RENDER
  ? path.join('/data', 'pendentes.json')
  : path.join(__dirname, 'pendentes.json');

const USER_ID = '299804329';

function getTokens() {
  if (fs.existsSync(TOKENS_PATH)) return JSON.parse(fs.readFileSync(TOKENS_PATH));
  if (process.env.ML_TOKENS) return JSON.parse(process.env.ML_TOKENS);
  return null;
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  console.log('Tokens salvos em', TOKENS_PATH);
}

function getPendentes() {
  if (fs.existsSync(PENDENTES_PATH)) return JSON.parse(fs.readFileSync(PENDENTES_PATH));
  return [];
}

function savePendentes(pendentes) {
  fs.writeFileSync(PENDENTES_PATH, JSON.stringify(pendentes, null, 2));
}

function adicionarPendente(item) {
  const pendentes = getPendentes();
  pendentes.push(item);
  savePendentes(pendentes);
}

function removerPendente(id) {
  const pendentes = getPendentes().filter(p => p.id !== id);
  savePendentes(pendentes);
}

async function refreshAccessToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('Nenhum token salvo.');
  const response = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
  );
  saveTokens(response.data);
  console.log('Token renovado com sucesso.');
  return response.data.access_token;
}

async function getValidToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('Faça a autenticação primeiro.');
  return tokens.access_token;
}

const CATEGORIAS_START_RACING = [
  { slug: 'protecao-de-motor-off-road', nome: 'Proteção de Motor (Off Road)' },
  { slug: 'protecao-de-motor-e-carter-street', nome: 'Proteção de Motor e Carter (Street)' },
  { slug: 'protecao-lateral-e-motor-', nome: 'Proteção Lateral e Motor' },
  { slug: 'protecao-de-mao', nome: 'Proteção de Mão' },
  { slug: 'protecao-de-radiador-envolvente', nome: 'Proteção de Radiador Envolvente' },
  { slug: 'protecao-de-radiador-mx', nome: 'Proteção de Radiador MX' },
  { slug: 'protecao-de-radiador-xc', nome: 'Proteção de Radiador XC' },
  { slug: 'protecao-de-radiador-frontal', nome: 'Proteção de Radiador Frontal' },
  { slug: 'grades-frontais-de-radiador', nome: 'Grade Frontal de Radiador' },
  { slug: 'protecao-de-farol', nome: 'Proteção de Farol' },
  { slug: 'protecao-de-disco-de-freio', nome: 'Proteção de Disco de Freio' },
  { slug: 'protecao-de-pinhao', nome: 'Proteção de Pinhão' },
  { slug: 'protecao-de-cano-de-escape', nome: 'Proteção de Cano de Escape' },
  { slug: 'guias-de-corrente', nome: 'Guia de Corrente' },
  { slug: 'ampliacao-da-base-do-cavalete-lateral', nome: 'Ampliação da Base do Cavalete Lateral' },
  { slug: 'cavalete-central', nome: 'Cavalete Central' },
  { slug: 'bases-para-fixacao-de-bau-traseiro', nome: 'Base para Fixação de Baú Traseiro' },
  { slug: 'suporte-para-bau-lateral', nome: 'Suporte para Baú Lateral' },
  { slug: 'afastador-de-alforge', nome: 'Afastador de Alforge' },
  { slug: 'suporte-para-gps', nome: 'Suporte para GPS' },
  { slug: 'suporte-ajustavel-da-bolha-', nome: 'Suporte Ajustável da Bolha' },
  { slug: 'suporte-para-farol-auxiliar', nome: 'Suporte para Farol Auxiliar' },
  { slug: 'pedaleiras', nome: 'Pedaleiras' },
  { slug: 'protecoes-variadas', nome: 'Proteções Variadas' },
  { slug: 'sissibar', nome: 'Sissibar' },
];

async function identificarCategoria(tituloAnuncio) {
  const listaCategorias = CATEGORIAS_START_RACING.map(c => `- ${c.nome} (slug: ${c.slug})`).join('\n');
  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: `Dado o título do anúncio: "${tituloAnuncio}"\n\nIdentifique qual categoria abaixo melhor corresponde ao produto. Responda APENAS com o slug da categoria, sem mais nada.\n\n${listaCategorias}` }],
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  return data.content[0].text.trim();
}

async function buscarProdutosCategoria(slugCategoria) {
  const url = `https://www.startracing.com.br/produtos/${slugCategoria}`;
  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 10000,
  });
  const $ = cheerio.load(html);
  const produtos = [];
  $('a[href*="/produtos/"]').each((_, el) => {
    const href = $(el).attr('href');
    const nome = $(el).attr('title') || $(el).text().trim();
    if (href && /\/produtos\/.+\/.+\/\d+$/.test(href) && nome) {
      const url = href.startsWith('http') ? href : `https://www.startracing.com.br${href}`;
      produtos.push({ nome, url });
    }
  });
  return produtos.filter((p, i, arr) => arr.findIndex(x => x.url === p.url) === i);
}

async function lerProduto(urlProduto) {
  try {
    const { data: html } = await axios.get(urlProduto, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000,
    });
    const $ = cheerio.load(html);
    const texto = $('body').text();
    const skuMatch = texto.match(/C[oó]digo[:\s]+([A-Z0-9]+)/i);
    const sku = skuMatch ? skuMatch[1].trim() : null;
    const aplicacaoMatch = texto.match(/Aplica[cç][aã]o do produto([\s\S]*?)(?:Seja qual for|©|$)/i);
    const aplicacao = aplicacaoMatch ? aplicacaoMatch[1].trim() : '';
    return { sku, aplicacao };
  } catch {
    return { sku: null, aplicacao: '' };
  }
}

async function buscarAnuncioPorSku(sku, token) {
  try {
    for (const param of [`seller_sku=${sku}`, `sku=${sku}`]) {
      const resp = await axios.get(
        `https://api.mercadolibre.com/users/${USER_ID}/items/search?${param}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (resp.data.results?.length > 0) {
        const { data: item } = await axios.get(
          `https://api.mercadolibre.com/items/${resp.data.results[0]}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return { titulo: item.title, link: item.permalink };
      }
    }
    return null;
  } catch { return null; }
}

async function buscarEquivalenteCompativel(tituloAnuncio, marca, modelo, ano, token) {
  try {
    console.log(`Buscando equivalente para ${marca} ${modelo} ${ano}...`);
    const slugCategoria = await identificarCategoria(tituloAnuncio);
    console.log('Categoria identificada:', slugCategoria);
    const produtos = await buscarProdutosCategoria(slugCategoria);
    console.log(`${produtos.length} produtos encontrados na categoria`);
    for (const produto of produtos.slice(0, 30)) {
      const { sku, aplicacao } = await lerProduto(produto.url);
      if (!sku || !aplicacao) continue;
      const aplicacaoLower = aplicacao.toLowerCase();
      const marcaOk = aplicacaoLower.includes(marca.toLowerCase());
      const modeloOk = aplicacaoLower.includes(modelo.toLowerCase());
      const anoOk = !ano || aplicacaoLower.includes(ano);
      if (marcaOk && modeloOk && anoOk) {
        console.log(`Compatível: ${produto.nome} (${sku})`);
        const anuncio = await buscarAnuncioPorSku(sku, token);
        if (anuncio) return { nome: produto.nome, sku, anuncio };
      }
    }
    return null;
  } catch (err) {
    console.error('Erro ao buscar equivalente:', err.message);
    return null;
  }
}

// ─── Webhook ─────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { topic, resource } = req.body;
  console.log('Notificação recebida:', topic, resource);
  if (topic !== 'questions') return;

  try {
    let token = await getValidToken();
    const questionId = resource.replace('/questions/', '');
    let question;
    try {
      const resp = await axios.get(`https://api.mercadolibre.com/questions/${questionId}`, { headers: { Authorization: `Bearer ${token}` } });
      question = resp.data;
    } catch (err) {
      if (err.response?.status === 401) {
        token = await refreshAccessToken();
        const resp = await axios.get(`https://api.mercadolibre.com/questions/${questionId}`, { headers: { Authorization: `Bearer ${token}` } });
        question = resp.data;
      } else throw err;
    }

    if (question.status !== 'UNANSWERED') return;
    console.log('Pergunta:', question.text);

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const diaSemana = agora.getDay();
    const hora = agora.getHours();
    const ehHorarioComercial = diaSemana >= 1 && diaSemana <= 5 && hora >= 9 && hora < 18;
    const DELAY_MINUTOS = ehHorarioComercial ? 35 : 10;
    console.log(`Horário ${ehHorarioComercial ? 'comercial' : 'fora do comercial'} — aguardando ${DELAY_MINUTOS} minutos (pergunta ${questionId})...`);
    await new Promise(resolve => setTimeout(resolve, DELAY_MINUTOS * 60 * 1000));

    token = await getValidToken();
    const { data: questionAtualizada } = await axios.get(`https://api.mercadolibre.com/questions/${questionId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (questionAtualizada.status !== 'UNANSWERED') {
      console.log(`Pergunta ${questionId} já respondida manualmente.`);
      return;
    }

    const { data: item } = await axios.get(`https://api.mercadolibre.com/items/${question.item_id}`, { headers: { Authorization: `Bearer ${token}` } });

    let variacoesTexto = 'Este produto não possui variações cadastradas.';
    if (item.variations?.length > 0) {
      variacoesTexto = item.variations.map(v => {
        const combinacao = v.attribute_combinations?.map(ac => `${ac.name}: ${ac.value_name}`).join(', ') || 'Variação sem nome';
        const estoque = v.available_quantity > 0 ? `${v.available_quantity} em estoque` : 'SEM ESTOQUE (esgotado)';
        return `- ${combinacao} → ${estoque}`;
      }).join('\n');
    }

    const perguntaLower = question.text.toLowerCase();
    const ehCompatibilidade = ['serve', 'compatível', 'compativel', 'funciona', 'encaixa', 'fit'].some(p => perguntaLower.includes(p));

    let infoEquivalente = '';
    if (ehCompatibilidade) {
      const { data: extraido } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: `Extraia marca, modelo e ano da moto da seguinte pergunta. Responda APENAS em JSON no formato {"marca":"","modelo":"","ano":""} sem mais nada. Se não tiver algum campo, deixe vazio.\n\nPergunta: "${question.text}"` }] },
        { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
      );
      try {
        const { marca, modelo, ano } = JSON.parse(extraido.content[0].text.trim());
        if (marca && modelo && ano) {
          const equivalente = await buscarEquivalenteCompativel(item.title, marca, modelo, ano, token);
          if (equivalente?.anuncio) {
            infoEquivalente = `\n\nProduto equivalente compatível encontrado na loja:\nNome: ${equivalente.anuncio.titulo}\nLink: ${equivalente.anuncio.link}`;
          }
        }
      } catch { console.log('Não foi possível extrair dados da moto.'); }
    }

    const prompt = `Você é um assistente de vendas do Mercado Livre. Responda a pergunta do cliente de forma simpática, clara e objetiva, com base nos dados do produto. Não invente informações que não estão nos dados.

Produto: ${item.title}
Descrição: ${item.description || 'Não disponível'}
Atributos: ${JSON.stringify(item.attributes?.slice(0, 10))}
Variações disponíveis e estoque:\n${variacoesTexto}
Contexto do atendimento: ${ehHorarioComercial ? 'HORÁRIO COMERCIAL (segunda a sexta, 09h às 18h) — há especialistas disponíveis agora' : 'FORA DO HORÁRIO COMERCIAL'}
${infoEquivalente}

Pergunta do cliente: ${question.text}

Diretrizes:
- Responda como um vendedor de loja física: direto, natural, sem enrolação
- Vá direto à informação pedida na primeira frase
- Se o cliente perguntar sobre cor/variação, confirme se existe E se tem estoque
- NÃO use bordões repetitivos — varie a forma de se expressar
- Se a informação não estiver nos dados, diga com transparência
- CASO ESPECIAL — compatibilidade incompleta (só marca/ano, sem modelo): peça o modelo específico, ex: "Nos informe o modelo de forma mais específica da sua moto?"
- CASO ESPECIAL — ano não informado: peça o ano, ex: "Nos informe o ano de fabricação da sua moto para confirmarmos a compatibilidade?"
- CASO ESPECIAL — incompatível MAS existe equivalente nos dados acima: informe a incompatibilidade e sugira o equivalente com o link do anúncio
- CASO ESPECIAL — incompatível SEM equivalente: informe a incompatibilidade e aplique a REGRA DE ENCAMINHAMENTO
- NUNCA sugira contato com fabricante, site externo ou qualquer canal fora do Mercado Livre
- REGRA DE ENCAMINHAMENTO: HORÁRIO COMERCIAL → "Por gentileza, entre em contato em breve que um especialista poderá te ajudar melhor."; FORA DO COMERCIAL → "Por gentileza, entre em contato conosco em horário comercial, de segunda a sexta-feira, para um melhor auxílio."
- Máximo 3 frases. Sem saudações, sem markdown, sem emojis.

Responda em português do Brasil.`;

    const { data: aiResponse } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    const respostaSugerida = aiResponse.content[0].text;
    console.log('Resposta sugerida (aguardando aprovação):', respostaSugerida);

    // Salva como pendente em vez de enviar direto
    adicionarPendente({
      id: questionId,
      pergunta: question.text,
      produto: item.title,
      resposta: respostaSugerida,
      criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    });

    console.log(`Resposta pendente salva para revisão (pergunta ${questionId}).`);
  } catch (err) {
    console.error('Erro:', err.response?.data || err.message);
  }
});

// ─── Tela de revisão ─────────────────────────────────────────────────────────
app.get('/revisar', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) {
    return res.status(401).send('Senha incorreta.');
  }
  const pendentes = getPendentes();
  const senha = req.query.senha;

  if (pendentes.length === 0) {
    return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revisão de Respostas</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px;background:#f5f5f5}h1{color:#333}.vazio{background:#fff;padding:30px;border-radius:8px;text-align:center;color:#666}</style></head><body><h1>Revisão de Respostas</h1><div class="vazio">Nenhuma resposta pendente no momento.</div></body></html>`);
  }

  const cards = pendentes.map(p => `
    <div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
      <div style="font-size:12px;color:#999;margin-bottom:8px">${p.criadoEm} — Pergunta #${p.id}</div>
      <div style="font-size:13px;color:#555;margin-bottom:6px"><strong>Produto:</strong> ${p.produto}</div>
      <div style="background:#f0f4ff;padding:12px;border-radius:6px;margin-bottom:10px">
        <strong style="font-size:13px">Pergunta do cliente:</strong><br>
        <span style="font-size:15px">${p.pergunta}</span>
      </div>
      <div style="background:#f0fff4;padding:12px;border-radius:6px;margin-bottom:16px">
        <strong style="font-size:13px">Resposta sugerida:</strong><br>
        <span style="font-size:15px">${p.resposta}</span>
      </div>
      <div style="display:flex;gap:10px">
        <form method="POST" action="/aprovar?senha=${senha}" style="flex:1">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" style="width:100%;padding:12px;background:#22c55e;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer">Aprovar e Enviar</button>
        </form>
        <form method="POST" action="/rejeitar?senha=${senha}" style="flex:1">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" style="width:100%;padding:12px;background:#ef4444;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer">Rejeitar</button>
        </form>
      </div>
    </div>
  `).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revisão de Respostas</title><style>body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:20px;background:#f5f5f5}h1{color:#333;margin-bottom:20px}</style></head><body><h1>Revisão de Respostas (${pendentes.length})</h1>${cards}</body></html>`);
});

// ─── Aprovar resposta ─────────────────────────────────────────────────────────
app.post('/aprovar', async (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const { id } = req.body;
  const pendentes = getPendentes();
  const pendente = pendentes.find(p => p.id === id);
  if (!pendente) return res.send('Resposta não encontrada.');

  try {
    let token = await getValidToken();
    try {
      await axios.post(
        'https://api.mercadolibre.com/answers',
        { question_id: parseInt(id), text: pendente.resposta },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      if (err.response?.status === 401) {
        token = await refreshAccessToken();
        await axios.post(
          'https://api.mercadolibre.com/answers',
          { question_id: parseInt(id), text: pendente.resposta },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      } else throw err;
    }
    removerPendente(id);
    console.log(`Resposta aprovada e enviada (pergunta ${id}).`);
    res.redirect(`/revisar?senha=${req.query.senha}`);
  } catch (err) {
    console.error('Erro ao enviar resposta:', err.response?.data || err.message);
    res.send('Erro ao enviar resposta: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// ─── Rejeitar resposta ────────────────────────────────────────────────────────
app.post('/rejeitar', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const { id } = req.body;
  removerPendente(id);
  console.log(`Resposta rejeitada (pergunta ${id}).`);
  res.redirect(`/revisar?senha=${req.query.senha}`);
});

// ─── Rota de saúde ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Servidor ML AutoResponder online!'));

// ─── Setup token ─────────────────────────────────────────────────────────────
app.post('/setup-token', (req, res) => {
  const { senha, tokens } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  saveTokens(tokens);
  res.send('Token salvo com sucesso no disco persistente!');
});

// ─── Get token ───────────────────────────────────────────────────────────────
app.get('/get-token', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const tokens = getTokens();
  if (!tokens) return res.status(404).send('Nenhum token encontrado.');
  res.json(tokens);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
