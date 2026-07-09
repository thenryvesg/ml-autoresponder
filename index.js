require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
const TIMEOUT_APROVACAO_MS = 30 * 60 * 1000;

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

async function enviarResposta(questionId, texto) {
  let token = await getValidToken();
  try {
    await axios.post(
      'https://api.mercadolibre.com/answers',
      { question_id: parseInt(questionId), text: texto },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    if (err.response?.status === 401) {
      token = await refreshAccessToken();
      await axios.post(
        'https://api.mercadolibre.com/answers',
        { question_id: parseInt(questionId), text: texto },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } else throw err;
  }
}

function agendarAprovacaoAutomatica(questionId) {
  console.log(`Aprovação automática agendada em 30 minutos (pergunta ${questionId}).`);
  setTimeout(async () => {
    const pendentes = getPendentes();
    const pendente = pendentes.find(p => p.id === questionId);
    if (!pendente) {
      console.log(`Pergunta ${questionId} já foi tratada manualmente.`);
      return;
    }
    try {
      await enviarResposta(questionId, pendente.resposta);
      removerPendente(questionId);
      console.log(`Resposta aprovada automaticamente após 30 minutos (pergunta ${questionId}).`);
    } catch (err) {
      console.error(`Erro na aprovação automática (pergunta ${questionId}):`, err.response?.data || err.message);
    }
  }, TIMEOUT_APROVACAO_MS);
}

async function extrairDadosDoAnuncio(tituloAnuncio, descricaoAnuncio) {
  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: `Do título e descrição do anúncio abaixo, extraia a marca e o modelo da moto. Responda APENAS em JSON no formato {"marca":"","modelo":""} sem mais nada. Se não encontrar algum campo, deixe vazio.\n\nTítulo: "${tituloAnuncio}"\nDescrição: "${(descricaoAnuncio || '').slice(0, 500)}"`
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

async function extrairTipoProduto(tituloAnuncio) {
  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `Do título do anúncio abaixo, extraia apenas o tipo/nome do produto (ex: "protetor de motor", "suporte GPS", "protetor de mão"). Responda APENAS com o tipo do produto, sem marca, sem modelo, sem ano, sem código.\n\nTítulo: "${tituloAnuncio}"`
        }],
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    return data.content[0].text.trim().toLowerCase();
  } catch {
    return '';
  }
}

function normalizar(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-\.\/\u00A0\u2013\u2014]/g, '');
}

function verificarModeloNaDescricao(descricaoLower, modelo) {
  const modeloNorm = normalizar(modelo);
  const descricaoNorm = normalizar(descricaoLower);

  console.log(`DEBUG modelo normalizado: "${modeloNorm}"`);
  console.log(`DEBUG descricao normalizada (150): "${descricaoNorm.slice(0, 150)}"`);

  if (descricaoNorm.includes(modeloNorm)) {
    console.log('Modelo encontrado por match direto');
    return true;
  }

  const numeroMatch = modeloNorm.match(/(\d+)/);
  if (numeroMatch) {
    const numero = numeroMatch[1];
    const prefixo = modeloNorm.replace(numero, '').replace(/[^a-z]/g, '');
    if (prefixo.length >= 2) {
      const prefixoNaDesc = descricaoNorm.includes(prefixo);
      const numeroNaDesc = descricaoLower.includes(numero);
      console.log(`Estrategia 2 — prefixo "${prefixo}": ${prefixoNaDesc}, numero "${numero}": ${numeroNaDesc}`);
      if (prefixoNaDesc && numeroNaDesc) return true;
    }
  }

  const tokens = modelo.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const tokensAgrupados = [];
  let acumulado = '';
  for (const t of tokens) {
    if (t.length <= 2) {
      acumulado += t;
    } else {
      tokensAgrupados.push(normalizar(acumulado + t));
      acumulado = '';
    }
  }
  if (acumulado) tokensAgrupados.push(normalizar(acumulado));

  const tokensSignificativos = tokensAgrupados.filter(t =>
    t.length >= 3 && !/^(e|de|da|do|na|no|em|ou|com)$/.test(t)
  );

  if (tokensSignificativos.length > 0) {
    const todosPresentes = tokensSignificativos.every(t => descricaoNorm.includes(t));
    console.log(`Tokens agrupados [${tokensSignificativos.join(', ')}]: ${todosPresentes}`);
    if (todosPresentes) return true;
  }

  return false;
}

function verificarAnoNaDescricao(descricaoLower, ano) {
  if (descricaoLower.includes(ano)) return true;
  const anoInt = parseInt(ano);

  for (const match of descricaoLower.matchAll(/a partir de (\d{4})/g)) {
    if (anoInt >= parseInt(match[1])) return true;
  }
  for (const match of descricaoLower.matchAll(/(\d{4})\+/g)) {
    if (anoInt >= parseInt(match[1])) return true;
  }
  for (const match of descricaoLower.matchAll(/(\d{4})-(\d{4})/g)) {
    if (anoInt >= parseInt(match[1]) && anoInt <= parseInt(match[2])) return true;
  }
  return false;
}

async function buscarEquivalenteNaLoja(tituloAnuncio, marca, modelo, ano, token) {
  try {
    const tipoProduto = await extrairTipoProduto(tituloAnuncio);
    console.log('Tipo de produto identificado:', tipoProduto);

    const respLista = await axios.get(
      `https://api.mercadolibre.com/users/${USER_ID}/items/search?status=active&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const total = respLista.data.paging?.total || 0;
    let todosIds = respLista.data.results || [];
    console.log(`Total de anuncios ativos: ${total}`);

    const maxOffset = Math.min(total, 1000);
    if (total > 50) {
      for (let offset = 50; offset < maxOffset; offset += 50) {
        try {
          const r = await axios.get(
            `https://api.mercadolibre.com/users/${USER_ID}/items/search?status=active&limit=50&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          todosIds = todosIds.concat(r.data.results || []);
        } catch (e) {
          console.log(`Erro offset ${offset}:`, e.message);
          break;
        }
      }
    }

    if (total > 1000) {
      try {
        const r1 = await axios.get(
          `https://api.mercadolibre.com/users/${USER_ID}/items/search?status=active&search_type=scan`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        let scrollId = r1.data.scroll_id;
        while (scrollId) {
          const r2 = await axios.get(
            `https://api.mercadolibre.com/users/${USER_ID}/items/search?status=active&search_type=scan&scroll_id=${scrollId}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const ids = r2.data.results || [];
          if (ids.length === 0) break;
          todosIds = todosIds.concat(ids);
          scrollId = r2.data.scroll_id || null;
        }
      } catch (e) {
        console.log('Erro no scroll:', e.message);
      }
    }

    if (todosIds.length === 0) return null;

    const modeloNorm = normalizar(modelo);
    const palavrasTipo = tipoProduto.split(' ').filter(p => p.length > 3);

    for (let i = 0; i < todosIds.length; i += 20) {
      const lote = todosIds.slice(i, i + 20);
      let itens;
      try {
        const resp = await axios.get(
          `https://api.mercadolibre.com/items?ids=${lote.join(',')}&attributes=id,title,permalink`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        itens = resp.data;
      } catch (e) {
        continue;
      }

      for (const entry of itens) {
        if (entry.code !== 200) continue;
        const item = entry.body;
        const tituloLower = item.title.toLowerCase();
        const tituloNorm = normalizar(tituloLower);

        if (!tituloNorm.includes(modeloNorm)) continue;

        const palavrasOk = palavrasTipo.filter(p => tituloLower.includes(p));
        const tipoOk = palavrasTipo.length < 2 || palavrasOk.length >= 2;
        if (!tipoOk) continue;

        const anoOk = tituloLower.includes(` ${ano}`) || tituloLower.includes(`${ano} `) ||
          tituloLower.endsWith(ano) || tituloLower.includes(`${ano}+`) ||
          tituloLower.includes(`${ano}-`);

        console.log(`  "${item.title}" | tipo:${tipoOk} ano:${anoOk}`);

        if (anoOk) {
          console.log(`Equivalente encontrado: ${item.title}`);
          return { titulo: item.title, link: item.permalink };
        }
      }
    }

    console.log('Nenhum equivalente encontrado.');
    return null;
  } catch (err) {
    console.error('Erro ao buscar equivalente:', err.response?.data || err.message);
    return null;
  }
}

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

  console.log(`Processando imediatamente (pergunta ${questionId})...`);

  const { data: item } = await axios.get(
    `https://api.mercadolibre.com/items/${question.item_id}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // Busca respostas anteriores para usar como exemplos de tom/estilo
  let exemplosRespostas = '';
  try {
    const { data: perguntasAnteriores } = await axios.get(
      `https://api.mercadolibre.com/questions/search?item_id=${question.item_id}&status=ANSWERED&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const exemplos = (perguntasAnteriores.questions || [])
      .filter(q => q.answer && q.id !== parseInt(questionId))
      .slice(0, 5)
      .map(q => `Pergunta: ${q.text}\nResposta: ${q.answer.text}`)
      .join('\n\n');
    if (exemplos) {
      exemplosRespostas = exemplos;
      console.log(`${(perguntasAnteriores.questions || []).filter(q => q.answer).length} respostas anteriores encontradas.`);
    }
  } catch (e) {
    console.log('Não foi possível obter respostas anteriores:', e.message);
  }

  // Busca descrição separadamente
  let descricaoCompleta = '';
  try {
    const { data: descData } = await axios.get(
      `https://api.mercadolibre.com/items/${question.item_id}/description`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    descricaoCompleta = descData.plain_text || descData.text || '';
    console.log(`Descricao obtida: ${descricaoCompleta.slice(0, 100)}...`);
  } catch (e) {
    console.log('Nao foi possivel obter descricao:', e.message);
  }
  item.description = descricaoCompleta || item.description || '';

  let variacoesTexto = 'Este produto nao possui variacoes cadastradas.';
  if (item.variations?.length > 0) {
    variacoesTexto = item.variations.map(v => {
      const combinacao = v.attribute_combinations?.map(ac => `${ac.name}: ${ac.value_name}`).join(', ') || 'Variacao sem nome';
      const estoque = v.available_quantity > 0 ? `${v.available_quantity} em estoque` : 'SEM ESTOQUE (esgotado)';
      return `- ${combinacao} -> ${estoque}`;
    }).join('\n');
  }

  const perguntaLower = question.text.toLowerCase();
  const ehCompatibilidade = [
    'serve', 'compativel', 'compatível', 'funciona', 'encaixa', 'fit',
    'pode ser usado', 'pode ser usada', 'usada com', 'usado com',
    'cabe', 'vai na', 'vai no', 'aplica', 'aplicar'
  ].some(p => perguntaLower.includes(p));

  // Extrai seção de compatibilidade da descrição
  const descricao = item.description || '';
  const secaoRegex = /(?:aplica(?:cao|ção) do produto|compatibilidade|modelos compat(?:i|í)veis)([\s\S]*?)(?:informa(?:co|ção)es do produto|c(?:o|ó)digo|garantia|descri(?:ca|ção)o|acompanha|fabricado|$)/i;
  const secaoMatch = descricao.match(secaoRegex);
  const aplicacaoTexto = secaoMatch ? secaoMatch[1].trim() : descricao.slice(0, 1000);
  console.log(`Secao de compatibilidade (${aplicacaoTexto.length} chars): ${aplicacaoTexto.slice(0, 150)}...`);

  let infoEquivalente = '';
  let dadosMotoIncompletos = '';
  let cambio = '';

  if (ehCompatibilidade) {
    const { data: extraido } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: `Extraia marca, modelo, ano e cambio da moto da seguinte pergunta. Responda APENAS em JSON no formato {"marca":"","modelo":"","ano":"","cambio":""} sem mais nada. Para cambio use "manual", "automatico" ou deixe vazio se nao mencionado.\n\nPergunta: "${question.text}"` }]
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    try {
      const textoExtraido = extraido.content[0].text.trim().replace(/```json|```/g, '').trim();
      console.log('Texto extraido da pergunta:', textoExtraido);
      let { marca, modelo, ano, cambio: cambioExtraido } = JSON.parse(textoExtraido);
      cambio = cambioExtraido || '';
      console.log(`Dados extraidos — marca: "${marca}", modelo: "${modelo}", ano: "${ano}", cambio: "${cambio}"`);

      if ((!modelo || !marca) && ano) {
        console.log('Modelo ou marca ausentes — buscando no anuncio...');
        const dadosAnuncio = await extrairDadosDoAnuncio(item.title, item.description);
        if (!modelo && dadosAnuncio.modelo) { modelo = dadosAnuncio.modelo; console.log(`Modelo extraido do anuncio: "${modelo}"`); }
        if (!marca && dadosAnuncio.marca) { marca = dadosAnuncio.marca; console.log(`Marca extraida do anuncio: "${marca}"`); }
      }

      console.log(`Dados finais — marca: "${marca}", modelo: "${modelo}", ano: "${ano}"`);

      if (!modelo) {
        dadosMotoIncompletos = 'FALTANDO_MODELO';
      } else if (!ano) {
        dadosMotoIncompletos = 'FALTANDO_ANO';
      } else {
        const descricaoLower = descricao.toLowerCase();
        // Busca na seção de compatibilidade extraída, com fallback para descrição completa
        const textoParaBusca = aplicacaoTexto || descricao;
        const textoParaBuscaLower = textoParaBusca.toLowerCase();

        const modeloNaDescricao = verificarModeloNaDescricao(textoParaBuscaLower, modelo);
        const anoNaDescricao = verificarAnoNaDescricao(textoParaBuscaLower, ano);

        console.log(`Compatibilidade na descricao — modelo: ${modeloNaDescricao}, ano: ${anoNaDescricao}`);

        if (modeloNaDescricao && anoNaDescricao) {
          console.log('Produto atual e compativel segundo a descricao.');
          infoEquivalente = '\n\nCOMPATIVEL: O produto deste anuncio e compativel com o modelo e ano informados pelo cliente, conforme a descricao do anuncio.';
        } else {
          console.log('Produto nao compativel — buscando equivalente...');
          const equivalente = await buscarEquivalenteNaLoja(item.title, marca || '', modelo, ano, token);
          if (equivalente) {
            infoEquivalente = `\n\nProduto equivalente compativel encontrado na loja:\nNome: ${equivalente.titulo}\nLink: ${equivalente.link}`;
            console.log('Equivalente encontrado:', equivalente.titulo);
          }
        }
      }
    } catch (err) {
      console.log('Erro ao processar dados da moto:', err.message);
    }
  }

  const prompt = `Você é um assistente de vendas do Mercado Livre. Responda a pergunta do cliente de forma simpática, clara e objetiva, com base nos dados do produto. Não invente informações que não estão nos dados.

Produto: ${item.title}
Aplicação do produto (modelos compatíveis — USE ISSO como fonte principal de compatibilidade, NÃO o título):
${aplicacaoTexto || 'Não disponível'}
Variações disponíveis e estoque:\n${variacoesTexto}
Contexto do atendimento: ${ehHorarioComercial ? 'HORÁRIO COMERCIAL (segunda a sexta, 09h às 18h) — há atendentes disponíveis agora' : 'FORA DO HORÁRIO COMERCIAL'}
Câmbio informado pelo cliente: ${cambio || 'não informado'}
Dados da moto incompletos: ${dadosMotoIncompletos || 'NENHUM — dados completos'}
${infoEquivalente}
${exemplosRespostas ? `\nExemplos de como o vendedor respondeu perguntas anteriores neste anúncio (use como referência de tom e estilo — NÃO copie as respostas):\n\n${exemplosRespostas}\n` : ''}
Pergunta do cliente: ${question.text}

Diretrizes:
- CRÍTICO: Escreva SOMENTE a mensagem final que será enviada ao cliente. NUNCA narre, resuma ou comente a pergunta em terceira pessoa (proibido: "o cliente menciona", "o cliente perguntou", "o cliente não informou", "com base na pergunta", etc). Você está falando DIRETAMENTE com o cliente, não descrevendo a situação para outra pessoa.
- Responda como um vendedor de loja física: direto, natural, sem enrolação
- Vá direto à informação pedida na primeira frase
- Se o cliente perguntar sobre cor/variação, confirme se existe E se tem estoque
- NÃO use bordões repetitivos — varie a forma de se expressar
- Se a informação não estiver nos dados, diga com transparência
- CASO ESPECIAL — dadosMotoIncompletos = FALTANDO_MODELO: responda APENAS pedindo o modelo específico, ex: "Nos informe o modelo de forma mais específica da sua moto?"
- CASO ESPECIAL — dadosMotoIncompletos = FALTANDO_ANO: responda APENAS pedindo o ano, ex: "Nos informe o ano de fabricação da sua moto para confirmarmos a compatibilidade?"
- CASO ESPECIAL — existe "COMPATIVEL" nos dados: o produto deste anúncio JÁ é compatível. Confirme de forma direta e positiva. NÃO adicione encaminhamento para atendente
- CASO ESPECIAL — existe "Produto equivalente compativel encontrado na loja": informe que esse produto não é compatível mas temos o equivalente disponível e inclua o link. NÃO adicione encaminhamento para atendente
- CASO ESPECIAL — incompatível e SEM equivalente: informe a incompatibilidade de forma direta e aplique a REGRA DE ENCAMINHAMENTO
- NUNCA sugira contato com fabricante, site externo ou qualquer canal fora do Mercado Livre
- REGRA DE ENCAMINHAMENTO: HORÁRIO COMERCIAL → "Por gentileza, entre em contato em breve que um atendente da loja poderá te ajudar melhor."; FORA DO COMERCIAL → "Por gentileza, entre em contato conosco em horário comercial, de segunda a sexta-feira, para um melhor auxílio."
- Máximo 3 frases. Sem saudações, sem markdown, sem emojis.

Responda em português do Brasil.`;

  const { data: aiResponse } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const respostaSugerida = aiResponse.content[0].text;
  console.log('Resposta sugerida (aguardando aprovacao por 30 min):', respostaSugerida);

  adicionarPendente({
    id: questionId,
    pergunta: question.text,
    produto: item.title,
    resposta: respostaSugerida,
    criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    expiraEm: new Date(Date.now() + TIMEOUT_APROVACAO_MS).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  });

  agendarAprovacaoAutomatica(questionId);
  console.log(`Resposta pendente — sera enviada automaticamente em 30 minutos (pergunta ${questionId}).`);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const { topic, resource } = req.body;
  console.log('Notificacao recebida:', topic, resource);
  if (topic !== 'questions') return;
  const questionId = resource.replace('/questions/', '');
  processarPergunta(questionId).catch(err => console.error('Erro:', err.response?.data || err.message));
});

app.get('/revisar', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const pendentes = getPendentes();
  const senha = req.query.senha;

  if (pendentes.length === 0) {
    return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revisão</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px;background:#f5f5f5}h1{color:#333}.vazio{background:#fff;padding:30px;border-radius:8px;text-align:center;color:#666}</style></head><body><h1>Revisão de Respostas</h1><div class="vazio">Nenhuma resposta pendente no momento.</div></body></html>`);
  }

  const cards = pendentes.map(p => `
    <div style="background:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,0.1)">
      <div style="font-size:12px;color:#999;margin-bottom:4px">${p.criadoEm} — Pergunta #${p.id}</div>
      <div style="font-size:12px;color:#f59e0b;margin-bottom:8px">Aprovação automática em: ${p.expiraEm}</div>
      <div style="font-size:13px;color:#555;margin-bottom:6px"><strong>Produto:</strong> ${p.produto}</div>
      <div style="background:#f0f4ff;padding:12px;border-radius:6px;margin-bottom:10px">
        <strong style="font-size:13px">Pergunta do cliente:</strong><br>
        <span style="font-size:15px">${p.pergunta}</span>
      </div>
      <form method="POST" action="/editar-e-aprovar?senha=${senha}">
        <input type="hidden" name="id" value="${p.id}">
        <div style="margin-bottom:10px">
          <strong style="font-size:13px">Resposta (editável):</strong><br>
          <textarea name="resposta" style="width:100%;min-height:100px;margin-top:6px;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;font-family:sans-serif;box-sizing:border-box">${p.resposta}</textarea>
        </div>
        <button type="submit" style="width:100%;padding:12px;background:#22c55e;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer">Aprovar e Enviar</button>
      </form>
      <form method="POST" action="/rejeitar?senha=${senha}" style="margin-top:8px">
        <input type="hidden" name="id" value="${p.id}">
        <button type="submit" style="width:100%;padding:12px;background:#ef4444;color:#fff;border:none;border-radius:6px;font-size:15px;cursor:pointer">Rejeitar (não enviar)</button>
      </form>
    </div>
  `).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revisão</title><style>body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:20px;background:#f5f5f5}h1{color:#333;margin-bottom:20px}</style></head><body><h1>Revisão de Respostas (${pendentes.length})</h1>${cards}</body></html>`);
});

app.post('/editar-e-aprovar', async (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const { id, resposta } = req.body;
  if (!id || !resposta) return res.status(400).send('Dados incompletos.');
  try {
    await enviarResposta(id, resposta);
    removerPendente(id);
    console.log(`Resposta aprovada e enviada manualmente (pergunta ${id}).`);
    res.redirect(`/revisar?senha=${req.query.senha}`);
  } catch (err) {
    res.send('Erro ao enviar: ' + JSON.stringify(err.response?.data || err.message));
  }
});

app.post('/rejeitar', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  removerPendente(req.body.id);
  console.log(`Resposta rejeitada (pergunta ${req.body.id}).`);
  res.redirect(`/revisar?senha=${req.query.senha}`);
});

app.get('/', (req, res) => res.send('Servidor ML AutoResponder online!'));

app.post('/setup-token', (req, res) => {
  const { senha, tokens } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  saveTokens(tokens);
  res.send('Token salvo com sucesso!');
});

app.get('/get-token', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const tokens = getTokens();
  if (!tokens) return res.status(404).send('Nenhum token encontrado.');
  res.json(tokens);
});

app.post('/forcar-pergunta', (req, res) => {
  const { senha, question_id } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  if (!question_id) return res.status(400).send('question_id obrigatorio.');
  setTimeout(async () => {
    try {
      await processarPergunta(question_id);
    } catch (err) {
      console.error(`Erro ao forcar pergunta ${question_id}:`, err.message);
    }
  }, 100);
  res.send(`Processando pergunta ${question_id}...`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
