const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { verifyPayment, create402Response } = require('./middleware/x402');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client with Realtime DISABLED - no WebSocket needed
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: { enabled: false }
  }
);

const MERCHANT_WALLET = process.env.MERCHANT_WALLET_ADDRESS;
const PRICE_PER_CALL_USDC = 0.01;

function generateApiKey() {
  return 'ag_' + Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 8);
}

app.post('/api/agents', async (req, res) => {
  const { userId, name } = req.body;
  
  if (!userId || !name) {
    return res.status(400).json({ error: 'userId and name required' });
  }
  
  const apiKey = generateApiKey();
  
  const { data, error } = await supabaseAdmin
    .from('agents')
    .insert([{ user_id: userId, name, api_key: apiKey, free_calls_remaining: 100 }])
    .select();
  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  res.json({ agent: data[0], apiKey });
});

app.post('/api/log', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const paymentTx = req.headers['x-payment-tx'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  
  const { data: agent, error } = await supabaseAdmin
    .from('agents')
    .select('id, free_calls_remaining')
    .eq('api_key', apiKey)
    .single();
  
  if (error || !agent) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  if (agent.free_calls_remaining > 0) {
    await supabaseAdmin
      .from('agents')
      .update({ free_calls_remaining: agent.free_calls_remaining - 1 })
      .eq('id', agent.id);
    
    const { action, prompt, response, tokens, latency_ms, cost_usd, success, error_message } = req.body;
    await supabaseAdmin.from('logs').insert([{
      agent_id: agent.id,
      action,
      prompt,
      response,
      tokens,
      latency_ms,
      cost_usd: cost_usd || 0,
      success: success !== false,
      error_message
    }]);
    
    return res.json({ success: true, message: 'Log recorded (free tier)', free_calls_remaining: agent.free_calls_remaining - 1 });
  }
  
  if (!paymentTx) {
    return res.status(402).json(create402Response(MERCHANT_WALLET, PRICE_PER_CALL_USDC));
  }
  
  const payment = await verifyPayment(paymentTx, PRICE_PER_CALL_USDC, MERCHANT_WALLET);
  
  if (!payment.valid) {
    return res.status(402).json({ error: 'Payment required or invalid', reason: payment.reason });
  }
  
  const { action, prompt, response, tokens, latency_ms, cost_usd, success, error_message } = req.body;
  
  await supabaseAdmin.from('logs').insert([{
    agent_id: agent.id,
    action,
    prompt,
    response,
    tokens,
    latency_ms,
    cost_usd: cost_usd || PRICE_PER_CALL_USDC,
    success: success !== false,
    error_message,
    payment_tx: paymentTx
  }]);
  
  res.json({ success: true, message: 'Log recorded (paid via x402)' });
});

app.get('/api/analytics/:agentId', async (req, res) => {
  const { agentId } = req.params;
  
  const { data, error } = await supabaseAdmin
    .from('logs')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1000);
  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  const totalCost = data.reduce((sum, log) => sum + (log.cost_usd || 0), 0);
  const totalTokens = data.reduce((sum, log) => sum + (log.tokens || 0), 0);
  const avgLatency = data.reduce((sum, log) => sum + (log.latency_ms || 0), 0) / (data.length || 1);
  const successRate = data.filter(log => log.success).length / (data.length || 1);
  
  res.json({
    logs: data,
    summary: {
      total_calls: data.length,
      total_cost_usd: totalCost,
      total_tokens: totalTokens,
      avg_latency_ms: avgLatency,
      success_rate: successRate
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'operational', protocol: 'x402 on BSC', merchant_wallet: MERCHANT_WALLET });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`AgentLog x402 API running on port ${PORT}`);
  console.log(`Merchant wallet: ${MERCHANT_WALLET}`);
  console.log(`Price per paid call: ${PRICE_PER_CALL_USDC} USDC`);
});