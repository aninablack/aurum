# Aurum — Codex Build Brief
## Dashboard UI Implementation Guide

**Read this entire document before writing any code.**  
The design system lives in `aurum-design-spec.html`. This brief tells you what to build and in what order.

---

## What exists already (do not recreate)

| File | Status | Purpose |
|---|---|---|
| `aurum-design-spec.html` | ✅ Complete | HTML shell + full CSS token system + design spec in comments |
| `fetch.js` | ✅ Complete | GitHub Actions pipeline — writes `aurum-data.json` to Gist |
| `.github/workflows/aurum-pipeline.yml` | ✅ Complete | Runs fetch.js every 15 min on weekdays |

**Your job:** Build the dashboard UI panels inside the `<main class="aurum-page">` element in `aurum-design-spec.html`, and implement the `renderDashboard(data)` function and all its sub-functions.

---

## Data shape you'll receive

```js
// Fetched from: YOUR_GIST_RAW_URL
const data = {
  meta: {
    updated: "2026-03-29T14:32:00Z",  // ISO timestamp
    stale: false,                      // true if > 4hrs old
    sources: { fearGreed: true, fx: true, metals: true, ... }
  },
  fearGreed: { value: 42, classification: "Fear", previousClose: 38 },
  metals: {
    gold:     { price: 2340.50, change: 1.8,  changeAbs: 41.20 },
    silver:   { price: 27.34,  change: 0.6,  changeAbs: 0.16  },
    platinum: { price: 961.00, change: -0.4, changeAbs: -3.80 }
  },
  indices: {
    sp500:  { price: 5248, change: 0.4 },
    dax:    { price: 18210, change: -0.2 },
    ftse:   { price: 7842, change: 0.6 },
    nikkei: { price: 38640, change: 1.1 }
  },
  fx: {
    EURUSD: { rate: 1.0821, change: -0.2 },
    GBPUSD: { rate: 1.2638, change: 0.1 },
    USDJPY: { rate: 151.42, change: 0.3 },
    USDCHF: { rate: 0.8934, change: -0.1 }
  },
  macro: {
    treasury10y:  { value: 4.28, change: 0.04, date: "2026-03-29" },
    treasury2y:   { value: 4.14, change: 0.02, date: "2026-03-29" },
    yieldSpread:  { value: 0.14, change: 0.02 },   // negative = inverted = recession signal
    cpi:          { value: 3.1, change: -0.1, date: "2026-03-01" },
    fedFunds:     { value: 5.375, change: 0, date: "2026-03-01" },
    unemployment: { value: 3.9, change: 0.1, date: "2026-03-01" }
  },
  crypto: {
    bitcoin:  { price: 71420, change: -2.1 },
    ethereum: { price: 3812,  change: -1.4 }
  },
  sentiment: {
    signal: "cautious",    // "bullish" | "bearish" | "cautious" | "neutral"
    headline: "Gold and treasuries advancing — classic flight-to-safety signal.",
    newsItems: [
      { text: "Fed signals pause on rate cycle", tone: "neutral", source: "Reuters", url: "..." },
      { text: "Middle East tensions elevated",   tone: "bearish", source: "FT",      url: "..." }
    ]
  },
  geopolitical: {
    riskByCountry: { "IRN": 90, "UKR": 99, "GBR": 10, "USA": 20, ... },
    updatedAt: "2026-03-29T06:00:00Z"
  },
  history: {
    gold:        [2201, 2215, 2198, ...],  // 90 daily closes, oldest first
    silver:      [26.1, 26.4, 26.2, ...],
    sp500:       [5102, 5118, 5098, ...],
    dax:         [18050, 18120, 18090, ...],
    ftse:        [7720, 7740, 7735, ...],
    nikkei:      [38100, 38300, 38250, ...],
    eurusd:      [1.078, 1.081, 1.079, ...],
    gbpusd:      [1.261, 1.264, 1.263, ...],
    usdjpy:      [150.2, 151.0, 151.4, ...],
    treasury10y: [4.18, 4.22, 4.25, ...],
    treasury2y:  [4.10, 4.12, 4.14, ...],
    bitcoin:     [68200, 70100, 71400, ...],
    ethereum:    [3600, 3750, 3812, ...]
  }
}
```

---

## Build order (do this in sequence — each step depends on the previous)

### Step 1 — CDN scripts in `<head>`
Add before `</head>`:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>
```

### Step 2 — Set Chart.js global defaults
In your main `<script>`, before any chart creation:
```js
Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = '#8A96A4';
Chart.defaults.plugins.tooltip.backgroundColor = '#0D1B2A';
Chart.defaults.plugins.tooltip.borderColor = 'rgba(201,168,76,0.4)';
Chart.defaults.plugins.tooltip.borderWidth = 0.5;
Chart.defaults.plugins.tooltip.titleColor = '#F9F6F0';
Chart.defaults.plugins.tooltip.bodyColor = '#C9A84C';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 6;
```

### Step 3 — Wire the data URL
Replace the placeholder in the existing script:
```js
const GIST_URL = 'https://gist.githubusercontent.com/[USERNAME]/[GIST_ID]/raw/aurum-data.json';
```

### Step 4 — Build the HTML layout rows
Inside `<main class="aurum-page">`, create these rows in order:

```html
<div class="row-1"><!-- Hero strip --></div>
<div class="row-2"><!-- Macro signals --></div>
<div class="row-3"><!-- Main grid: metals | indices | FX --></div>
<div class="row-3b" id="goldDeepDive" style="display:none"><!-- Gold area chart + scatter --></div>
<div class="row-4"><!-- Intelligence panels --></div>
<div class="row-5"><!-- Scenario overlay bar --></div>
```

### Step 5 — Implement each render function

Implement these functions (called from `renderDashboard(data)`):

**`renderHeroStrip(fearGreed, metals)`**
- Left 40%: Fear & Greed semicircle gauge (Canvas 2D — see design spec §gauge)
- Right 60%: top mover card (largest absolute change across all assets) + intelligence dot + headline

**`renderMacroStrip(macro)`**
- 4 equal columns: 10Y Yield | Yield Curve Spread | CPI | Fed Funds Rate
- Each: gold label above, DM Serif Display value, small delta below
- Inverted spread (< 0): tint the yield spread cell with `rgba(163,45,45,0.08)` + caution colour text

**`renderMetals(metals, history)`**
- 3 cards stacked (or in a sub-grid): Gold, Silver, Platinum
- Each card: label, price (DM Serif Display 26px), delta, sparkline (Chart.js, 52px, gold line `#D4AF37`)
- Gold card is clickable — toggles `#goldDeepDive` visibility

**`renderIndices(indices, history)`**
- 4 mini-cards at top: S&P 500, DAX, FTSE, Nikkei — each with sparkline
- Full-width horizontal bar chart below showing all 4 indices daily % change
- Bar chart: `indexAxis: 'y'`, bars coloured by sign (see design spec §charts)

**`renderFX(fx, history)`**
- 4 rows: EUR/USD, GBP/USD, USD/JPY, USD/CHF
- Each: label, rate (DM Serif Display 18px), change delta, sparkline (52px)

**`renderGoldDeepDive(history, macro)`**
- Full-width expandable panel (shown when gold card is clicked)
- Left ~60%: gold area chart with 7D/30D/90D range buttons
- Right ~40%: correlation scatter plot (gold vs 10Y yield, last 90 days)
- Include correlation coefficient (r) as a badge

**`renderIntelligence(sentiment, geopolitical)`**
- Left column: D3 world choropleth map (see design spec §map) above news feed
- Right column: crypto panel (BTC, ETH cards + 30D sparklines)
- News feed: list of `newsItems` — each a row with tone dot + headline + source

**`renderScenarioBar()`**
- 5 buttons: No scenario | Geopolitical conflict | Rate hike | Supply chain shock | Market correction
- Active scenario tints asset cards using the tint classes from the existing CSS
- See full scenario delta logic in design spec §scenario buttons

---

## Number formatting rules

```js
// Always use these — never raw numbers in the UI
const fmt = {
  price:    (n) => n != null ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—',
  index:    (n) => n != null ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—',
  rate4:    (n) => n != null ? n.toFixed(4) : '—',
  rate2:    (n) => n != null ? n.toFixed(2) + '%' : '—',
  delta:    (n) => n != null ? (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%' : '—',
  deltaAbs: (n, prefix = '$') => n != null ? (n >= 0 ? '+' : '−') + prefix + Math.abs(n).toFixed(2) : '—',
  btc:      (n) => n != null ? '$' + (n >= 10000 ? (n/1000).toFixed(1) + 'k' : n.toLocaleString()) : '—',
  integer:  (n) => n != null ? Math.round(n).toString() : '—',
};
```

Always add `font-variant-numeric: tabular-nums` to any element showing financial figures.

---

## Delta colour helper

```js
function deltaClass(value) {
  if (value === null || value === undefined) return '';
  if (value > 0)  return 'delta-up';    // color: #0F6E56
  if (value < 0)  return 'delta-down';  // color: #A32D2D
  return 'delta-flat';                  // color: #8A96A4
}
```

---

## Sparkline helper (reuse for all inline sparklines)

```js
const sparklineInstances = {};

function makeSparkline(canvasId, dataArray, lineColor) {
  // Destroy previous instance if exists (prevents memory leaks on refresh)
  if (sparklineInstances[canvasId]) {
    sparklineInstances[canvasId].destroy();
  }
  sparklineInstances[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: {
      labels: dataArray.map((_, i) => i),
      datasets: [{
        data: dataArray,
        borderColor: lineColor,
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.3,
        fill: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: { duration: 400 }
    }
  });
}
// Usage:
// makeSparkline('goldSparkline', data.history.gold.slice(-30), '#D4AF37');
```

---

## Skeleton loading states

Show these while data loads (already styled in the CSS):

```html
<!-- Value skeleton -->
<div class="skeleton" style="height: 26px; width: 120px; border-radius: 4px; margin: 4px 0;"></div>

<!-- Sparkline skeleton -->
<div class="skeleton" style="height: 52px; width: 100%; border-radius: 4px; margin-top: 8px;"></div>
```

Replace with real values in the render functions. Never show raw undefined or NaN.

---

## Stale data + error states

Already implemented in the existing script — do not remove:
- `showError()` — called if fetch fails
- `showStaleBanner()` — called if data is > 4hrs old
- The retry button in `showError()` calls `loadData()` again

---

## Auto-refresh

Add this after `loadData()`:
```js
// Refresh data every 15 minutes (matches pipeline schedule)
setInterval(loadData, 15 * 60 * 1000);
```

---

## Environment setup for local development

Create `.env` at repo root (never commit this):
```
ALPHA_VANTAGE_KEY=your_key_here
FRED_KEY=your_key_here
NEWS_API_KEY=your_key_here
METALS_DEV_KEY=your_key_here
COINGECKO_KEY=your_key_here
GIST_ID=your_gist_id_here
GIST_TOKEN=your_github_pat_here
```

Test the pipeline locally:
```bash
node fetch.js
```

---

## GitHub repository secrets to configure

Go to: GitHub repo → Settings → Secrets and variables → Actions → New repository secret

Add all 7 secrets from the `.env` file above with the same names.

---

## Netlify deployment

1. Connect repo to Netlify
2. Build command: *(none — this is a static site)*
3. Publish directory: `.` (root, or wherever `index.html` lives)
4. Add the same environment variables in Netlify → Site configuration → Environment variables
   *(The pipeline runs on GitHub Actions, not Netlify, so these are only needed if you later add Netlify Functions)*

---

## What Codex should NOT change

- The CSS custom properties (`:root { }` block) — all tokens are locked
- The `.aurum-nav` styling
- The animation keyframes
- The `loadData()`, `showError()`, `showStaleBanner()` functions
- The `formatDelta()` utility

---

## Sanity checks before committing

- [ ] All numbers pass through the `fmt` helpers — no raw `.price` or `.change` in the DOM
- [ ] All sparklines use `makeSparkline()` helper — no inline Chart.js config duplication
- [ ] `font-variant-numeric: tabular-nums` on every financial figure element
- [ ] Fear & Greed is Canvas 2D, not Chart.js
- [ ] No box-shadows anywhere
- [ ] No pure black (`#000` or `#111`) anywhere — use `#0D1B2A`
- [ ] Gold only appears on: labels, borders, active states — nothing else
- [ ] DM Serif Display only on data values — check all `font-family` usages
- [ ] `setInterval(loadData, 15 * 60 * 1000)` is present
- [ ] `@media (prefers-reduced-motion: reduce)` block is present

---

*Aurum Codex Build Brief · v1.0 · March 2026*
