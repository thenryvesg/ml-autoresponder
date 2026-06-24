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
const SITE_ID = 'MLB';

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

// ─── Extrai marca e modelo do anúncio via Claude ──────────────────────────────
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

// ─── Extrai tipo de produto do título via Claude ──────────────────────────────
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

// ─── Busca anúncio equivalente nos anúncios do vendedor ──────────────────────
async function buscarEquivalenteNaLoja(tituloAnuncio, marca, modelo, ano, token) {
  try {
    const tipoProduto = await extrairTipoProduto(tituloAnuncio);
    console.log('Tipo de produto identificado:', tipoProduto);

    // Busca primeira página de anúncios ativos
    const respLista = await axios.get(
      `https://api.mercadolibre.com/users/${USER_ID}/items/search?status=active&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const total = respLista.data.paging?.total || 0;
    let todosIds = respLista.data.results || [];
    console.log(`Total de anúncios ativos: ${total}, primeira página: ${todosIds.length}`);

    // Busca páginas adicionais — limite máximo de offset é 1000
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
          console.log(`Erro ao buscar offset ${offset}:`, e.message);
          break;
        }
      }
    }
    // Se tem mais de 1000 anúncios, usa scroll para buscar o restante
    if (total > 1000) {
      try {
        let scrollId = null;
        const r1 = await axios.get(
          `https://api.mercadolibre.com/users/${USER_ID}/items/search?status=active&search_type=scan`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        scrollId = r1.data.scroll_id;
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

    // Normaliza modelo removendo espaços e hífens
    const modeloNorm = modelo.toLowerCase().replace(/[\s\-]/g, '');
    const palavrasTipo = tipoProduto.split(' ').filter(p => p.length > 3);

    // Busca títulos via multiget em lotes de 20 — percorre TODOS os anúncios
    let equivalenteEncontrado = null;
    for (let i = 0; i < todosIds.length && !equivalenteEncontrado; i += 20) {
      const lote = todosIds.slice(i, i + 20);
      let itens;
      try {
        const resp = await axios.get(
          `https://api.mercadolibre.com/items?ids=${lote.join(',')}&attributes=id,title,permalink`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        itens = resp.data;
      } catch (e) {
        console.log(`Erro ao buscar lote ${i}-${i+20}:`, e.message);
        continue;
      }

      for (const entry of itens) {
        if (entry.code !== 200) continue;
        const item = entry.body;
        const tituloLower = item.title.toLowerCase();
        const tituloNorm = tituloLower.replace(/[\s\-]/g, '');

        // Verifica modelo (normalizado)
        const modeloOk = tituloNorm.includes(modeloNorm);
        if (!modeloOk) continue;

        // Verifica tipo de produto (pelo menos 2 palavras significativas)
        const palavrasOk = palavrasTipo.filter(p => tituloLower.includes(p));
        const tipoOk = palavrasTipo.length < 2 || palavrasOk.length >= 2;
        if (!tipoOk) continue;

        // Verifica ano separado no título (com espaço ao redor)
        const anoOk = tituloLower.includes(` ${ano}`) || tituloLower.includes(`${ano} `) ||
                      tituloLower.endsWith(ano) || tituloLower.includes(`${ano}+`) ||
                      tituloLower.includes(`${ano}-`);

        console.log(`  "${item.title}" | modelo:${modeloOk} tipo:${tipoOk} ano:${anoOk}`);

        if (anoOk) {
          equivalenteEncontrado = { titulo: item.title, link: item.permalink };
          break;
        }
      }
    }

    if (equivalenteEncontrado) {
      console.log(`Equivalente encontrado: ${equivalenteEncontrado.titulo}`);
      return equivalenteEncontrado;
    }

    console.log('Nenhum equivalente encontrado com ano no título.');
    return null;
  } catch (err) {
    console.error('Erro ao buscar equivalente na loja:', err.response?.data || err.message);
    return null;
  }
}

// ─── Função principal de processamento ───────────────────────────────────────
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
  let cambio = '';

  if (ehCompatibilidade) {
    const { data: extraido } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: `Extraia marca, modelo, ano e câmbio da moto da seguinte pergunta. Responda APENAS em JSON no formato {"marca":"","modelo":"","ano":"","cambio":""} sem mais nada. Para câmbio use "manual", "automatico" ou deixe vazio se não mencionado.\n\nPergunta: "${question.text}"` }]
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    try {
      const textoExtraido = extraido.content[0].text.trim().replace(/```json|```/g, '').trim();
      console.log('Texto extraído da pergunta:', textoExtraido);
      let { marca, modelo, ano, cambio: cambioExtraido } = JSON.parse(textoExtraido);
      cambio = cambioExtraido || '';
      console.log(`Dados extraídos — marca: "${marca}", modelo: "${modelo}", ano: "${ano}", câmbio: "${cambio}"`);

      if ((!modelo || !marca) && ano) {
        console.log('Modelo ou marca ausentes — buscando no anúncio...');
        const dadosAnuncio = await extrairDadosDoAnuncio(item.title, item.description);
        if (!modelo && dadosAnuncio.modelo) { modelo = dadosAnuncio.modelo; console.log(`Modelo extraído do anúncio: "${modelo}"`); }
        if (!marca && dadosAnuncio.marca) { marca = dadosAnuncio.marca; console.log(`Marca extraída do anúncio: "${marca}"`); }
      }

      console.log(`Dados finais — marca: "${marca}", modelo: "${modelo}", ano: "${ano}"`);

      if (!modelo) {
        dadosMotoIncompletos = 'FALTANDO_MODELO';
      } else if (!ano) {
        dadosMotoIncompletos = 'FALTANDO_ANO';
      } else {
        const equivalente = await buscarEquivalenteNaLoja(item.title, marca || '', modelo, ano, token);
        if (equivalente) {
          infoEquivalente = `\n\nProduto equivalente compatível encontrado na loja:\nNome: ${equivalente.titulo}\nLink: ${equivalente.link}`;
          console.log('Equivalente encontrado:', equivalente.titulo);
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
Câmbio informado pelo cliente: ${cambio || 'não informado'}
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
- CASO ESPECIAL — existe "Produto equivalente compatível encontrado na loja": informe que esse produto não é compatível mas temos o modelo equivalente disponível e inclua o link do anúncio. NÃO adicione o encaminhamento de especialista nesse caso — o link já é suficiente
- CASO ESPECIAL — incompatível e SEM equivalente: informe a incompatibilidade de forma direta e aplique a REGRA DE ENCAMINHAMENTO
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

  if (ehHorarioComercial) {
    // Horário comercial: salva para revisão manual
    console.log('Resposta sugerida (aguardando aprovação):', respostaSugerida);
    adicionarPendente({
      id: questionId,
      pergunta: question.text,
      produto: item.title,
      resposta: respostaSugerida,
      criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    });
    console.log(`Resposta pendente salva para revisão (pergunta ${questionId}).`);
  } else {
    // Fora do horário comercial: envia direto sem revisão
    console.log('Fora do horário comercial — enviando resposta automaticamente:', respostaSugerida);
    let token2 = await getValidToken();
    try {
      await axios.post(
        'https://api.mercadolibre.com/answers',
        { question_id: parseInt(questionId), text: respostaSugerida },
        { headers: { Authorization: `Bearer ${token2}` } }
      );
      console.log(`Resposta enviada automaticamente (pergunta ${questionId}).`);
    } catch (err) {
      if (err.response?.status === 401) {
        token2 = await refreshAccessToken();
        await axios.post(
          'https://api.mercadolibre.com/answers',
          { question_id: parseInt(questionId), text: respostaSugerida },
          { headers: { Authorization: `Bearer ${token2}` } }
        );
        console.log(`Resposta enviada automaticamente após renovação (pergunta ${questionId}).`);
      } else throw err;
    }
  }
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

// ─── Aprovar ──────────────────────────────────────────────────────────────────
app.post('/aprovar', async (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const { id } = req.body;
  const pendente = getPendentes().find(p => p.id === id);
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
    res.send('Erro ao enviar: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// ─── Rejeitar ─────────────────────────────────────────────────────────────────
app.post('/rejeitar', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  removerPendente(req.body.id);
  console.log(`Resposta rejeitada (pergunta ${req.body.id}).`);
  res.redirect(`/revisar?senha=${req.query.senha}`);
});

// ─── Rota de saúde ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Servidor ML AutoResponder online!'));

// ─── Setup token ─────────────────────────────────────────────────────────────
app.post('/setup-token', (req, res) => {
  const { senha, tokens } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  saveTokens(tokens);
  res.send('Token salvo com sucesso!');
});

// ─── Get token ───────────────────────────────────────────────────────────────
app.get('/get-token', (req, res) => {
  if (req.query.senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  const tokens = getTokens();
  if (!tokens) return res.status(404).send('Nenhum token encontrado.');
  res.json(tokens);
});

// ─── Forçar pergunta ─────────────────────────────────────────────────────────
app.post('/forcar-pergunta', (req, res) => {
  const { senha, question_id } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) return res.status(401).send('Senha incorreta.');
  if (!question_id) return res.status(400).send('question_id obrigatório.');
  const originalDelay = process.env.DELAY_ATIVO;
  process.env.DELAY_ATIVO = 'false';
  setTimeout(async () => {
    try {
      await processarPergunta(question_id);
    } catch (err) {
      console.error(`Erro ao forçar pergunta ${question_id}:`, err.message);
    } finally {
      process.env.DELAY_ATIVO = originalDelay;
    }
  }, 100);
  res.send(`Processando pergunta ${question_id}...`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
