require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

// ─── Utilitário: lê tokens salvos ───────────────────────────────────────────
function getTokens() {
  if (!fs.existsSync('tokens.json')) return null;
  return JSON.parse(fs.readFileSync('tokens.json'));
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

  fs.writeFileSync('tokens.json', JSON.stringify(response.data, null, 2));
  console.log('Token renovado com sucesso.');
  return response.data.access_token;
}

// ─── Utilitário: retorna access_token válido ─────────────────────────────────
async function getValidToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('Faça a autenticação primeiro.');
  // Tenta usar o token atual; se falhar, renova
  return tokens.access_token;
}

// ─── Webhook: recebe notificações do ML ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediato para o ML não reenviar

  const { topic, resource } = req.body;
  console.log('Notificação recebida:', topic, resource);

  if (topic !== 'questions') return;

  try {
    const token = await getValidToken();

    // 1. Busca os dados da pergunta
    const questionId = resource.replace('/questions/', '');
    const { data: question } = await axios.get(
      `https://api.mercadolibre.com/questions/${questionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (question.status !== 'UNANSWERED') return;
    console.log('Pergunta:', question.text);

    // 2. Busca os dados do produto
    const { data: item } = await axios.get(
      `https://api.mercadolibre.com/items/${question.item_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // 3. Chama o Claude para gerar a resposta
    const prompt = `Você é um assistente de vendas do Mercado Livre. Responda a pergunta do cliente de forma simpática, clara e objetiva, com base nos dados do produto. Não invente informações que não estão nos dados.

Produto: ${item.title}
Descrição: ${item.description || 'Não disponível'}
Atributos: ${JSON.stringify(item.attributes?.slice(0, 10))}

Pergunta do cliente: ${question.text}

Responda em português, de forma curta e direta.`;

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
    // Se token expirou, renova e tenta de novo
    if (err.response?.status === 401) {
      await refreshAccessToken();
    }
  }
});

// ─── Rota de saúde (o Render exige isso) ────────────────────────────────────
app.get('/', (req, res) => res.send('Servidor ML AutoResponder online!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));