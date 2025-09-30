const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { query, pricingData, recallData } = req.body;

    // Initialize Anthropic client
    const anthropic = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });

    // Prepare context
    const pricingContext = JSON.stringify(pricingData.slice(0, 150));
    const recallContext = recallData.map(r => r.name).join(', ');

    const prompt = `You are a call centre assistant helping operators find service pricing and recall information.

AVAILABLE DATA:
1. Pricing data: ${pricingData.length} records
2. Recall documents: ${recallContext}

PRICING DATA:
${pricingContext}

CUSTOMER QUERY: "${query}"

INSTRUCTIONS:
- If asking about SERVICE PRICING:
  * Identify vehicle model, engine, service type
  * If age/mileage mentioned, provide BOTH:
    a) Time-based (Annual service by years)
    b) Mileage-based (Standard service by mileage)
  * Explain which interval they're closest to
  * Present prices clearly
  * Explain service types (Interim/Main/Major) if relevant

- If asking about RECALLS:
  * Match vehicle model to recall documents
  * List relevant PDFs by name
  * Tell operator to check the specific document
  * If none found, state clearly

- Be concise, professional, friendly
- Always cite source data
- If unsure, say so clearly

IMPORTANT: Present pricing in a clear format with both time-based and mileage-based options when relevant.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const answer = message.content[0].text;

    return res.status(200).json({ answer });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: error.message || 'Internal server error' 
    });
  }
};
