/**
 * ============================================================
 * AURUM — fetch.js
 * Data pipeline: fetch all sources → normalise → write Gist
 * Run by GitHub Actions on a schedule (every 15 min, weekdays)
 * ============================================================
 *
 * Environment variables required (set as GitHub Secrets + Netlify env vars):
 *   ALPHA_VANTAGE_KEY   — alphavantage.co free key (25 req/day)
 *   FRED_KEY            — fred.stlouisfed.org free key (120 req/min)
 *   NEWS_API_KEY        — newsapi.org free key (100 req/day)
 *   METALS_DEV_KEY      — metals.dev free key (100 req/month)
 *   COINGECKO_KEY       — coingecko.com demo key (30 calls/min)
 *   GIST_ID             — GitHub Gist ID where aurum-data.json lives
 *   GIST_TOKEN          — GitHub personal access token (gist scope only)
 *
 * Usage:
 *   node fetch.js
 *
 * Output:
 *   Writes aurum-data.json to the GitHub Gist at GIST_ID.
 *   The dashboard reads this Gist on page load.
 */

'use strict';

// ── DEPENDENCIES ────────────────────────────────────────────────────────────
// All standard Node.js built-ins + one fetch polyfill for Node < 18
// If running Node 18+, native fetch is available — no polyfill needed.
const https = require('https');
const fs = require('fs/promises');
const path = require('path');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  alphavantage: process.env.ALPHA_VANTAGE_KEY,
  fred:         process.env.FRED_KEY,
  newsapi:      process.env.NEWS_API_KEY,
  metalsdev:    process.env.METALS_DEV_KEY,
  coingecko:    process.env.COINGECKO_KEY,
  gistId:       process.env.GIST_ID,
  gistToken:    process.env.GIST_TOKEN,
};

const DRY_RUN = process.argv.includes('--dry-run');

// How many days of history to keep in each rolling array
const HISTORY_WINDOW = 90;

// Timeout per request (ms) — fail fast, don't block the pipeline
const REQUEST_TIMEOUT = 8000;

// ── UTILITIES ────────────────────────────────────────────────────────────────

/**
 * Minimal fetch wrapper that returns parsed JSON.
 * Uses Node's built-in https module — no npm dependencies needed.
 */
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Aurum-Dashboard/1.0',
        ...options.headers,
      },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON parse failed for ${url}: ${data.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

/**
 * Same but for CSV responses (freegoldapi.com).
 */
function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

/**
 * Safely attempt a fetch. On failure, log the error and return null.
 * This means one broken API never kills the whole pipeline.
 */
async function safe(label, fn) {
  try {
    const result = await fn();
    console.log(`✓ ${label}`);
    return result;
  } catch (err) {
    console.warn(`✗ ${label}: ${err.message}`);
    return null;
  }
}

/**
 * Round to N decimal places — prevents float noise in JSON.
 */
const round = (n, decimals = 2) =>
  n !== null && n !== undefined && !isNaN(n)
    ? Math.round(n * 10 ** decimals) / 10 ** decimals
    : null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function hoursSince(isoTs, nowMs = Date.now()) {
  if (!isoTs) return Infinity;
  const t = new Date(isoTs).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / (1000 * 60 * 60);
}

function daysInMonthUTC(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function shouldFetchByInterval(existing, sourceKey, minHours, nowMs = Date.now()) {
  const lastTs = existing?.meta?.lastFetch?.[sourceKey];
  return hoursSince(lastTs, nowMs) >= minHours;
}

/**
 * Push a new value onto a rolling history array, trim to window size.
 * Mutates the array in place and returns it.
 */
function pushHistory(arr, value) {
  if (value !== null && !isNaN(value)) {
    arr.push(round(value, 4));
    if (arr.length > HISTORY_WINDOW) arr.splice(0, arr.length - HISTORY_WINDOW);
  }
  return arr;
}

// ── FEAR & GREED — alternative.me (keyless) ──────────────────────────────────
async function fetchFearGreed() {
  const data = await fetchJSON('https://api.alternative.me/fng/?limit=2&format=json');
  const [latest, prev] = data.data;
  return {
    value:          parseInt(latest.value, 10),
    classification: latest.value_classification,
    previousClose:  parseInt(prev?.value ?? latest.value, 10),
    updatedAt:      new Date(parseInt(latest.timestamp, 10) * 1000).toISOString(),
  };
}

// ── FX RATES — open.er-api.com (keyless) ─────────────────────────────────────
async function fetchFX() {
  const data = await fetchJSON('https://open.er-api.com/v6/latest/USD');
  const r = data.rates;
  const pair = (quote, base = 1) => round(base / r[quote], 4);
  return {
    EURUSD: { rate: pair('EUR'), change: null }, // change calculated vs previous snapshot
    GBPUSD: { rate: pair('GBP'), change: null },
    USDJPY: { rate: round(r['JPY'], 2), change: null },
    USDCHF: { rate: round(r['CHF'], 4), change: null },
    USDCNY: { rate: round(r['CNY'], 4), change: null },
    updatedAt: data.time_last_update_utc,
  };
}

// ── GOLD PRICE — freegoldapi.com (keyless, daily CSV) ────────────────────────
async function fetchGoldCSV() {
  const csv = await fetchCSV('https://freegoldapi.com/data/latest.csv');
  const lines = csv.trim().split('\n').filter(Boolean);
  // Last line is today's entry: date,price,source
  const lastLine = lines[lines.length - 1].split(',');
  return {
    date:  lastLine[0]?.trim(),
    price: round(parseFloat(lastLine[1]), 2),
  };
}

// ── ALPHA VANTAGE — indices + metals (25 req/day free) ───────────────────────
// Strategy: batch symbols carefully. 6 calls = S&P, DAX, FTSE, Nikkei, silver, oil.
// Gold comes from metals.dev + freegoldapi. Wheat comes from AV commodity endpoint.

const AV_BASE = 'https://www.alphavantage.co/query';

async function avGlobalQuote(symbol) {
  const url = `${AV_BASE}?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${CONFIG.alphavantage}`;
  const data = await fetchJSON(url);
  if (data?.Note || data?.Information) {
    throw new Error(`Alpha Vantage rate-limited for ${symbol}`);
  }
  const q = data['Global Quote'];
  if (!q || !q['05. price']) throw new Error(`No quote data for ${symbol}`);
  return {
    price:  round(parseFloat(q['05. price']), 2),
    change: round(parseFloat(q['10. change percent']?.replace('%', '')), 2),
    prev:   round(parseFloat(q['08. previous close']), 2),
  };
}

async function avCommodity(symbol) {
  // AV commodity endpoint (monthly for free tier)
  const url = `${AV_BASE}?function=WTI&interval=monthly&apikey=${CONFIG.alphavantage}`;
  const data = await fetchJSON(url);
  const entries = data?.data;
  if (!entries?.length) throw new Error(`No commodity data for ${symbol}`);
  const latest = entries[0];
  const prev   = entries[1];
  const price  = round(parseFloat(latest.value), 2);
  const pPrice = round(parseFloat(prev?.value), 2);
  return {
    price,
    change: pPrice ? round(((price - pPrice) / pPrice) * 100, 2) : null,
  };
}

async function fetchIndicesAndMetals() {
  // Alpha Vantage free tier is very strict on per-minute rate limits.
  // Run sequentially with spacing to avoid intermittent empty quote payloads.
  const symbols = [
    ['sp500',  'AV: S&P 500', 'SPY'],     // ETF proxy for S&P 500
    ['dax',    'AV: DAX',     'EWG'],     // ETF proxy for DAX
    ['ftse',   'AV: FTSE',    'ISF.LON'],
    ['nikkei', 'AV: Nikkei',  'EWJ'],     // ETF proxy for Nikkei
    ['silver', 'AV: Silver',  'SLV'],     // ETF proxy for silver
  ];

  const out = {};
  for (let i = 0; i < symbols.length; i++) {
    const [key, label, symbol] = symbols[i];
    out[key] = await safe(label, () => avGlobalQuote(symbol));
    if (i < symbols.length - 1) await sleep(13000);
  }

  return {
    indices: {
      sp500:  out.sp500 ?? null,
      dax:    out.dax ?? null,
      ftse:   out.ftse ?? null,
      nikkei: out.nikkei ?? null,
    },
    silver: out.silver ?? null,
  };
}

// ── METALS.DEV — gold, silver, platinum live spot (100 req/month) ─────────────
async function fetchMetals() {
  const url = `https://api.metals.dev/v1/latest?api_key=${CONFIG.metalsdev}&currency=USD&unit=troy_ounce`;
  const data = await fetchJSON(url);
  const m = data?.metals;
  if (!m) throw new Error('No metals data returned');
  return {
    gold:     { price: round(m.XAU, 2) },
    silver:   { price: round(m.XAG, 2) },
    platinum: { price: round(m.XPT, 2) },
    palladium:{ price: round(m.XPD, 2) },
  };
}

// ── FRED — macro economic indicators (120 req/min free) ─────────────────────
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

async function fredSeries(seriesId, limit = 2) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${CONFIG.fred}&file_type=json&sort_order=desc&limit=${limit}`;
  const data = await fetchJSON(url);
  const obs = data?.observations?.filter(o => o.value !== '.');
  if (!obs?.length) throw new Error(`No FRED data for ${seriesId}`);
  const latest = parseFloat(obs[0].value);
  const prev   = obs[1] ? parseFloat(obs[1].value) : null;
  return {
    value:    round(latest, 4),
    previous: prev ? round(prev, 4) : null,
    change:   prev ? round(latest - prev, 4) : null,
    date:     obs[0].date,
  };
}

async function fetchMacro() {
  const [treasury10y, treasury2y, cpi, fedFunds, unrate, gdp, yieldSpreadSeries] = await Promise.allSettled([
    safe('FRED: 10Y yield',   () => fredSeries('DGS10')),
    safe('FRED: 2Y yield',    () => fredSeries('DGS2')),
    safe('FRED: CPI',         () => fredSeries('CPIAUCSL')),
    safe('FRED: Fed Funds',   () => fredSeries('FEDFUNDS')),
    safe('FRED: Unemployment',() => fredSeries('UNRATE')),
    safe('FRED: GDP',         () => fredSeries('GDPC1')),
    safe('FRED: 10Y-2Y spread',() => fredSeries('T10Y2Y')),
  ]);

  const get = (s) => s.status === 'fulfilled' ? s.value : null;
  const t10 = get(treasury10y);
  const t2  = get(treasury2y);
  const spreadSeries = get(yieldSpreadSeries);

  // Prefer computed spread from latest 10Y/2Y values, fallback to direct FRED spread series.
  const yieldSpread = (t10 && t2)
    ? {
        value: round(t10.value - t2.value, 4),
        date: t10.date,
        change: round((t10.change ?? 0) - (t2.change ?? 0), 4),
      }
    : spreadSeries
      ? {
          value: spreadSeries.value,
          date: spreadSeries.date,
          change: spreadSeries.change,
        }
      : null;

  return {
    treasury10y:  t10,
    treasury2y:   t2,
    yieldSpread,  // negative = inverted curve = recession signal
    cpi:          get(cpi),
    fedFunds:     get(fedFunds),
    unemployment: get(unrate),
    gdp:          get(gdp),
  };
}

// ── NEWS API — financial headlines + sentiment ────────────────────────────────
const SENTIMENT_KEYWORDS = [
  'federal reserve', 'interest rate', 'inflation', 'gold price',
  'oil price', 'stock market', 'recession', 'geopolitical', 'war',
  'sanctions', 'supply chain', 'treasury yield', 'central bank',
];

// Simple rule-based bullish/bearish classifier
function classifyTone(headline) {
  const h = headline.toLowerCase();
  const bearish = ['fall', 'drop', 'plunge', 'slump', 'fear', 'risk', 'warn',
    'concern', 'tension', 'conflict', 'recession', 'crash', 'decline', 'weak'];
  const bullish = ['rise', 'gain', 'surge', 'rally', 'jump', 'strong', 'grow',
    'recover', 'optimism', 'confidence', 'beat', 'exceed'];
  const bearScore = bearish.filter(w => h.includes(w)).length;
  const bullScore = bullish.filter(w => h.includes(w)).length;
  if (bearScore > bullScore) return 'bearish';
  if (bullScore > bearScore) return 'bullish';
  return 'neutral';
}

async function fetchNews() {
  const query = encodeURIComponent(SENTIMENT_KEYWORDS.slice(0, 5).join(' OR '));
  const url = `https://newsapi.org/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${CONFIG.newsapi}`;
  const data = await fetchJSON(url);
  const articles = data?.articles ?? [];

  const items = articles.slice(0, 8).map(a => ({
    text:      a.title,
    source:    a.source?.name,
    tone:      classifyTone(a.title),
    url:       a.url,
    published: a.publishedAt,
  }));

  const bearCount = items.filter(i => i.tone === 'bearish').length;
  const bullCount = items.filter(i => i.tone === 'bullish').length;
  const signal = bearCount > bullCount * 1.5 ? 'bearish'
               : bullCount > bearCount * 1.5 ? 'bullish'
               : 'cautious';

  return { signal, items };
}

// ── COINGECKO — BTC, ETH as macro risk signals (keyless demo) ────────────────
async function fetchCrypto() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true';
  const headers = CONFIG.coingecko ? { 'x-cg-demo-api-key': CONFIG.coingecko } : {};
  const data = await fetchJSON(url, { headers });
  return {
    bitcoin:  {
      price:  round(data?.bitcoin?.usd, 0),
      change: round(data?.bitcoin?.usd_24h_change, 2),
    },
    ethereum: {
      price:  round(data?.ethereum?.usd, 0),
      change: round(data?.ethereum?.usd_24h_change, 2),
    },
  };
}

// ── GDELT — geopolitical risk by region (keyless) ────────────────────────────
// GDELT DOC 2.0 API: fetch last 7 days of conflict/military-action themes
// We query tone scores per source country to build a normalised risk map.
async function fetchGeopolitical() {
  // GDELT free text API — returns recent articles with conflict themes
  const query = encodeURIComponent('(conflict OR military OR sanctions OR war)');
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=25&format=json&timespan=7d`;

  let data = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await fetchJSON(url);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const backoffMs = 2000 + Math.floor(Math.random() * 2001); // 2-4s jitter
        await sleep(backoffMs);
      }
    }
  }
  if (lastErr) throw lastErr;
  const articles = data?.articles ?? [];

  // Count articles mentioning each country name
  // Simplified country mention counting — production version would use CAMEO codes
  const COUNTRY_MENTIONS = {
    'Ukraine':       ['ukraine', 'ukrainian', 'kyiv', 'zelenskyy'],
    'Russia':        ['russia', 'russian', 'kremlin', 'moscow', 'putin'],
    'Iran':          ['iran', 'iranian', 'tehran'],
    'Israel':        ['israel', 'israeli', 'tel aviv', 'gaza', 'hamas'],
    'China':         ['china', 'chinese', 'beijing', 'xi jinping'],
    'North Korea':   ['north korea', 'pyongyang', 'kim jong'],
    'Syria':         ['syria', 'syrian', 'damascus'],
    'Yemen':         ['yemen', 'yemeni', 'houthi'],
    'Sudan':         ['sudan', 'sudanese', 'khartoum'],
    'Myanmar':       ['myanmar', 'burma', 'burmese'],
    'Pakistan':      ['pakistan', 'pakistani', 'islamabad'],
    'Afghanistan':   ['afghanistan', 'afghan', 'kabul', 'taliban'],
    'Nigeria':       ['nigeria', 'nigerian', 'abuja'],
    'Ethiopia':      ['ethiopia', 'ethiopian', 'addis ababa'],
    'DRC':           ['congo', 'drc', 'kinshasa'],
    'Saudi Arabia':  ['saudi', 'riyadh', 'mbs'],
    'India':         ['india', 'indian', 'modi', 'new delhi'],
    'USA':           ['united states', 'american', 'washington', 'biden', 'trump'],
    'UK':            ['britain', 'british', 'london', 'sunak'],
    'Germany':       ['germany', 'german', 'berlin'],
    'France':        ['france', 'french', 'paris'],
    'Brazil':        ['brazil', 'brazilian', 'brasilia'],
  };

  // ISO alpha-3 map for Aurum's choropleth
  const ISO3 = {
    'Ukraine': 'UKR', 'Russia': 'RUS', 'Iran': 'IRN', 'Israel': 'ISR',
    'China': 'CHN', 'North Korea': 'PRK', 'Syria': 'SYR', 'Yemen': 'YEM',
    'Sudan': 'SDN', 'Myanmar': 'MMR', 'Pakistan': 'PAK', 'Afghanistan': 'AFG',
    'Nigeria': 'NGA', 'Ethiopia': 'ETH', 'DRC': 'COD', 'Saudi Arabia': 'SAU',
    'India': 'IND', 'USA': 'USA', 'UK': 'GBR', 'Germany': 'DEU',
    'France': 'FRA', 'Brazil': 'BRA',
  };

  const allText = articles.map(a => (a.title + ' ' + (a.seendescription ?? '')).toLowerCase());

  const rawCounts = {};
  for (const [country, terms] of Object.entries(COUNTRY_MENTIONS)) {
    rawCounts[country] = allText.filter(text =>
      terms.some(t => text.includes(t))
    ).length;
  }

  // Normalise to 0–100
  const maxCount = Math.max(...Object.values(rawCounts), 1);
  const riskByCountry = {};
  for (const [country, count] of Object.entries(rawCounts)) {
    const iso = ISO3[country];
    if (iso) riskByCountry[iso] = Math.round((count / maxCount) * 100);
  }

  return {
    riskByCountry,
    articleCount: articles.length,
    updatedAt: new Date().toISOString(),
  };
}

// ── GIST READ — get existing snapshot (for history continuation) ──────────────
async function readGist() {
  const url = `https://api.github.com/gists/${CONFIG.gistId}`;
  const data = await fetchJSON(url, {
    headers: {
      'Authorization': `token ${CONFIG.gistToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  const content = data?.files?.['aurum-data.json']?.content;
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── GIST WRITE — publish final snapshot ──────────────────────────────────────
async function writeGist(payload) {
  const body = JSON.stringify({
    files: {
      'aurum-data.json': {
        content: JSON.stringify(payload, null, 2),
      },
    },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path:     `/gists/${CONFIG.gistId}`,
      method:   'PATCH',
      headers: {
        'Authorization':  `token ${CONFIG.gistToken}`,
        'Accept':         'application/vnd.github.v3+json',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Aurum-Dashboard/1.0',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Gist write failed: ${res.statusCode} ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── LOCAL WRITE — dry-run output (no Gist credentials required) ─────────────
async function writeLocalSnapshot(payload) {
  const outputPath = path.join(process.cwd(), 'aurum-data.local.json');
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  return outputPath;
}

async function readLocalSnapshot() {
  const outputPath = path.join(process.cwd(), 'aurum-data.local.json');
  try {
    const content = await fs.readFile(outputPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── CALCULATE DELTAS vs PREVIOUS SNAPSHOT ────────────────────────────────────
function calcChange(current, previous, key) {
  if (!previous || !current) return null;
  const curr = current[key];
  const prev = previous[key];
  if (!curr || !prev || prev === 0) return null;
  return round(((curr - prev) / prev) * 100, 2);
}

// ── MAIN PIPELINE ─────────────────────────────────────────────────────────────
async function main() {
  console.log('═══ Aurum fetch.js ═══');
  console.log(`Run: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'dry-run (local file output)' : 'pipeline (Gist read/write)'}`);

  // 1. Read existing snapshot for history continuation
  let existing = null;
  if (DRY_RUN) {
    console.log('\n── Dry run enabled: loading local snapshot cache...');
    existing = await readLocalSnapshot();
    if (existing) {
      console.log('✓ Loaded existing local snapshot');
    } else {
      console.log('~ No local snapshot found, starting fresh');
    }
  } else {
    console.log('\n── Reading existing Gist snapshot...');
    existing = await safe('Read Gist', readGist);
  }

  // Initialise or continue rolling history arrays
  const history = existing?.history ?? {
    gold:        [],
    silver:      [],
    platinum:    [],
    sp500:       [],
    dax:         [],
    ftse:        [],
    nikkei:      [],
    eurusd:      [],
    gbpusd:      [],
    usdjpy:      [],
    treasury10y: [],
    treasury2y:  [],
    bitcoin:     [],
    ethereum:    [],
  };

  // 2. Fetch all sources in parallel where possible
  console.log('\n── Fetching data sources...');

  // Quota/cadence guardrails (UTC):
  // - Alpha Vantage: 25/day free -> cap to every 6h (~4/day)
  // - metals.dev: 100/month free -> dynamic cap ~ every 8h (<=3/day)
  // - NewsAPI: 100/day free -> cap to every 1h (<=24/day)
  const nowMs = Date.now();
  const metalsMinHours = Math.max(8, Math.ceil((24 * daysInMonthUTC()) / 100)); // usually ~8h

  const canFetchAV = shouldFetchByInterval(existing, 'alphavantage', 6, nowMs);
  const canFetchMetals = shouldFetchByInterval(existing, 'metalsdev', metalsMinHours, nowMs);
  const canFetchNews = shouldFetchByInterval(existing, 'newsapi', 1, nowMs);
  const canFetchGeo = shouldFetchByInterval(existing, 'gdelt', 4, nowMs);

  const [fearGreed, fx, goldCSV, avData, metals, macro, news, crypto, geo] =
    await Promise.all([
      safe('Fear & Greed',    fetchFearGreed),
      safe('FX rates',        fetchFX),
      safe('Gold CSV',        fetchGoldCSV),
      canFetchAV
        ? safe('Alpha Vantage', fetchIndicesAndMetals)
        : Promise.resolve(null),
      canFetchMetals
        ? safe('Metals.dev', fetchMetals)
        : Promise.resolve(null),
      safe('FRED macro',      fetchMacro),
      canFetchNews
        ? safe('NewsAPI', fetchNews)
        : Promise.resolve(null),
      safe('CoinGecko',       fetchCrypto),
      canFetchGeo
        ? safe('GDELT', fetchGeopolitical)
        : Promise.resolve(null),
    ]);

  if (!canFetchAV) console.log('~ Alpha Vantage skipped (quota cadence, reusing cached values)');
  if (!canFetchMetals) console.log('~ Metals.dev skipped (monthly quota cadence, reusing cached values)');
  if (!canFetchNews) console.log('~ NewsAPI skipped (quota cadence, reusing cached values)');
  if (!canFetchGeo) console.log('~ GDELT skipped (4h cadence, reusing cached geopolitical data)');

  // 3. Resolve best gold price (metals.dev preferred, CSV fallback)
  const goldPrice = metals?.gold?.price ?? goldCSV?.price ?? null;
  const silverPrice = metals?.silver?.price ?? avData?.silver?.price ?? null;
  const platinumPrice = metals?.platinum?.price ?? null;

  // 4. Calculate FX changes vs previous snapshot
  const prevFX = existing?.fx;
  if (fx && prevFX) {
    for (const pair of ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCNY']) {
      if (fx[pair] && prevFX[pair]) {
        const curr = fx[pair].rate;
        const prev = prevFX[pair].rate;
        fx[pair].change = (curr && prev && prev !== 0)
          ? round(((curr - prev) / prev) * 100, 2)
          : null;
      }
    }
  }

  // 5. Calculate metal price changes vs previous snapshot
  const prevMetals = existing?.metals;
  const metalWithChange = (price, key) => {
    const prev = prevMetals?.[key]?.price;
    return {
      price,
      change:    (price && prev && prev !== 0) ? round(((price - prev) / prev) * 100, 2) : null,
      changeAbs: (price && prev) ? round(price - prev, 2) : null,
    };
  };

  // 6. Update rolling history arrays with today's values
  pushHistory(history.gold,        goldPrice);
  pushHistory(history.silver,      silverPrice);
  pushHistory(history.platinum,    platinumPrice);
  pushHistory(history.sp500,       avData?.indices?.sp500?.price);
  pushHistory(history.dax,         avData?.indices?.dax?.price);
  pushHistory(history.ftse,        avData?.indices?.ftse?.price);
  pushHistory(history.nikkei,      avData?.indices?.nikkei?.price);
  pushHistory(history.eurusd,      fx?.EURUSD?.rate);
  pushHistory(history.gbpusd,      fx?.GBPUSD?.rate);
  pushHistory(history.usdjpy,      fx?.USDJPY?.rate);
  pushHistory(history.treasury10y, macro?.treasury10y?.value);
  pushHistory(history.treasury2y,  macro?.treasury2y?.value);
  pushHistory(history.bitcoin,     crypto?.bitcoin?.price);
  pushHistory(history.ethereum,    crypto?.ethereum?.price);

  // 7. Generate a one-line market narrative for the intelligence strip
  // Simple rule-based — will be replaced by AI briefing in v2
  const narrative = generateNarrative({
    fearGreed,
    macro,
    metals: { gold: metalWithChange(goldPrice, 'gold') },
    news
  });

  const geoResolved = geo ?? existing?.geopolitical ?? null;
  const geoCached = (geo === null && existing?.geopolitical != null);

  // 8. Assemble the final snapshot
  const snapshot = {
    meta: {
      updated:  new Date().toISOString(),
      stale:    false,
      version:  '1.0',
      geoCached,
      lastFetch: {
        fearGreed:   fearGreed ? new Date().toISOString() : (existing?.meta?.lastFetch?.fearGreed ?? null),
        fx:          fx ? new Date().toISOString() : (existing?.meta?.lastFetch?.fx ?? null),
        goldCSV:     goldCSV ? new Date().toISOString() : (existing?.meta?.lastFetch?.goldCSV ?? null),
        alphavantage:avData ? new Date().toISOString() : (existing?.meta?.lastFetch?.alphavantage ?? null),
        metalsdev:   metals ? new Date().toISOString() : (existing?.meta?.lastFetch?.metalsdev ?? null),
        fred:        macro ? new Date().toISOString() : (existing?.meta?.lastFetch?.fred ?? null),
        newsapi:     news ? new Date().toISOString() : (existing?.meta?.lastFetch?.newsapi ?? null),
        coingecko:   crypto ? new Date().toISOString() : (existing?.meta?.lastFetch?.coingecko ?? null),
        gdelt:       geo ? new Date().toISOString() : (existing?.meta?.lastFetch?.gdelt ?? null),
      },
      sources: {
        fearGreed:  fearGreed  !== null,
        fx:         fx         !== null,
        metals:     metals     !== null,
        indices:    avData     !== null,
        macro:      macro      !== null,
        news:       news       !== null,
        crypto:     crypto     !== null,
        geo:        geoResolved !== null,
      },
    },

    fearGreed: fearGreed ?? existing?.fearGreed ?? null,

    metals: {
      gold:      metalWithChange(goldPrice,     'gold'),
      silver:    metalWithChange(silverPrice,   'silver'),
      platinum:  metalWithChange(platinumPrice, 'platinum'),
    },

    indices: {
      sp500:  avData?.indices?.sp500  ?? existing?.indices?.sp500  ?? null,
      dax:    avData?.indices?.dax    ?? existing?.indices?.dax    ?? null,
      ftse:   avData?.indices?.ftse   ?? existing?.indices?.ftse   ?? null,
      nikkei: avData?.indices?.nikkei ?? existing?.indices?.nikkei ?? null,
    },

    fx: fx ?? existing?.fx ?? null,

    macro: {
      treasury10y:  macro?.treasury10y  ?? existing?.macro?.treasury10y  ?? null,
      treasury2y:   macro?.treasury2y   ?? existing?.macro?.treasury2y   ?? null,
      yieldSpread:  macro?.yieldSpread  ?? existing?.macro?.yieldSpread  ?? null,
      cpi:          macro?.cpi          ?? existing?.macro?.cpi          ?? null,
      fedFunds:     macro?.fedFunds     ?? existing?.macro?.fedFunds     ?? null,
      unemployment: macro?.unemployment ?? existing?.macro?.unemployment ?? null,
      gdp:          macro?.gdp          ?? existing?.macro?.gdp          ?? null,
    },

    crypto: crypto ?? existing?.crypto ?? null,

    sentiment: {
      signal:    news?.signal ?? 'neutral',
      headline:  narrative,
      newsItems: news?.items ?? [],
    },

    geopolitical: geoResolved,

    history,
  };

  // 9. Write output
  if (DRY_RUN) {
    console.log('\n── Writing local snapshot...');
    const outputPath = await writeLocalSnapshot(snapshot);
    console.log(`✓ Local snapshot written: ${outputPath}`);
  } else {
    console.log('\n── Writing to Gist...');
    await safe('Write Gist', () => writeGist(snapshot));
  }

  // 10. Summary
  const byteSize = Buffer.byteLength(JSON.stringify(snapshot));
  console.log(`\n✓ Pipeline complete`);
  console.log(`  Snapshot size: ${(byteSize / 1024).toFixed(1)} KB`);
  console.log(`  History depth: ${history.gold.length} days`);
  console.log(`  Updated: ${snapshot.meta.updated}`);

  const failures = Object.entries(snapshot.meta.sources)
    .filter(([, ok]) => !ok).map(([k]) => k);
  if (failures.length) {
    console.warn(`  Failed sources: ${failures.join(', ')}`);
  }
}

// ── NARRATIVE GENERATOR (rule-based v1) ──────────────────────────────────────
function generateNarrative({ fearGreed, macro, metals, news }) {
  const parts = [];

  if (fearGreed) {
    const v = fearGreed.value;
    if (v < 25)      parts.push('Extreme fear in markets');
    else if (v < 45) parts.push('Markets in fear territory');
    else if (v > 75) parts.push('Extreme greed — potential correction risk');
    else if (v > 55) parts.push('Greedy market conditions');
  }

  if (macro?.yieldSpread?.value != null) {
    const spread = macro.yieldSpread.value;
    if (spread < 0) parts.push('yield curve inverted — recession watch active');
    else if (spread < 0.2) parts.push('yield curve near flat — caution warranted');
  }

  if (metals?.gold && macro?.treasury10y?.value) {
    const goldChange = metals.gold.change;
    const yieldChange = macro.treasury10y.change;
    if (goldChange > 0 && yieldChange < 0) parts.push('gold advancing as yields ease');
    if (goldChange > 0 && yieldChange > 0) parts.push('gold rising despite yield pressure — flight to safety signal');
  }

  if (news?.signal === 'bearish') parts.push('headline sentiment broadly bearish');
  if (news?.signal === 'bullish') parts.push('headline sentiment supportive');

  if (parts.length === 0) return 'Markets stable — no dominant signals today.';

  return parts.map((p, i) => i === 0
    ? p.charAt(0).toUpperCase() + p.slice(1)
    : p
  ).join(' · ') + '.';
}

// ── RUN ────────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
