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
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
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
  { slug: 'protecao-de-motor-off-road/1', nome: 'Proteção de Motor (Off Road)' },
  { slug: 'protecao-de-motor-e-carter-street/14', nome: 'Proteção de Motor e Carter (Street)' },
  { slug: 'protecao-lateral-e-motor-/11', nome: 'Proteção Lateral e Motor' },
  { slug: 'protecao-de-mao/12', nome: 'Proteção de Mão' },
  { slug: 'protecao-de-radiador-envolvente/6', nome: 'Proteção de Radiador Envolvente' },
  { slug: 'protecao-de-radiador-mx/7', nome: 'Proteção de Radiador MX' },
  { slug: 'protecao-de-radiador-xc/8', nome: 'Proteção de Radiador XC' },
  { slug: 'protecao-de-radiador-frontal/9', nome: 'Proteção de Radiador Frontal' },
  { slug: 'grades-frontais-de-radiador/10', nome: 'Grade Frontal de Radiador' },
  { slug: 'protecao-de-farol/5', nome: 'Proteção de Farol' },
  { slug: 'protecao-de-disco-de-freio/22', nome: 'Proteção de Disco de Freio' },
  { slug: 'protecao-de-pinhao/23', nome: 'Proteção de Pinhão' },
  { slug: 'protecao-de-cano-de-escape/24', nome: 'Proteção de Cano de Escape' },
  { slug: 'guias-de-corrente/25', nome: 'Guia de Corrente' },
  { slug: 'ampliacao-da-base-do-cavalete-lateral/13', nome: 'Ampliação da Base do Cavalete Lateral' },
  { slug: 'cavalete-central/26', nome: 'Cavalete Central' },
  { slug: 'bases-para-fixacao-de-bau-traseiro/16', nome: 'Base para Fixação de Baú Traseiro' },
  { slug: 'suporte-para-bau-lateral/35', nome: 'Suporte para Baú Lateral' },
  { slug: 'afastador-de-alforge/36', nome: 'Afastador de Alforge' },
  { slug: 'suporte-para-gps/37', nome: 'Suporte para GPS' },
  { slug: 'suporte-ajustavel-da-bolha-/38', nome: 'Suporte Ajustável da Bolha' },
  { slug: 'suporte-para-farol-auxiliar/39', nome: 'Suporte para Farol Auxiliar' },
  { slug: 'pedaleiras/40', nome: 'Pedaleiras' },
  { slug: 'protecoes-variadas/41', nome: 'Proteções Variadas' },
  { slug: 'sissibar/42', nome: 'Sissibar' },
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
  console.log('Buscando categoria:', url);
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
    console.log(`Buscando equivalente — marca: "${marca}", modelo: "${modelo}", ano: "${ano}"...`);
    const slugCategoria = await identificarCategoria(tituloAnuncio);
    console.log('Categoria identificada:', slugCategoria);
    const produtos = await buscarProdutosCategoria(slugCategoria);
    console.log(`${produtos.length} produtos encontrados na categoria`);

    for (const produto of produtos.slice(0, 30)) {
      const { sku, aplicacao } = await lerProduto(produto.url);
      if (!sku || !aplicacao) continue;
      const aplicacaoLower = aplicacao.toLowerCase();

      const modeloOk = modelo ? aplicacaoLower.includes(modelo.toLowerCase()) : false;
      if (!modeloOk) continue;

      const anoOk = ano ? aplicacaoLower.includes(ano) : false;
      if (!anoOk) continue;

      const marcaOk = marca ? aplicacaoLower.includes(marca.toLowerCase()) : true;
      if (!marcaOk) continue;

      console.log(`Compatível: ${produto.nome} (${sku})`);
      const anuncio = await buscarAnuncioPorSku(sku, token);
      if (anuncio) return { nome: produto.nome, sku, anuncio };
    }
    return null;
  } catch (err) {
    console.error('Erro ao buscar equivalente:', err.message);
    return null;
  }
}

// ─── Extrai marca e/ou modelo do título e descrição do anúncio via Claude ────
async function extrairDadosDoAnuncio(tituloAnuncio, descricaoAnuncio) {
  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: `Do título e descrição do anúncio abaixo, extraia a marca e o modelo da moto. Responda APENAS em JSON no formato {"marca":"","modelo":""} sem mais nada. Se não encontrar algum campo, deixe vazio.

Título: "${tituloAnuncio}"
Descrição: "${(descricaoAnuncio || '').slice(0, 500)}"`
        }],
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const texto = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    console.log('Dados extraídos do anúncio:', texto);
    return JSON.parse(texto);
  } catch (err) {
    console.error('Erro ao extrair dados do anúncio:', err.message);
    return {};
  }
}

// ─── Função principal de processamento de perguntas ──────────────────────────
async function processarPergunta(questionId) {
  let token = await getValidToken();
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

  if (question.status !== 'UNANSWERED') {
    console.log(`Pergunta ${questionId} já foi respondida.`);
    return;
  }
  console.log('Pergunta:', question.text);

  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  const ehHorarioComercial = diaSemana >= 1 && diaSemana <= 5 && hora >= 9 && hora < 18;
  const delayAtivo = process.env.DELAY_ATIVO !== 'false';

  if (delayAtivo) {
    const DELAY_MINUTOS = ehHorarioComercial ? 35 : 10;
    console.log(`Aguardando ${DELAY_MINUTOS} minutos (pergunta ${questionId})...`);
    await new Promise(resolve => setTimeout(resolve, DELAY_MINUTOS * 60 * 1000));
    token = await getValidToken();
    const { data: questionAtualizada } = await axios.get(`https://api.mercadolibre.com/questions/${questionId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (questionAtualizada.status !== 'UNANSWERED') {
      console.log(`Pergunta ${questionId} já respondida manualmente.`);
      return;
    }
  } else {
    console.log(`Delay desativado — processando imediatamente (pergunta ${questionId}).`);
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
  let dadosMotoIncompletos = '';

  if (ehCompatibilidade) {
    const { data: extraido } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: `Extraia marca, modelo e ano da moto da seguinte pergunta. Responda APENAS em JSON no formato {"marca":"","modelo":"","ano":""} sem mais nada. Se não tiver algum campo, deixe vazio.\n\nPergunta: "${question.text}"` }]
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    try {
      const textoExtraido = extraido.content[0].text.trim().replace(/```json|```/g, '').trim();
      console.log('Texto extraído da pergunta:', textoExtraido);
      let { marca, modelo, ano } = JSON.parse(textoExtraido);
      console.log(`Dados extraídos — marca: "${marca}", modelo: "${modelo}", ano: "${ano}"`);

      // Fallback: se não encontrou modelo ou marca na pergunta, busca no anúncio
      if ((!modelo || !marca) && ano) {
        console.log('Modelo ou marca ausentes — buscando no anúncio...');
        const dadosAnuncio = await extrairDadosDoAnuncio(item.title, item.description);
        if (!modelo && dadosAnuncio.modelo) {
          console.log(`Modelo extraído do anúncio: "${dadosAnuncio.modelo}"`);
          modelo = dadosAnuncio.modelo;
        }
        if (!marca && dadosAnuncio.marca) {
          console.log(`Marca extraída do anúncio: "${dadosAnuncio.marca}"`);
          marca = dadosAnuncio.marca;
        }
      }

      console.log(`Dados finais para busca — marca: "${marca}", modelo: "${modelo}", ano: "${ano}"`);

      if (!modelo) {
        dadosMotoIncompletos = 'FALTANDO_MODELO';
      } else if (!ano) {
        dadosMotoIncompletos = 'FALTANDO_ANO';
      } else {
        const equivalente = await buscarEquivalenteCompativel(item.title, marca || '', modelo, ano, token);
        if (equivalente?.anuncio) {
          infoEquivalente = `\n\nProduto equivalente compatível encontrado na loja:\nNome: ${equivalente.anuncio.titulo}\nLink: ${equivalente.anuncio.link}`;
        }
      }
    } catch (err) {
      console.log('Erro ao processar dados da moto:', err.message);
    }
  }

  const prompt = `Você é um assistente de vendas do Mercado Livre. Responda a pergunta do cliente de forma simpática, clara e objetiva, com base nos dados do produto. Não invente informações que não estão nos dados.

Produto: ${item.title}
Descrição: ${item.description || 'Não disponível'}
Atributos: ${JSON.stringify(item.attributes?.slice(0, 10))}
Variações disponíveis e estoque:\n${variacoesTexto}
Contexto do atendimento: ${ehHorarioComercial ? 'HORÁRIO COMERCIAL (segunda a sexta, 09h às 18h) — há especialistas disponíveis agora' : 'FORA DO HORÁRIO COMERCIAL'}
Dados da moto incompletos: ${dadosMotoIncompletos || 'NENHUM — dados completos'}
${infoEquivalente}

Pergunta do cliente: ${question.text}

Diretrizes:
- Responda como um vendedor de loja física: direto, natural, sem enrolação
- Vá direto à informação pedida na primeira frase
- Se o cliente perguntar sobre cor/variação, confirme se existe E se tem estoque
- NÃO use bordões repetitivos — varie a forma de se expressar
- Se a informação não estiver nos dados, diga com transparência
- CASO ESPECIAL — dadosMotoIncompletos = FALTANDO_MODELO: responda APENAS pedindo o modelo específico, ex: "Nos informe o modelo de forma mais específica da sua moto?"
- CASO ESPECIAL — dadosMotoIncompletos = FALTANDO_ANO: responda APENAS pedindo o ano, ex: "Nos informe o ano de fabricação da sua moto para confirmarmos a compatibilidade?"
- CASO ESPECIAL — existe "Produto equivalente compatível encontrado na loja": informe que esse produto não é compatível mas temos o equivalente disponível e inclua o link do anúncio
- CASO ESPECIAL — incompatível e SEM equivalente: informe a incompatibilidade de forma direta e aplique a REGRA DE ENCAMINHAMENTO. NUNCA mencione fabricante, manual, especificações técnicas ou qualquer fonte externa
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

  adicionarPendente({
    id: questionId,
    pergunta: question.text,
    produto: item.title,
    resposta: respostaSugerida,
    criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  });

  console.log(`Resposta pendente salva para revisão (pergunta ${questionId}).`);
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { topic, resource } = req.body;
  console.log('Notificação recebida:', topic, resource);
  if (topic !== 'questions') return;
  const questionId = resource.replace('/questions/', '');
  processarPergunta(questionId).catch(err => console.error('Erro:', err.response?.data || err.message));
});

// ─── Tela de revisão ──────────────────────────────────────────────────────────
app.get('/revisar', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
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
      await axios.post('https://api.mercadolibre.com/answers', { question_id: parseInt(id), text: pendente.resposta }, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (err.response?.status === 401) {
        token = await refreshAccessToken();
        await axios.post('https://api.mercadolibre.com/answers', { question_id: parseInt(id), text: pendente.resposta }, { headers: { Authorization: `Bearer ${token}` } });
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

// ─── Forçar processamento de pergunta específica ──────────────────────────────
app.post('/forcar-pergunta', (req, res) => {
  const { senha, question_id } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  if (!question_id) return res.status(400).send('question_id obrigatório.');
  const originalDelay = process.env.DELAY_ATIVO;
  process.env.DELAY_ATIVO = 'false';
  setTimeout(async () => {
    try {
      await processarPergunta(question_id);
      console.log(`Pergunta ${question_id} forçada com sucesso.`);
    } catch (err) {
      console.error(`Erro ao forçar pergunta ${question_id}:`, err.message);
    } finally {
      process.env.DELAY_ATIVO = originalDelay;
    }
  }, 100);
  res.send(`Processando pergunta ${question_id} agora...`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
