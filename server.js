// server.js - Complete Node.js server for Render.com
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// In-memory cache - persists as long as server runs
let dataCache = {
  pricingData: [],
  recallData: [],
  lastLoaded: null,
  loading: false
};

// Configuration from environment variables
const CONFIG = {
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  SHEET1_ID: process.env.SHEET1_ID || '1ckendKfB3_wH7EVJXm8SZ_yTywEryOnv5Zh7jJFzDbA',
  SHEET2_ID: process.env.SHEET2_ID || '1Z0QL8oH391LluePhkB3ojSPyNHkaoCT5UcWJC0ivims',
  DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '1Ea0rFiQbrkRVW_GjfNA8wcy7XJrKtTBj',
  CACHE_DURATION_MS: 3600000 // 1 hour
};

// Helper: Load Google Sheet
async function loadGoogleSheet(sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${CONFIG.GOOGLE_API_KEY}&includeGridData=true`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load sheet ${sheetId}: ${response.statusText}`);
  }
  return await response.json();
}

// Helper: Load recall PDFs
async function loadRecallPDFs() {
  const url = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_FOLDER_ID}'+in+parents&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name,mimeType)`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Drive files: ${response.statusText}`);
  }
  const data = await response.json();
  return (data.files || []).filter(f => f.mimeType === 'application/pdf');
}

// Helper: Parse sheet data
function parseSheetData(sheetData) {
  const records = [];
  const sheets = sheetData.sheets || [];
  
  for (const sheet of sheets) {
    const data = sheet.data?.[0]?.rowData || [];
    if (data.length < 2) continue;
    
    let headerRow = null;
    let headerIndex = -1;
    
    for (let i = 0; i < Math.min(5, data.length); i++) {
      const row = data[i];
      const values = row.values || [];
      const cellText = values.map(v => v.formattedValue || '').join('|').toLowerCase();
      if (cellText.includes('model') || cellText.includes('engine')) {
        headerRow = values.map(v => v.formattedValue || '');
        headerIndex = i;
        break;
      }
    }
    
    if (!headerRow) continue;
    
    for (let i = headerIndex + 1; i < data.length; i++) {
      const row = data[i];
      const values = row.values || [];
      const record = {};
      
      for (let j = 0; j < values.length && j < headerRow.length; j++) {
        const header = headerRow[j];
        const value = values[j]?.formattedValue || '';
        if (header && value) record[header] = value;
      }
      
      if (Object.keys(record).length > 2) records.push(record);
    }
  }
  
  return records;
}

// Load all data into cache
async function loadDataIntoCache() {
  if (dataCache.loading) return;
  
  dataCache.loading = true;
  console.log('Loading data into cache...');
  
  try {
    const [sheet1, sheet2, recalls] = await Promise.all([
      loadGoogleSheet(CONFIG.SHEET1_ID),
      loadGoogleSheet(CONFIG.SHEET2_ID),
      loadRecallPDFs()
    ]);
    
    dataCache.pricingData = [
      ...parseSheetData(sheet1),
      ...parseSheetData(sheet2)
    ];
    dataCache.recallData = recalls;
    dataCache.lastLoaded = Date.now();
    
    console.log(`✓ Cached ${dataCache.pricingData.length} pricing records and ${dataCache.recallData.length} recalls`);
  } catch (error) {
    console.error('Error loading data:', error);
    throw error;
  } finally {
    dataCache.loading = false;
  }
}

// Check if cache needs refresh
function needsCacheRefresh() {
  if (!dataCache.lastLoaded) return true;
  return (Date.now() - dataCache.lastLoaded) > CONFIG.CACHE_DURATION_MS;
}

// Smart local search - finds relevant records
function searchLocalData(query) {
  const queryLower = query.toLowerCase();
  const matches = [];
  
  for (const record of dataCache.pricingData) {
    const recordText = JSON.stringify(record).toLowerCase();
    const words = queryLower.split(' ').filter(w => w.length > 2);
    let score = 0;
    
    for (const word of words) {
      if (recordText.includes(word)) {
        score++;
      }
    }
    
    if (score >= 2) {
      matches.push({ record, score });
    }
  }
  
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5).map(m => m.record); // Top 5 matches
}

// Search recalls
function searchRecalls(query) {
  const queryLower = query.toLowerCase();
  return dataCache.recallData.filter(recall => {
    const recallLower = recall.name.toLowerCase();
    const words = queryLower.split(' ').filter(w => w.length > 2);
    return words.some(word => recallLower.includes(word));
  });
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    dataLoaded: dataCache.lastLoaded !== null,
    pricingRecords: dataCache.pricingData.length,
    recallDocuments: dataCache.recallData.length,
    lastLoaded: dataCache.lastLoaded ? new Date(dataCache.lastLoaded).toISOString() : null
  });
});

// Get cache status
app.get('/api/status', (req, res) => {
  res.json({
    ready: dataCache.pricingData.length > 0,
    pricingRecords: dataCache.pricingData.length,
    recallDocuments: dataCache.recallData.length,
    lastLoaded: dataCache.lastLoaded ? new Date(dataCache.lastLoaded).toISOString() : null,
    cacheAge: dataCache.lastLoaded ? Date.now() - dataCache.lastLoaded : null
  });
});

// Force reload data
app.post('/api/reload', async (req, res) => {
  try {
    await loadDataIntoCache();
    res.json({
      success: true,
      pricingRecords: dataCache.pricingData.length,
      recallDocuments: dataCache.recallData.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Main query endpoint
app.post('/api/query', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    // Refresh cache if needed
    if (needsCacheRefresh()) {
      console.log('Cache expired, refreshing...');
      await loadDataIntoCache();
    }
    
    // Check if it's a recall query
    const isRecallQuery = query.toLowerCase().includes('recall');
    
    if (isRecallQuery) {
      const relevantRecalls = searchRecalls(query);
      
      if (relevantRecalls.length === 0) {
        return res.json({
          answer: `No recall documents found matching "${query}".\n\nAvailable recalls:\n${dataCache.recallData.map(r => '• ' + r.name).join('\n')}`
        });
      }
      
      return res.json({
        answer: `📋 RECALL INFORMATION\n\nFound ${relevantRecalls.length} relevant document(s):\n\n${relevantRecalls.map(r => `• ${r.name}`).join('\n')}\n\n⚠️ Please open the PDF from Google Drive for full details.`
      });
    }
    
    // Pricing query - search locally first
    const relevantRecords = searchLocalData(query);
    
    if (relevantRecords.length === 0) {
      return res.json({
        answer: `No pricing data found for "${query}".\n\nTry searching with: brand + model + service type\nExample: "MG HS major service" or "Citroen C3 interim service"`
      });
    }
    
    // Send ONLY relevant records to Claude (not all data!)
    const anthropic = new Anthropic({ apiKey: CONFIG.CLAUDE_API_KEY });
    
    const prompt = `You are a call centre assistant helping operators find service pricing.

CUSTOMER QUERY: "${query}"

RELEVANT PRICING DATA (${relevantRecords.length} records found):
${JSON.stringify(relevantRecords, null, 2)}

INSTRUCTIONS:
1. Identify the vehicle model, engine type, and any age/mileage mentioned
2. If age and mileage are mentioned, provide BOTH service options:
   - TIME-BASED: Annual service by years (if available in "1 Year", "2 Years", etc columns)
   - MILEAGE-BASED: Standard service by mileage (if available in "15,000", "30,000", etc columns)
3. Explain which interval they're closest to and why
4. Present prices clearly with service type names
5. If multiple service types exist (Interim/Main/Major), explain briefly

FORMAT YOUR RESPONSE LIKE THIS:

🚗 VEHICLE: [Model and Engine]
───────────────────────

[If age/mileage provided:]
⏰ TIME-BASED SERVICE OPTIONS:
  • [X] year service: £[price] [← CLOSEST if applicable]
  
🛣️ MILEAGE-BASED SERVICE OPTIONS:
  • [X],000 mile service: £[price] [← CLOSEST if applicable]

💡 RECOMMENDATION:
[Brief 1-2 sentence recommendation on which to choose based on the specific age/mileage]

Be concise, professional, and always cite specific prices from the data.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const answer = message.content[0].text;
    
    res.json({ answer });
    
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ 
      error: error.message,
      type: error.type || 'unknown'
    });
  }
});

// Start server and load initial data
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✓ Server running on port ${PORT}`);
  
  // Load data on startup
  try {
    await loadDataIntoCache();
    console.log('✓ Initial data load complete');
    
    // Set up periodic refresh (every hour)
    setInterval(async () => {
      if (needsCacheRefresh()) {
        console.log('Auto-refreshing cache...');
        try {
          await loadDataIntoCache();
        } catch (error) {
          console.error('Auto-refresh failed:', error);
        }
      }
    }, 300000); // Check every 5 minutes
    
  } catch (error) {
    console.error('Failed to load initial data:', error);
  }
});
