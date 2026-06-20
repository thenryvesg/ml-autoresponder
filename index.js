require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Caminho do arquivo de tokens:
// - No Render, usamos o disco persistente montado em /data (configurado no painel)
// - Localmente, usamos a própria pasta do projeto
const TOKENS_PATH = process.env.RENDER
  ? path.join('/data', 'tokens.json')
  : path.join(__dirname, 'tokens.json');

// ─── Utilitário: lê tokens salvos ───────────────────────────────────────────
function getTokens() {
  if (fs.existsSync(TOKENS_PATH)) {
    return JSON.parse(fs.readFileSync(TOKENS_PATH));
  }
  // Fallback: se ainda não existir no disco, tenta a variável de ambiente
  // (útil só na primeira vez, antes do disco ser populado)
  if (process.env.ML_TOKENS) {
    return JSON.parse(process.env.ML_TOKENS);
  }
  return null;
}

// ─── Utilitário: salva tokens no disco persistente ──────────────────────────
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  console.log('Tokens salvos em', TOKENS_PATH);
}

// ─── Utilitário: renova o access_token automaticamente ──────────────────────
async function refreshAccessToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('Nenhum token salvo. Faça a autenticação primeiro.');

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

// ─── Utilitário: retorna access_token válido ─────────────────────────────────
async function getValidToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('Faça a autenticação primeiro.');
  return tokens.access_token;
}

// ─── Webhook: recebe notificações do ML ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediato para o ML não reenviar

  const { topic, resource } = req.body;
  console.log('Notificação recebida:', topic, resource);

  if (topic !== 'questions') return;

  try {
    let token = await getValidToken();

    // 1. Busca os dados da pergunta
    const questionId = resource.replace('/questions/', '');
    let question;
    try {
      const resp = await axios.get(
        `https://api.mercadolibre.com/questions/${questionId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      question = resp.data;
    } catch (err) {
      if (err.response?.status === 401) {
        token = await refreshAccessToken();
        const resp = await axios.get(
          `https://api.mercadolibre.com/questions/${questionId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        question = resp.data;
      } else {
        throw err;
      }
    }

    if (question.status !== 'UNANSWERED') return;
    console.log('Pergunta:', question.text);

    // 2. Busca os dados do produto
    const { data: item } = await axios.get(
      `https://api.mercadolibre.com/items/${question.item_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // 2.1 Monta um resumo legível das variações (cor/tamanho) com estoque de cada uma
    let variacoesTexto = 'Este produto não possui variações cadastradas.';
    if (item.variations && item.variations.length > 0) {
      variacoesTexto = item.variations.map(v => {
        const combinacao = v.attribute_combinations
          ?.map(ac => `${ac.name}: ${ac.value_name}`)
          .join(', ') || 'Variação sem nome';
        const estoque = v.available_quantity > 0
          ? `${v.available_quantity} em estoque`
          : 'SEM ESTOQUE (esgotado)';
        return `- ${combinacao} → ${estoque}`;
      }).join('\n');
    }

    // 3. Chama o Claude para gerar a resposta
    const prompt = `Você é um assistente de vendas do Mercado Livre. Responda a pergunta do cliente de forma simpática, clara e objetiva, com base nos dados do produto. Não invente informações que não estão nos dados.

Produto: ${item.title}
Descrição: ${item.description || 'Não disponível'}
Atributos: ${JSON.stringify(item.attributes?.slice(0, 10))}

Variações disponíveis e estoque:
${variacoesTexto}

Pergunta do cliente: ${question.text}

Diretrizes para a resposta:
- Responda como um vendedor de loja física responderia um cliente no balcão: direto, natural, sem enrolação
- Vá direto à informação pedida na primeira frase — sem preâmbulo, sem repetir a pergunta do cliente
- Se o cliente perguntar sobre uma cor/variação específica, confirme se ela existe E se tem estoque disponível — uma variação "sem estoque" deve ser tratada como indisponível no momento, não como disponível
- Se a variação perguntada estiver sem estoque, informe isso e, só se fizer sentido, mencione rapidamente a alternativa disponível — sem transformar isso em um discurso de venda
- NÃO use frases de efeito repetitivas tipo "é a única opção cadastrada", "fabricado no Brasil com qualidade garantida", ou qualquer bordão fixo — varie a forma de se expressar a cada resposta, como uma pessoa real faria
- Mencione um diferencial do produto apenas se for realmente relevante para a pergunta feita — não force isso em toda resposta
- Se a informação perguntada não estiver nos dados do produto, diga isso com transparência, sem rodeios
- CASO ESPECIAL — pergunta de compatibilidade incompleta: se o cliente perguntar se o produto "serve" ou é "compatível" com um veículo mencionando só a marca e/ou o ano, sem citar o modelo exato (ex: "serve na KTM 2021?", "serve na Honda 2022?"), NÃO tente adivinhar nem responda de forma genérica. Apenas peça educadamente que ele informe o modelo específico da moto, de forma simples e direta, por exemplo: "Por gentileza, nos informe o modelo de forma mais específica da sua moto?". Nunca diga para o cliente "perguntar no campo de perguntas" — ele já está nesse campo
- CASO ESPECIAL — modelo informado não consta na descrição: se o cliente já informou o modelo específico (marca + modelo, ex: "Drag Star 650") e esse modelo NÃO aparece nos dados do produto como compatível, responda de forma direta e definitiva que o produto não é compatível com aquele modelo. NUNCA sugira "verificar com o fabricante", "entrar em contato com o fabricante" ou qualquer encaminhamento externo — essa informação não deve ser dada
- Máximo de 2-3 frases curtas — quanto mais direto, melhor
- Não use saudações tipo "Olá" ou assinaturas — vá direto na resposta
- Não use markdown (sem asteriscos, sem negrito) nem emojis — o campo de resposta do ML não renderiza formatação

Responda em português do Brasil.`;

    const { data: aiResponse } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const resposta = aiResponse.content[0].text;
    console.log('Resposta gerada:', resposta);

    // 4. Posta a resposta no ML
    await axios.post(
      'https://api.mercadolibre.com/answers',
      { question_id: question.id, text: resposta },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('Resposta enviada com sucesso!');
  } catch (err) {
    console.error('Erro:', err.response?.data || err.message);
  }
});

// ─── Rota de saúde (o Render exige isso) ────────────────────────────────────
app.get('/', (req, res) => res.send('Servidor ML AutoResponder online!'));

// ─── Rota para popular/atualizar o token manualmente (protegida por senha simples) ──
// Use apenas uma vez para inicializar o disco persistente, ou se precisar forçar uma atualização manual
app.post('/setup-token', (req, res) => {
  const { senha, tokens } = req.body;
  if (senha !== process.env.SETUP_PASSWORD) {
    return res.status(401).send('Senha incorreta.');
  }
  saveTokens(tokens);
  res.send('Token salvo com sucesso no disco persistente!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));