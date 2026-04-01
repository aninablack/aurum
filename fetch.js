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
 *   FINNHUB_KEY         — finnhub.io free key
 *   MARKETAUX_KEY       — marketaux.com free key
 *   NEWSDATA_KEY        — newsdata.io free key
 *   GNEWS_KEY           — gnews.io free key
 *   MEDIASTACK_KEY      — mediastack.com free key (optional)
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
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  alphavantage: process.env.ALPHA_VANTAGE_KEY,
  fred:         process.env.FRED_KEY,
  newsapi:      process.env.NEWS_API_KEY,
  finnhub:      process.env.FINNHUB_KEY,
  marketaux:    process.env.MARKETAUX_KEY,
  newsdata:     process.env.NEWSDATA_KEY,
  gnews:        process.env.GNEWS_KEY,
  mediastack:   process.env.MEDIASTACK_KEY,
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

const SANITY = {
  gold:     { min: 2000, max: 6000 },
  silver:   { min: 10,   max: 150  },
  platinum: { min: 400,  max: 3000 },
};
const NEWS_MAX_AGE_HOURS = 72;

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

function sane(key, value) {
  if (value == null) return null;
  const { min, max } = SANITY[key];
  if (value < min || value > max) {
    console.warn(`Sanity fail: ${key} = ${value} (expected ${min}-${max})`);
    return null;
  }
  return value;
}

function hoursSince(isoTs, nowMs = Date.now()) {
  if (!isoTs) return Infinity;
  const t = new Date(isoTs).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / (1000 * 60 * 60);
}

function isRecent(isoTs, maxHours = NEWS_MAX_AGE_HOURS) {
  if (!isoTs) return false;
  const t = new Date(isoTs).getTime();
  if (!Number.isFinite(t)) return false;
  return ((Date.now() - t) / (1000 * 60 * 60)) <= maxHours;
}

function daysInMonthUTC(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function shouldFetchByInterval(existing, sourceKey, minHours, nowMs = Date.now()) {
  const lastTs = existing?.meta?.lastFetch?.[sourceKey];
  return hoursSince(lastTs, nowMs) >= minHours;
}

function getUtcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getUtcMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function getQuotaState(existing, sourceKey, now = new Date()) {
  const q = existing?.meta?.quota?.[sourceKey] ?? {};
  const dayKey = getUtcDayKey(now);
  const monthKey = getUtcMonthKey(now);
  return {
    day: q.day === dayKey ? (q.dayCount ?? 0) : 0,
    month: q.month === monthKey ? (q.monthCount ?? 0) : 0,
    dayKey,
    monthKey,
  };
}

function withQuotaPolicy(existing, sourceKey, { minHours = 0, maxPerDay = null, maxPerMonth = null }, now = new Date()) {
  const byInterval = shouldFetchByInterval(existing, sourceKey, minHours, now.getTime());
  const state = getQuotaState(existing, sourceKey, now);
  const byDay = maxPerDay == null ? true : state.day < maxPerDay;
  const byMonth = maxPerMonth == null ? true : state.month < maxPerMonth;
  return { allowed: byInterval && byDay && byMonth, state };
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

/**
 * One-time cleanup for mixed-scale history values.
 * Keeps values within a broad median band to drop legacy proxy-scale outliers.
 */
function sanitizeHistory(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return Array.isArray(arr) ? arr : [];
  const sorted = [...arr].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return arr.filter(v => v > median / 4 && v < median * 4);
}

function trimTrailingDuplicate(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [...arr];
  while (out.length >= 2 && out[out.length - 1] === out[out.length - 2]) {
    out.pop();
  }
  return out;
}

function appendDailyValue(existingArr, value, isSameDay) {
  const base = trimTrailingDuplicate(Array.isArray(existingArr) ? existingArr : []);
  if (value == null || Number.isNaN(value)) return base.slice(-30);
  if (isSameDay && base.length > 0) {
    base[base.length - 1] = round(value, 4);
    return base.slice(-30);
  }
  return [...base, round(value, 4)].slice(-30);
}

function buildCpiYoYSeriesFromObsDesc(obsDesc) {
  if (!Array.isArray(obsDesc) || obsDesc.length < 13) return [];
  const yoyDesc = [];
  for (let i = 0; i + 12 < obsDesc.length; i++) {
    const curr = Number(obsDesc[i]);
    const prev = Number(obsDesc[i + 12]);
    if (Number.isFinite(curr) && Number.isFinite(prev) && prev !== 0) {
      yoyDesc.push(round(((curr - prev) / prev) * 100, 4));
    }
  }
  return yoyDesc.reverse().slice(-30);
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
  const INDEX_SCALE = { sp500: 8.28, dax: 478, ftse: 8.05, nikkei: 476 };
  // Alpha Vantage free tier is very strict on per-minute rate limits.
  // Run sequentially with spacing to avoid intermittent empty quote payloads.
  const symbols = [
    ['sp500',  'AV: S&P 500', 'SPY'],     // ETF proxy for S&P 500
    ['dax',    'AV: DAX',     'EWG'],     // ETF proxy for DAX
    ['ftse',   'AV: FTSE',    'ISF.LON'],
    ['nikkei', 'AV: Nikkei',  'EWJ'],     // ETF proxy for Nikkei
    ['silver', 'AV: Silver SLV', 'SLV'],  // ETF proxy for silver
  ];

  const out = {};
  for (let i = 0; i < symbols.length; i++) {
    const [key, label, symbol] = symbols[i];
    out[key] = await safe(label, () => avGlobalQuote(symbol));
    if (i < symbols.length - 1) await sleep(13000);
  }

  const scaleQuote = (q, scale) => {
    if (!q) return null;
    const scaledPrice = round(q.price * scale, 0);
    const prevScaled = q.prev != null ? round(q.prev * scale, 0) : null;
    const changeAbs = (scaledPrice != null && q.change != null)
      ? round((scaledPrice * q.change) / 100, 0)
      : null;
    return { ...q, price: scaledPrice, prevScaled, changeAbs };
  };

  return {
    indices: {
      sp500:  scaleQuote(out.sp500, INDEX_SCALE.sp500),
      dax:    scaleQuote(out.dax, INDEX_SCALE.dax),
      ftse:   scaleQuote(out.ftse, INDEX_SCALE.ftse),
      nikkei: scaleQuote(out.nikkei, INDEX_SCALE.nikkei),
      isProxy: true,
    },
    silver: out.silver ?? null,
  };
}

// ── METALS.DEV — gold, silver, platinum live spot (100 req/month) ─────────────
async function fetchMetals() {
  const url = `https://api.metals.dev/v1/latest?api_key=${CONFIG.metalsdev}&currency=USD&unit=troy_ounce`;
  const data = await fetchJSON(url);
  console.log('metals.dev FULL response:', JSON.stringify(data, null, 2));
  console.log('metals.dev status:', data?.status);
  console.log('metals.dev unit:', data?.unit);
  console.log('metals.dev currency:', data?.currency);
  console.log('metals.dev base:', data?.base);
  const m = data?.metals;
  if (!m) throw new Error('No metals data returned');
  const rawGold = m.XAU ?? m.gold ?? null;
  const rawSilver = m.XAG ?? m.silver ?? null;
  return {
    // Keep metals.dev values as fallback only due free-tier data quality variance.
    gold:     { price: round(rawGold, 2) },
    silver:   { price: round(rawSilver, 2) },
    platinum: { price: round(m.XPT ?? m.platinum ?? null, 2) },
    palladium:{ price: round(m.XPD ?? m.palladium ?? null, 2) },
  };
}

async function fetchMetalsYahoo() {
  const [gold, silver, platinum] = await Promise.allSettled([
    yahooFinance.quote('GC=F'),
    yahooFinance.quote('SI=F'),
    yahooFinance.quote('PL=F'),
  ]);
  const get = (s) => s.status === 'fulfilled' ? s.value : null;
  const g = get(gold), si = get(silver), pl = get(platinum);
  return {
    gold:     g  ? { price: round(g.regularMarketPrice, 2) }  : null,
    silver:   si ? { price: round(si.regularMarketPrice, 2) } : null,
    platinum: pl ? { price: round(pl.regularMarketPrice, 2) } : null,
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
    observations: obs.map(o => round(parseFloat(o.value), 4)),
  };
}

async function fetchMacro() {
  const [treasury10y, treasury2y, cpi, fedFunds, unrate, gdp, yieldSpreadSeries] = await Promise.allSettled([
    safe('FRED: 10Y yield',   () => fredSeries('DGS10')),
    safe('FRED: 2Y yield',    () => fredSeries('DGS2')),
    safe('FRED: CPI',         () => fredSeries('CPIAUCSL', 14)),
    safe('FRED: Fed Funds',   () => fredSeries('FEDFUNDS', 24)),
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

  const cpiSeries = get(cpi);
  const cpiObs = cpiSeries?.observations ?? [];
  const cpiYoY = (cpiObs.length >= 13 && cpiObs[12] !== 0)
    ? round(((cpiObs[0] - cpiObs[12]) / cpiObs[12]) * 100, 2)
    : null;

  return {
    treasury10y:  t10,
    treasury2y:   t2,
    yieldSpread,  // negative = inverted curve = recession signal
    cpi:          cpiSeries ? { ...cpiSeries, yoyPct: cpiYoY } : null,
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
  const bearish = ['cut','fall','drop','plunge','slump','fear','risk','warn',
    'concern','tension','conflict','recession','crash','decline','weak',
    'inflation raised','growth cut','forecast cut','lower','downgrade','loss'];
  const bullish = ['rise','gain','surge','rally','jump','strong','grow',
    'recover','optimism','confidence','beat','exceed','upgrade','higher'];
  const bearScore = bearish.filter(w => h.includes(w)).length;
  const bullScore = bullish.filter(w => h.includes(w)).length;
  if (bearScore > bullScore) return 'bearish';
  if (bullScore > bearScore) return 'bullish';
  return 'neutral';
}

async function fetchNewsAPI() {
  const q1 = encodeURIComponent(
    '("federal reserve" OR "interest rate" OR inflation OR "stock market" OR "treasury yield" OR sanctions OR "oil price" OR "gold price" OR recession OR geopolitical) NOT (NCAA OR "march madness" OR basketball OR NFL OR "Premier League")'
  );
  const q2 = `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=8&apiKey=${CONFIG.newsapi}`;
  const url1 = `https://newsapi.org/v2/everything?q=${q1}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${CONFIG.newsapi}`;
  const d1 = await fetchJSON(url1);
  let articles = d1?.articles ?? [];
  if (!articles.length) {
    const d2 = await fetchJSON(q2);
    articles = d2?.articles ?? [];
  }
  return articles.slice(0, 8).map(a => ({
    text: a.title, source: a.source?.name, tone: classifyTone(a.title), url: a.url, published: a.publishedAt,
  })).filter(i => i.text && isRecent(i.published));
}

async function fetchFinnhubNews() {
  const data = await fetchJSON(`https://finnhub.io/api/v1/news?category=general&token=${CONFIG.finnhub}`);
  return (data ?? []).slice(0, 8).map(a => ({
    text: a.headline, source: a.source, tone: classifyTone(a.headline || ''), url: a.url, published: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
  })).filter(i => i.text && isRecent(i.published));
}

async function fetchMarketauxNews() {
  const url = `https://api.marketaux.com/v1/news/all?api_token=${CONFIG.marketaux}&language=en&limit=8&search=gold,federal%20reserve,inflation,stock%20market,treasury%20yield`;
  const data = await fetchJSON(url);
  return (data?.data ?? []).slice(0, 8).map(a => ({
    text: a.title, source: a.source, tone: classifyTone(a.title || ''), url: a.url, published: a.published_at,
  })).filter(i => i.text && isRecent(i.published));
}

async function fetchNewsDataNews() {
  const q = encodeURIComponent('gold OR federal reserve OR inflation OR stock market OR treasury yield');
  const url = `https://newsdata.io/api/1/news?apikey=${CONFIG.newsdata}&language=en&category=business&q=${q}`;
  const data = await fetchJSON(url);
  return (data?.results ?? []).slice(0, 8).map(a => ({
    text: a.title, source: a.source_id || a.source_name, tone: classifyTone(a.title || ''), url: a.link, published: a.pubDate,
  })).filter(i => i.text && isRecent(i.published));
}

async function fetchGNewsFeed() {
  const q = encodeURIComponent('gold OR inflation OR "federal reserve" OR "stock market"');
  const url = `https://gnews.io/api/v4/search?q=${q}&lang=en&country=us&max=10&apikey=${CONFIG.gnews}`;
  const data = await fetchJSON(url);
  return (data?.articles ?? []).slice(0, 8).map(a => ({
    text: a.title, source: a.source?.name, tone: classifyTone(a.title || ''), url: a.url, published: a.publishedAt,
  })).filter(i => i.text && isRecent(i.published));
}

function buildNewsSignal(items) {
  const bearCount = items.filter(i => i.tone === 'bearish').length;
  const bullCount = items.filter(i => i.tone === 'bullish').length;
  return bearCount > bullCount * 1.5 ? 'bearish'
    : bullCount > bearCount * 1.5 ? 'bullish'
    : 'neutral';
}

const financeKeywords = ['gold','oil','fed','rate','inflation','yield','market',
  'stock','equity','recession','gdp','sanctions','iran','bank','crypto',
  'bitcoin','dollar','trade','tariff','geopolit','energy','supply'];

function relevanceScore(text) {
  const t = (text || '').toLowerCase();
  return financeKeywords.filter(k => t.includes(k)).length;
}

function selectRelevantNews(items) {
  const scored = (items || [])
    .map(i => ({ ...i, score: relevanceScore(i.text) }))
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const filtered = scored.length >= 3 ? scored : (items || []).slice(0, 5);
  return filtered.map(({ score, ...rest }) => rest);
}

const NEWS_PROVIDER_POLICIES = {
  finnhub:   { minHours: 6 },                 // free tier is RPM-based; cadence keeps usage low
  marketaux: { minHours: 6, maxPerDay: 100 }, // free: 100/day
  newsdata:  { minHours: 6, maxPerDay: 200 }, // free: 200 credits/day
  newsapi:   { minHours: 6, maxPerDay: 100 }, // free: 100/day
  gnews:     { minHours: 6, maxPerDay: 100 }, // free: 100/day
};

async function fetchNewsWithFallback(existing, now = new Date()) {
  const chain = [
    ['Finnhub', 'finnhub', CONFIG.finnhub, fetchFinnhubNews],
    ['Marketaux', 'marketaux', CONFIG.marketaux, fetchMarketauxNews],
    ['NewsData', 'newsdata', CONFIG.newsdata, fetchNewsDataNews],
    ['NewsAPI', 'newsapi', CONFIG.newsapi, fetchNewsAPI],
    ['GNews', 'gnews', CONFIG.gnews, fetchGNewsFeed],
  ];
  for (const [label, quotaKey, apiKey, fn] of chain) {
    if (!apiKey) continue;
    const policyCfg = NEWS_PROVIDER_POLICIES[quotaKey] ?? { minHours: 6 };
    const policy = withQuotaPolicy(existing, quotaKey, policyCfg, now);
    if (!policy.allowed) {
      console.log(`~ ${label} skipped (quota/cadence; day count=${policy.state.day}${policyCfg.maxPerDay ? `/${policyCfg.maxPerDay}` : ''})`);
      continue;
    }
    const items = await safe(label, fn);
    const filteredItems = selectRelevantNews(items);
    if (filteredItems?.length) return { signal: buildNewsSignal(filteredItems), items: filteredItems, provider: quotaKey };
  }
  return null;
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
  const file = data?.files?.['aurum-data.json'];
  let content = file?.content;
  if ((!content || file?.truncated) && file?.raw_url) {
    const raw = await fetchJSON(file.raw_url, {
      headers: { 'User-Agent': 'Aurum-Dashboard/1.0' }
    });
    return raw;
  }
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
    fearGreed:   [],
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
    fedFunds:    [],
    cpiYoy:      [],
    bitcoin:     [],
    ethereum:    [],
  };

  // Backfill newly added history keys for older snapshots.
  if (!Array.isArray(history.fearGreed)) history.fearGreed = [];
  if (!Array.isArray(history.fedFunds)) history.fedFunds = [];
  if (!Array.isArray(history.cpiYoy)) history.cpiYoy = [];

  // One-time hard cleanup for legacy metals history noise from early pipeline runs.
  // Keep only realistic modern ranges before appending latest value.
  const cleanGoldHistory = (existing?.history?.gold || [])
    .filter(v => v >= 4400 && v <= 5000);
  const cleanSilverHistory = (existing?.history?.silver || [])
    .filter(v => v >= 65 && v <= 120);
  history.gold = cleanGoldHistory.slice(-30);
  history.silver = cleanSilverHistory.slice(-30);

  // Clean legacy mixed-scale proxy values before appending fresh index points.
  history.sp500 = sanitizeHistory(history.sp500 ?? []);
  history.dax = sanitizeHistory(history.dax ?? []);
  history.ftse = sanitizeHistory(history.ftse ?? []);
  history.nikkei = sanitizeHistory(history.nikkei ?? []);

  // 2. Fetch all sources in parallel where possible
  console.log('\n── Fetching data sources...');

  // Quota/cadence guardrails (UTC) with hard caps:
  // - Alpha Vantage: 25/day (hard cap) + 3h cadence
  // - metals.dev: 100/month (hard cap) + 6h cadence
  // - News providers: capped in fetchNewsWithFallback (6h cadence + provider caps)
  // - GDELT: 2h cadence to reduce throttling pressure
  const now = new Date();
  const metalsMinHours = Math.max(6, Math.ceil((24 * daysInMonthUTC(now)) / 100)); // usually ~8h, floor at 6h

  const avPolicy = withQuotaPolicy(existing, 'alphavantage', { minHours: 3, maxPerDay: 25 }, now);
  const metalsPolicy = withQuotaPolicy(existing, 'metalsdev', { minHours: metalsMinHours, maxPerMonth: 100 }, now);
  const gdeltPolicy = withQuotaPolicy(existing, 'gdelt', { minHours: 2 }, now);

  const canFetchAV = avPolicy.allowed;
  const canFetchMetals = metalsPolicy.allowed;
  const canFetchGeo = gdeltPolicy.allowed;

  const [fearGreed, fx, avData, metalsYahoo, metals, macro, news, crypto, geo] =
    await Promise.all([
      safe('Fear & Greed',    fetchFearGreed),
      safe('FX rates',        fetchFX),
      canFetchAV
        ? safe('Alpha Vantage', fetchIndicesAndMetals)
        : Promise.resolve(null),
      safe('Yahoo metals futures', fetchMetalsYahoo),
      canFetchMetals
        ? safe('Metals.dev', fetchMetals)
        : Promise.resolve(null),
      safe('FRED macro',      fetchMacro),
      fetchNewsWithFallback(existing, now),
      safe('CoinGecko',       fetchCrypto),
      canFetchGeo
        ? safe('GDELT', fetchGeopolitical)
        : Promise.resolve(null),
    ]);

  if (!canFetchAV) console.log(`~ Alpha Vantage skipped (quota/cadence; day count=${avPolicy.state.day}/25)`);
  if (!canFetchMetals) console.log(`~ Metals.dev skipped (quota/cadence; month count=${metalsPolicy.state.month}/100)`);
  if (!canFetchGeo) console.log('~ GDELT skipped (2h cadence, reusing cached geopolitical data)');

  // 3. Metals source priority with sanity guards
  // Yahoo futures primary; metals.dev fallback.
  const goldCandidate = metalsYahoo?.gold?.price ?? metals?.gold?.price ?? null;
  const silverCandidate = metalsYahoo?.silver?.price ?? metals?.silver?.price ?? null;
  const platinumCandidate = metalsYahoo?.platinum?.price ?? metals?.platinum?.price ?? null;
  const goldPrice = sane('gold', goldCandidate);
  const silverPrice = sane('silver', silverCandidate);
  const platinumPrice = sane('platinum', platinumCandidate);

  // 4. Calculate FX changes vs previous snapshot
  console.log('Previous FX from Gist:', JSON.stringify(existing?.fx?.EURUSD));
  for (const pair of ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCNY']) {
    const curr = fx?.[pair]?.rate;
    const prev = existing?.fx?.[pair]?.rate;
    if (curr != null && prev != null && prev !== 0) {
      fx[pair].change = round(((curr - prev) / prev) * 100, 4);
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
  history.gold = [...history.gold, goldPrice].filter(v => v != null && !Number.isNaN(v)).slice(-30);
  const today = new Date().toISOString().slice(0, 10);
  const lastFgDate = existing?.meta?.lastFgDate;
  const lastMacroDate = existing?.meta?.lastMacroDate;
  history.fearGreed = appendDailyValue(existing?.history?.fearGreed, fearGreed?.value, lastFgDate === today);
  history.silver = [...history.silver, silverPrice].filter(v => v != null && !Number.isNaN(v)).slice(-30);
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
  const fedBackfill = Array.isArray(macro?.fedFunds?.observations)
    ? macro.fedFunds.observations.slice().reverse().filter(v => v != null && !Number.isNaN(v))
    : [];
  const cpiYoyBackfill = Array.isArray(macro?.cpi?.observations)
    ? buildCpiYoYSeriesFromObsDesc(macro.cpi.observations)
    : [];
  const fedBase = (existing?.history?.fedFunds?.length ?? 0) >= 2
    ? existing?.history?.fedFunds
    : fedBackfill;
  const cpiBase = (existing?.history?.cpiYoy?.length ?? 0) >= 2
    ? existing?.history?.cpiYoy
    : cpiYoyBackfill;
  history.fedFunds = appendDailyValue(fedBase, macro?.fedFunds?.value, lastMacroDate === today);
  history.cpiYoy = appendDailyValue(cpiBase, macro?.cpi?.yoyPct, lastMacroDate === today);
  pushHistory(history.bitcoin,     crypto?.bitcoin?.price);
  pushHistory(history.ethereum,    crypto?.ethereum?.price);

  const geoResolved = geo ?? existing?.geopolitical ?? null;
  const geoCached = (geo === null && existing?.geopolitical != null);

  // 7. Generate editorial briefing (headline + body)
  const narrative = generateNarrative({
    fearGreed,
    macro,
    metals: { gold: metalWithChange(goldPrice, 'gold') },
    indices: avData?.indices ?? existing?.indices ?? null,
    crypto: crypto ?? existing?.crypto ?? null,
    sentiment: {
      signal: news?.signal ?? existing?.sentiment?.signal ?? 'neutral',
      newsItems: news?.items ?? existing?.sentiment?.newsItems ?? [],
    },
    geopolitical: geoResolved,
  });
  const newsProvider = news?.provider ?? null;
  const sentinelItems = [
    { text: 'Markets on edge as global uncertainty weighs on investor sentiment', source: 'Aurum Intelligence', tone: 'bearish', url: '#', published: new Date().toISOString() },
    { text: 'Gold holds firm as safe-haven demand persists amid macro headwinds', source: 'Aurum Intelligence', tone: 'neutral', url: '#', published: new Date().toISOString() },
    { text: 'Federal Reserve policy path remains key focus for bond and equity markets', source: 'Aurum Intelligence', tone: 'neutral', url: '#', published: new Date().toISOString() },
  ];
  const resolvedNewsItems =
    (news?.items?.length > 0) ? news.items :
    (existing?.sentiment?.newsItems?.length > 0) ? existing.sentiment.newsItems :
    sentinelItems;

  // 8. Assemble the final snapshot
  const snapshot = {
    meta: {
      updated:  new Date().toISOString(),
      stale:    false,
      version:  '1.0',
      lastFgDate: fearGreed?.value != null ? today : (existing?.meta?.lastFgDate ?? null),
      lastMacroDate: (macro?.fedFunds?.value != null || macro?.cpi?.yoyPct != null) ? today : (existing?.meta?.lastMacroDate ?? null),
      geoCached,
      quota: {
        alphavantage: {
          day: avPolicy.state.dayKey,
          dayCount: avPolicy.state.day + (avData ? 1 : 0),
          month: avPolicy.state.monthKey,
          monthCount: avPolicy.state.month, // no explicit monthly cap tracked for AV
        },
        metalsdev: {
          day: metalsPolicy.state.dayKey,
          dayCount: metalsPolicy.state.day + (metals ? 1 : 0),
          month: metalsPolicy.state.monthKey,
          monthCount: metalsPolicy.state.month + (metals ? 1 : 0),
        },
        newsapi: existing?.meta?.quota?.newsapi ?? { day: getUtcDayKey(now), dayCount: 0, month: getUtcMonthKey(now), monthCount: 0 },
        finnhub: {
          day: getQuotaState(existing, 'finnhub', now).dayKey,
          dayCount: getQuotaState(existing, 'finnhub', now).day + (newsProvider === 'finnhub' ? 1 : 0),
          month: getQuotaState(existing, 'finnhub', now).monthKey,
          monthCount: getQuotaState(existing, 'finnhub', now).month + (newsProvider === 'finnhub' ? 1 : 0),
        },
        marketaux: {
          day: getQuotaState(existing, 'marketaux', now).dayKey,
          dayCount: getQuotaState(existing, 'marketaux', now).day + (newsProvider === 'marketaux' ? 1 : 0),
          month: getQuotaState(existing, 'marketaux', now).monthKey,
          monthCount: getQuotaState(existing, 'marketaux', now).month + (newsProvider === 'marketaux' ? 1 : 0),
        },
        newsdata: {
          day: getQuotaState(existing, 'newsdata', now).dayKey,
          dayCount: getQuotaState(existing, 'newsdata', now).day + (newsProvider === 'newsdata' ? 1 : 0),
          month: getQuotaState(existing, 'newsdata', now).monthKey,
          monthCount: getQuotaState(existing, 'newsdata', now).month + (newsProvider === 'newsdata' ? 1 : 0),
        },
        gnews: {
          day: getQuotaState(existing, 'gnews', now).dayKey,
          dayCount: getQuotaState(existing, 'gnews', now).day + (newsProvider === 'gnews' ? 1 : 0),
          month: getQuotaState(existing, 'gnews', now).monthKey,
          monthCount: getQuotaState(existing, 'gnews', now).month + (newsProvider === 'gnews' ? 1 : 0),
        },
        gdelt: {
          day: gdeltPolicy.state.dayKey,
          dayCount: gdeltPolicy.state.day + (geo ? 1 : 0),
          month: gdeltPolicy.state.monthKey,
          monthCount: gdeltPolicy.state.month,
        },
      },
      lastFetch: {
        fearGreed:   fearGreed ? new Date().toISOString() : (existing?.meta?.lastFetch?.fearGreed ?? null),
        fx:          fx ? new Date().toISOString() : (existing?.meta?.lastFetch?.fx ?? null),
        goldCSV:     existing?.meta?.lastFetch?.goldCSV ?? null,
        alphavantage:avData ? new Date().toISOString() : (existing?.meta?.lastFetch?.alphavantage ?? null),
        metalsdev:   metals ? new Date().toISOString() : (existing?.meta?.lastFetch?.metalsdev ?? null),
        fred:        macro ? new Date().toISOString() : (existing?.meta?.lastFetch?.fred ?? null),
        newsapi:     (newsProvider === 'newsapi') ? new Date().toISOString() : (existing?.meta?.lastFetch?.newsapi ?? null),
        finnhub:     (newsProvider === 'finnhub') ? new Date().toISOString() : (existing?.meta?.lastFetch?.finnhub ?? null),
        marketaux:   (newsProvider === 'marketaux') ? new Date().toISOString() : (existing?.meta?.lastFetch?.marketaux ?? null),
        newsdata:    (newsProvider === 'newsdata') ? new Date().toISOString() : (existing?.meta?.lastFetch?.newsdata ?? null),
        gnews:       (newsProvider === 'gnews') ? new Date().toISOString() : (existing?.meta?.lastFetch?.gnews ?? null),
        coingecko:   crypto ? new Date().toISOString() : (existing?.meta?.lastFetch?.coingecko ?? null),
        gdelt:       geo ? new Date().toISOString() : (existing?.meta?.lastFetch?.gdelt ?? null),
      },
      sources: {},
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
      isProxy: true,
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
      signal:    news?.signal ?? existing?.sentiment?.signal ?? 'neutral',
      headline:  narrative.headline ?? existing?.sentiment?.headline ?? 'Markets stable — monitoring macro and geopolitical signals.',
      briefingBody: narrative.body ?? existing?.sentiment?.briefingBody ?? null,
      newsItems: resolvedNewsItems,
    },

    geopolitical: geoResolved,

    history,
  };

  snapshot.meta.sources = {
    fearGreed: snapshot.fearGreed?.value != null,
    fx:        snapshot.fx?.EURUSD?.rate != null,
    metals:    snapshot.metals?.gold?.price != null,
    indices:   snapshot.indices?.sp500?.price != null,
    macro:     snapshot.macro?.treasury10y?.value != null,
    news:      (snapshot.sentiment?.newsItems?.length ?? 0) > 0,
    crypto:    snapshot.crypto?.bitcoin?.price != null,
    geo:       snapshot.geopolitical?.riskByCountry != null,
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
function generateHeadline(data) {
  const { fearGreed, macro, metals, indices, sentiment, geopolitical } = data || {};
  const fg = fearGreed?.value;
  const gold = metals?.gold?.price;
  const goldChg = metals?.gold?.change;
  const sp = indices?.sp500?.price;
  const spChg = indices?.sp500?.change;
  const topRisk = Object.entries(geopolitical?.riskByCountry || {})
    .filter(([,v]) => v >= 80).sort(([,a],[,b]) => b - a)[0];
  const names = { IRN:'Iran', RUS:'Russia', UKR:'Ukraine', ISR:'Israel', CHN:'China' };

  if (fg <= 20 && gold != null) {
    if (goldChg > 0) return `Extreme fear grips markets as gold advances to $${Math.round(gold).toLocaleString()}`;
    if (spChg < 0) return `Markets in extreme fear — S&P 500 falls ${Math.abs(spChg).toFixed(2)}% amid risk-off flight`;
  }
  if (topRisk && topRisk[1] >= 90) return `${names[topRisk[0]] || topRisk[0]} crisis escalates — oil and gold on alert`;
  if (fg >= 70 && spChg > 0) return `Risk appetite returns as S&P 500 gains ${spChg.toFixed(2)}% and sentiment improves`;
  if (Math.abs(goldChg || 0) > Math.abs(spChg || 0)) {
    const dir = (goldChg || 0) > 0 ? 'advances' : 'retreats';
    return `Gold ${dir} to $${Math.round(gold || 0).toLocaleString()} as macro pressure builds`;
  }
  const dir = (spChg || 0) >= 0 ? 'gains' : 'falls';
  return `S&P 500 ${dir} ${Math.abs(spChg || 0).toFixed(2)}% as markets digest macro signals`;
}

function generateBody(data) {
  const { macro, sentiment, geopolitical } = data || {};
  const sentences = [];
  const t10 = macro?.treasury10y?.value;
  const spread = macro?.yieldSpread?.value;
  const cpi = macro?.cpi?.yoyPct;
  if (t10 != null && spread != null && macro?.treasury10y?.change != null) {
    const curveSignal = spread < 0
      ? 'an inverted yield curve signals recession risk'
      : spread < 0.2
        ? 'the yield curve is near flat — watch for inversion'
        : `the yield curve remains positive at +${spread.toFixed(2)}, containing near-term recession risk`;
    sentences.push(`10Y Treasury yields ${macro.treasury10y.change >= 0 ? 'rose' : 'fell'} to ${t10.toFixed(2)}% and ${curveSignal}${cpi != null ? `, with inflation running at ${cpi.toFixed(2)}% YoY` : ''}.`);
  }

  const topRisk = Object.entries(geopolitical?.riskByCountry || {})
    .filter(([, v]) => v >= 80)
    .sort(([, a], [, b]) => b - a)[0];
  const countryNames = { IRN: 'Iran', RUS: 'Russia', UKR: 'Ukraine', ISR: 'Israel', CHN: 'China' };
  if (topRisk) {
    const [iso, score] = topRisk;
    const name = countryNames[iso] || iso;
    sentences.push(`${name} geopolitical risk remains at ${score}/100 — monitor oil and gold for breakout signals.`);
  } else if (sentiment?.newsItems?.[0]?.text) {
    sentences.push(`Key development: ${sentiment.newsItems[0].text}.`);
  }

  return sentences.join(' ') || 'Markets stable — monitoring macro and geopolitical signals.';
}

function generateNarrative(data) {
  return {
    headline: generateHeadline(data),
    body: generateBody(data),
  };
}

// ── RUN ────────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
