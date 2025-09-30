// server.js - MEMORY OPTIMIZED VERSION for Render.com
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Minimal memory cache - only essential data
let dataCache = {
  pricingData: [],
  recallData: [],
  lastLoaded: null,
  loading: false
};

// Response cache to reduce API calls
const responseCache = new Map();
const RESPONSE_CACHE_DURATION = 3600000; // 1 hour

const CONFIG = {
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  SHEET1_ID: process.env.SHEET1_ID || '1ckendKfB3_wH7EVJXm8SZ_yTywEryOnv5Zh7jJFzDbA',
  SHEET2_ID: process.env.SHEET2_ID || '1Z0QL8oH391LluePhkB3ojSPyNHkaoCT5UcWJC0ivims',
  DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || '1Ea0rFiQbrkRVW_GjfNA8wcy7XJrKtTBj',
  CACHE_DURATION_MS: 3600000
};

// Helper: Load Google Sheet - MEMORY EFFICIENT
async function loadGoogleSheet(sheetId) {
  // Use values API instead of includeGridData to save memory
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?ranges=A:AZ&key=${CONFIG.GOOGLE_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load sheet ${sheetId}: ${response.statusText}`);
  }
  return await response.json();
}

// Helper: Load recall PDFs
async function loadRecallPDFs() {
  const url = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_FOLDER_ID}'+in+parents&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name)`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Drive files: ${response.statusText}`);
  }
  const data = await response.json();
  return (data.files || [])
    .filter(f => f.name && f.name.toLowerCase().endsWith('.pdf'))
    .map(f => ({ name: f.name })); // Only store name, not full object
}

// Helper: Parse sheet data - MINIMAL MEMORY
function parseSheetData(sheetData) {
  const records = [];
  const valueRanges = sheetData.valueRanges || [];
  
  for (const range of valueRanges) {
    const rows = range.values || [];
    if (rows.length < 2) continue;
    
    let headerRow = null;
    let headerIndex = -1;
    
    // Find header row
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const rowText = rows[i].join('|').toLowerCase();
      if (rowText.includes('model') || rowText.includes('engine')) {
        headerRow = rows[i];
        headerIndex = i;
        break;
      }
    }
    
    if (!headerRow) continue;
    
    // Parse data rows - only keep non-empty values
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      
      const record = {};
      let hasData = false;
      
      for (let j = 0; j < Math.min(row.length, headerRow.length); j++) {
        const header = headerRow[j];
        const value = row[j];
        
        // Only store non-empty values to save memory
        if (header && value && value.trim()) {
          record[header] = value.trim();
          hasData = true;
        }
      }
      
      // Only add records with meaningful data
      if (hasData && record.Model) {
        records.push(record);
      }
    }
  }
  
  return records;
}

// Load data with memory optimization
async function loadDataIntoCache() {
  if (dataCache.loading) return;
  
  dataCache.loading = true;
  console.log('Loading data (memory optimized)...');
  
  try {
    // Load sequentially to avoid memory spikes
    console.log('Loading sheet 1...');
    const sheet1 = await loadGoogleSheet(CONFIG.SHEET1_ID);
    const pricing1 = parseSheetData(sheet1);
    
    console.log('Loading sheet 2...');
    const sheet2 = await loadGoogleSheet(CONFIG.SHEET2_ID);
    const pricing2 = parseSheetData(sheet2);
    
    console.log('Loading recalls...');
    const recalls = await loadRecallPDFs();
    
    // Combine and deduplicate
    dataCache.pricingData = [...pricing1, ...pricing2];
    dataCache.recallData = recalls;
    dataCache.lastLoaded = Date.now();
    
    console.log(`✓ Cached ${dataCache.pricingData.length} records, ${dataCache.recallData.length} recalls`);
    console.log(`Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    
  } catch (error) {
    console.error('Error loading data:', error);
    throw error;
  } finally {
    dataCache.loading = false;
  }
}

function needsCacheRefresh() {
  if (!dataCache.lastLoaded) return true;
  return (Date.now() - dataCache.lastLoaded) > CONFIG.CACHE_DURATION_MS;
}

// Response caching functions
function getCachedResponse(query) {
  const key = query.toLowerCase().trim();
  const cached = responseCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < RESPONSE_CACHE_DURATION) {
    console.log('Using cached response');
    return cached.answer;
  }
  return null;
}

function cacheResponse(query, answer) {
  const key = query.toLowerCase().trim();
  responseCache.set(key, { answer, timestamp: Date.now() });
  
  // Keep response cache small
  if (responseCache.size > 100) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

// Smart local search
function searchLocalData(query) {
  const queryLower = query.toLowerCase();
  const matches = [];
  
  for (const record of dataCache.pricingData) {
    let score = 0;
    const recordText = JSON.stringify(record).toLowerCase();
    const words = queryLower.split(' ').filter(w => w.length > 2);
    
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
  return matches.slice(0, 3).map(m => m.record); // Only top 3
}

function searchRecalls(query) {
  const queryLower = query.toLowerCase();
  return dataCache.recallData.filter(recall => {
    const recallLower = recall.name.toLowerCase();
    const words = queryLower.split(' ').filter(w => w.length > 2);
    return words.some(word => recallLower.includes(word));
  });
}

// API Routes
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    dataLoaded: dataCache.lastLoaded !== null,
    pricingRecords: dataCache.pricingData.length,
    recallDocuments: dataCache.recallData.length,
    memory: {
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
    },
    lastLoaded: dataCache.lastLoaded ? new Date(dataCache.lastLoaded).toISOString() : null
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ready: dataCache.pricingData.length > 0,
    pricingRecords: dataCache.pricingData.length,
    recallDocuments: dataCache.recallData.length,
    lastLoaded: dataCache.lastLoaded ? new Date(dataCache.lastLoaded).toISOString() : null
  });
});

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

app.post('/api/query', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    // Check response cache first
    const cachedAnswer = getCachedResponse(query);
    if (cachedAnswer) {
      return res.json({ answer: cachedAnswer });
    }
    
    // Refresh data if needed
    if (needsCacheRefresh()) {
      console.log('Cache expired, refreshing...');
      await loadDataIntoCache();
    }
    
    // Check if recall query
    const isRecallQuery = query.toLowerCase().includes('recall');
    
    if (isRecallQuery) {
      const relevantRecalls = searchRecalls(query);
      
      const answer = relevantRecalls.length === 0
        ? `No recall documents found for "${query}".`
        : `📋 RECALL INFORMATION\n\nFound ${relevantRecalls.length} document(s):\n\n${relevantRecalls.map(r => `• ${r.name}`).join('\n')}\n\n⚠️ Open the PDF from Google Drive for full details.`;
      
      cacheResponse(query, answer);
      return res.json({ answer });
    }
    
    // Pricing query
    const relevantRecords = searchLocalData(query);
    
    if (relevantRecords.length === 0) {
      return res.json({
        answer: `No pricing data found for "${query}".\n\nTry: brand + model + service type\nExample: "MG HS major service"`
      });
    }
    
    // Send minimal data to Claude - only essential fields
    const minimalRecords = relevantRecords.map(r => {
      const minimal = { Model: r.Model };
      if (r.Engine) minimal.Engine = r.Engine;
      
      // Time-based services
      ['1 Year', '2 Years', '3 Years', '4 Years', '5 Years', '6 Years'].forEach(key => {
        if (r[key]) minimal[key] = r[key];
      });
      
      // Mileage-based services
      ['15,000', '30,000', '45,000', '60,000', '75,000', '90,000'].forEach(key => {
        if (r[key]) minimal[key] = r[key];
      });
      
      // Service types
      ['Interim Service', 'Main Service', 'Major Service'].forEach(key => {
        if (r[key]) minimal[key] = r[key];
      });
      
      return minimal;
    });
    
    const anthropic = new Anthropic({ apiKey: CONFIG.CLAUDE_API_KEY });
    
    // Concise prompt to save tokens
    const prompt = `Query: "${query}"\n\nData:\n${JSON.stringify(minimalRecords)}\n\nProvide service pricing with:\n- Time-based (years) if available\n- Mileage-based if available\n- Brief recommendation\n\nBe concise.`;
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const answer = message.content[0].text;
    cacheResponse(query, answer);
    
    res.json({ answer });
    
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ 
      error: error.message,
      type: error.type || 'unknown'
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`Memory at start: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  
  try {
    await loadDataIntoCache();
    console.log('✓ Initial data load complete');
    
    // Periodic refresh check
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
