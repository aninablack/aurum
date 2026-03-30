# Aurum — Design & Technical Specification
### Market Intelligence Dashboard · v1.0 · March 2026

**Author:** Anina Black  
**Stack:** HTML · CSS · Chart.js · D3 · GitHub Actions · Netlify  
**Deployment:** Netlify free tier  
**Purpose:** Codex build reference · design review · portfolio documentation

---

## 01 · Concept & Purpose

Aurum is a financial intelligence dashboard. The aesthetic is **"private bank meets modern data product"** — Bloomberg's precision, a private wealth manager's restraint. It must feel expensive without a single gradient or drop shadow.

The user is not a trader. They are an intelligent observer of markets. Every design decision must serve legibility and signal over noise.

| Pillar | Intent |
|---|---|
| Bloomberg precision | Dense, accurate, trusted — every number means something |
| Private bank restraint | Sparse, warm, expensive — less is always more |
| Data product clarity | Signal visible at a glance — intelligence, not noise |

---

## 02 · Typography System

**Two families. One rule.**

Google Fonts import:
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=DM+Serif+Display:ital@0;1&display=swap" rel="stylesheet">
```

```css
--font-display: 'DM Serif Display', Georgia, serif;  /* prices & data values ONLY */
--font-ui:      'DM Sans', system-ui, sans-serif;    /* everything else */
```

> **The rule:** DM Serif Display appears **only** on primary data values — prices, index levels, percentages, yield rates. Never on labels, body copy, nav, buttons, or metadata. This contrast is the single most important typographic decision in Aurum.

### Type scale

| Role | Family | Size | Weight | Usage |
|---|---|---|---|---|
| Data hero | DM Serif Display | 38px | 400 | Hero strip values |
| Data panel | DM Serif Display | 26px | 400 | Panel primary values |
| Data small | DM Serif Display | 18px | 400 | Secondary / FX rates |
| Data label | DM Sans | 10px | 500 + 0.08em tracking | Gold uppercase labels |
| Body | DM Sans | 13px | 400 | Descriptions, strips |
| Meta | DM Sans | 11px | 400 | Timestamps, footnotes |
| Nav | DM Sans | 12px | 500 | Navigation links |

Weights used: 300 (rare), 400 (body), 500 (labels, nav, deltas). Never 600 or 700.

---

## 03 · Colour System

Navy replaces black throughout. Gold is used sparingly — labels, borders, active states only.

### Navy scale

| Hex | Variable | Usage |
|---|---|---|
| `#0D1B2A` | `--color-text-primary` | Primary text, data values |
| `#1A2E42` | `--color-header` | Nav / header background |
| `#4A5568` | `--color-text-secondary` | Body copy, descriptions |
| `#8A96A4` | `--color-text-tertiary` | Metadata, timestamps |
| `#C8D0D8` | `--color-text-disabled` | Disabled / placeholder |

### Gold accent scale

| Hex | Variable | Usage |
|---|---|---|
| `#F9F6F0` | `--color-page` | Page background (warm off-white) |
| `#D4AF37` | `--gold-400` | Primary gold — wordmark, hero accents |
| `#C9A84C` | `--gold-500` | Border gold — card borders, dividers |
| `#B8952A` | `--gold-600` | Active gold — selected tabs, active states |
| `#8B6914` | `--gold-800` | Text on gold-tinted backgrounds |

### Signal colours

| Hex | Variable | Usage |
|---|---|---|
| `#0F6E56` | `--color-up` | Positive delta — teal-green |
| `#A32D2D` | `--color-down` | Negative delta — deep red |
| `#B8952A` | `--color-caution` | Warning / elevated risk — amber |
| `#243D56` | `--color-neutral` | Informational — mid navy |

### Gold usage rules

✅ Data category labels — 10px uppercase e.g. `GOLD · XAU/USD`  
✅ Card borders — `rgba(201,168,76,0.35)`, never solid opaque  
✅ Active tab underline — `2px solid #D4AF37`  
✅ Intelligence dot indicator — 6px circle `#C9A84C`  
✅ Wordmark in nav — on dark navy background  
❌ Never as a fill on large areas  
❌ Never as button background  
❌ Never on text larger than 14px (except wordmark)

---

## 04 · Layout & Spacing

```css
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;
--space-4: 16px;  --space-5: 24px;  --space-6: 32px;  --space-7: 48px;

--radius-sm:   6px;   /* tags, badges, mini chips */
--radius-md:   10px;  /* standard cards and panels */
--radius-lg:   14px;  /* hero panels, large cards */
--radius-pill: 20px;  /* scenario buttons, status pills */
```

Page max-width: 1280px, centred, 24px horizontal padding. Grid: 12-column, 16px gutters.

---

## 05 · Component Specifications

### Nav / Header
| Property | Value |
|---|---|
| Background | `#0D1B2A` dark navy |
| Height | 52px · padding 0 24px |
| Border-bottom | `1px solid rgba(201,168,76,0.2)` |
| Wordmark | DM Serif Display 18px · `#D4AF37` |
| Tagline | DM Sans 10px · 0.1em tracking · `rgba(212,175,55,0.45)` · uppercase |
| Timestamp | DM Sans 10px · `rgba(212,175,55,0.4)` · right-aligned |

### Asset Card
| Property | Value |
|---|---|
| Background | `#FFFFFF` — white lifts from warm page |
| Border | `0.5px solid rgba(201,168,76,0.35)` |
| Border-radius | 10px |
| Border-top (hero only) | `2px solid #D4AF37` |
| Padding | 16px |
| Box-shadow | None — elevation from border only |
| Hover | border-color → `rgba(201,168,76,0.6)` · transition 0.2s |

### Card Structure (inside each panel)
1. **Data label** — 10px DM Sans 500 · `#C9A84C` · uppercase · 0.08em tracking
2. **Primary value** — DM Serif Display 26px · `#0D1B2A`
3. **Delta line** — DM Sans 12px 500 · `#0F6E56` or `#A32D2D`
4. **Impact bar** — 3px height · border-radius 2px · colour matches delta
5. **Sparkline** — 52px tall · no axes (see Chart 1)
6. **Timestamp** — DM Sans 10px · `#8A96A4`

### Delta Values
- Positive: `+` prefix · `#0F6E56` · weight 500
- Negative: `−` minus (not hyphen) · `#A32D2D` · weight 500
- Format: always show % and absolute — e.g. `+1.8%  +$41.20`

### Intelligence Strip
Single sentence of market context. Layout: 6px gold circle dot + 11px DM Sans text.
```css
padding: 10px 16px;
border-top: 0.5px solid rgba(201,168,76,0.25);
```
> One sentence only. Never bullet points inside the strip.

### Fear & Greed Gauge (Canvas 2D — not Chart.js)
| Range | Label | Colour |
|---|---|---|
| 0–24 | Extreme fear | `#A32D2D` |
| 25–44 | Fear | `#B8952A` |
| 45–55 | Neutral | `#8A96A4` |
| 56–75 | Greed | `#0F6E56` |
| 76–100 | Extreme greed | `#085041` |

Value: DM Serif Display 38px · `#0D1B2A` · centred below arc

### Scenario Buttons
| State | Style |
|---|---|
| Inactive | `border: 0.5px solid #C8D0D8` · `color: #8A96A4` · transparent bg |
| Geopolitical conflict | `bg: #FCEBEB` · `border: #A32D2D` · `color: #791F1F` |
| Rate hike cycle | `bg: #FAEEDA` · `border: #854F0B` · `color: #633806` |
| Supply chain shock | `bg: #E1F5EE` · `border: #0F6E56` · `color: #085041` |
| Market correction | `bg: #EEEDFE` · `border: #534AB7` · `color: #3C3489` |

---

## 06 · Charts & Visualisations

**Library:** Chart.js 4.4.1 via CDN  
**World map:** D3 7.8.5 + TopoJSON 3.0.2  

> Canvas cannot resolve CSS variables — always use hardcoded hex in Chart.js config.  
> No pie charts. Ever.

### Shared colour constants
```js
const AURUM = {
  navy:     '#0D1B2A',
  gold:     '#D4AF37',
  gold5:    '#C9A84C',
  up:       '#0F6E56',
  down:     '#A32D2D',
  caution:  '#B8952A',
  muted:    '#8A96A4',
  gridLine: 'rgba(201,168,76,0.08)',
  areaFill: 'rgba(212,175,55,0.07)',
};
```

### Chart 1 · Sparklines (inline in every asset panel)
| Property | Value |
|---|---|
| Container height | 52px |
| Axes | None — shape is the signal |
| Tooltips | Disabled |
| Points | `pointRadius: 0` |
| Tension | 0.3 |
| Metals colour | `#D4AF37` gold |
| Positive index | `#0F6E56` teal-green |
| Negative index | `#A32D2D` red |
| Data source | `data.history[key].slice(-30)` |

### Chart 2 · Area Chart (gold price, full-width expandable)
| Property | Value |
|---|---|
| Container height | 200px |
| Y-axis position | Right — avoids fighting date labels |
| Fill | `rgba(212,175,55,0.07)` — barely visible gold tint |
| Line | `#D4AF37` · borderWidth 1.5 · tension 0.3 |
| Time ranges | 7D / 30D / 90D — destroy + recreate chart on switch |
| Data source | `data.history.gold.slice(-N)` |

### Chart 3 · Fear & Greed Gauge (Canvas 2D)
| Property | Value |
|---|---|
| Type | Canvas 2D — NOT Chart.js doughnut |
| Arc track bg | `rgba(201,168,76,0.1)` · lineWidth 14 |
| Zone arcs | lineWidth 14 · lineCap butt |
| Needle | `#0D1B2A` · lineWidth 2 · lineCap round |
| Data source | `data.fearGreed.value` (integer 0–100) |

### Chart 4 · Horizontal Bar (global indices)
| Property | Value |
|---|---|
| indexAxis | `y` — horizontal layout |
| Container height | `(bars × 36) + 60` px |
| Positive bar | `rgba(15,110,86,0.75)` · border `#0F6E56` |
| Negative bar | `rgba(163,45,45,0.75)` · border `#A32D2D` |
| Indices | Nikkei, DAX, S&P 500, FTSE, CAC 40, Hang Seng |
| Data source | `data.indices` — map each to `.change` |

### Chart 5 · Scatter Plot (gold vs 10Y yield correlation)
| Property | Value |
|---|---|
| Purpose | Show inverse relationship — Aurum's intelligence differentiator |
| Container height | 220px |
| Point style | circle · r=5 · `rgba(212,175,55,0.65)` |
| X axis | 10Y yield (%) |
| Y axis | Gold ($/oz) · right position |
| r badge | Correlation coefficient displayed top-right of card |
| Data source | `data.history.gold` + `data.history.treasury10y` (last 90 days) |

### Chart 6 · World Choropleth (geopolitical risk, D3)
| Risk score | Colour | Level |
|---|---|---|
| 0–19 | `rgba(13,27,42,0.06)` | Stable |
| 20–39 | `rgba(13,27,42,0.15)` | Low |
| 40–59 | `rgba(184,149,42,0.35)` | Elevated |
| 60–79 | `rgba(163,45,45,0.5)` | High |
| 80–100 | `#A32D2D` | Active conflict |

Topology: `cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json`  
Projection: `d3.geoNaturalEarth1()`  
Country borders: `rgba(249,246,240,0.6)` · strokeWidth 0.4  
Data source: `data.geopolitical.riskByCountry` (ISO alpha-3 keyed, 0–100)

---

## 07 · Dashboard Layout

| Row | Panel | Contents |
|---|---|---|
| Row 0 | Nav | Full width · 52px · Wordmark + timestamp |
| Row 1 | Hero strip | Fear & Greed gauge (left) + Top mover + Timestamp |
| Row 2 | Macro signals | 4 columns: 10Y Yield · Yield Curve · CPI · Fed Rate |
| Row 3a | Main grid | 3 columns: Metals · Global Indices · FX Rates |
| Row 3b | Gold deep-dive | Full-width expandable: Area chart + Scatter plot |
| Row 4 | Intelligence | 2 columns: Geopolitical map + feed · Crypto signals |
| Row 5 | Scenario bar | Full width · 5 scenario buttons |

### Chart placement per panel
| Panel | Chart(s) |
|---|---|
| Hero strip | Fear & Greed gauge (Canvas 2D) |
| Metals panel | 3 inline sparklines (Gold, Silver, Platinum) |
| Indices panel | 4 inline sparklines + 1 horizontal bar chart |
| FX panel | 3 inline sparklines (EUR/USD, GBP/USD, USD/JPY) |
| Gold deep-dive | Area chart (90D) + Scatter (gold vs yield) |
| Geopolitical panel | World choropleth map (D3) + news feed below |
| Crypto panel | 2 sparklines (BTC, ETH) + 30D area chart |

---

## 08 · Data Binding & JSON Schema

All data comes from one JSON snapshot fetched from a GitHub Gist:

```js
const DATA_URL = 'https://gist.githubusercontent.com/[USER]/[GIST_ID]/raw/aurum-data.json';
const data = await fetch(DATA_URL).then(r => r.json());
```

### JSON schema

| Key | Type | Contents |
|---|---|---|
| `meta` | object | `updated` (ISO timestamp), `stale` (bool) |
| `fearGreed` | object | `value` (0–100), `classification`, `previousClose` |
| `metals` | object | gold, silver, platinum — each: `price`, `change`, `changeAbs` |
| `indices` | object | sp500, dax, ftse, nikkei — each: `price`, `change` |
| `fx` | object | EURUSD, GBPUSD, USDJPY, USDCHF — each: `rate`, `change` |
| `macro` | object | treasury10y, yieldSpread, cpi, fedFunds — each: `rate`, `change` |
| `crypto` | object | bitcoin, ethereum — each: `price`, `change` |
| `sentiment` | object | `signal`, `headline`, `newsItems[]` |
| `history` | object | 90-item arrays: gold, silver, sp500, dax, ftse, nikkei, eurusd, treasury10y, bitcoin |
| `geopolitical` | object | `riskByCountry` (ISO-3 keyed, 0–100), `updatedAt` |

---

## 09 · API Stack

### Keyless — no signup required

| Data | Source | Endpoint | Refresh |
|---|---|---|---|
| Fear & Greed index | alternative.me | `api.alternative.me/fng/?limit=1` | Daily |
| FX rates (170+ pairs) | open.er-api.com | `open.er-api.com/v6/latest/USD` | Daily |
| Gold historical (768yr) | freegoldapi.com | `freegoldapi.com/data/latest.csv` | Daily 6am UTC |
| Stocks / indices | yahoo-finance2 (npm) | Node.js package — unofficial | Near-live |
| Geopolitical events | GDELT Project | `api.gdeltproject.org/api/v2/doc/doc` | 15-min |

### Free tier with API key — sign up in this order

| # | Data | Source | Free limit | Sign-up |
|---|---|---|---|---|
| 1 | Markets, FX, commodities | Alpha Vantage | 25 req/day | alphavantage.co/support/#api-key |
| 2 | Macro: CPI, yields, GDP | FRED (St. Louis Fed) | 120 req/min | fred.stlouisfed.org → API Keys |
| 3 | Financial news headlines | NewsAPI | 100 req/day | newsapi.org/register |
| 4 | Gold, silver, platinum spot | metals.dev | 100 req/month | metals.dev → sign up |
| 5 | Bitcoin / crypto signals | CoinGecko | 30 calls/min | coingecko.com/en/api |

> All keys go into `.env` at repo root — never committed to GitHub. Netlify reads them as environment variables. GitHub Actions reads them as repository secrets.

---

## 10 · Motion & Interaction

> Philosophy: motion confirms state changes, never decorates.

| Interaction | Behaviour |
|---|---|
| Page load | Staggered `fadeUp` per row — opacity 0→1, translateY 6px→0, 400ms ease-out, delays 0/80/160/240/320ms |
| Value update | Flash to `#D4AF37` on data refresh, `transition: color 0.15s`, then back to navy |
| Card hover | `border-color` → `rgba(201,168,76,0.6)` · `transition: border-color 0.2s ease` |
| Scenario tint | Background opacity fade-in 0.35s |
| Skeleton loader | `@keyframes pulse` · opacity 0.4→0.8→0.4 · 1.6s infinite · `rgba(201,168,76,0.08)` bg |
| Reduced motion | `@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }` |

Never use: parallax · scroll animations · entrance animations on repeat visits · physics engines.

---

## 11 · The Six Premium Rules

**1. No drop shadows. Ever.**  
Elevation comes from border colour contrast only. A 0.5px gold-tinted border on a white card against a warm off-white page is all the depth Aurum needs.

**2. Gold touches exactly three things: labels, borders, active states.**  
Touch more than three things and it reads tacky. Every additional gold element dilutes the ones that matter.

**3. DM Serif Display on values only.**  
If it's not a number — a price, a rate, an index level — it's DM Sans. This single contrast signals "this data means something" without a word.

**4. Warm off-white page (`#F9F6F0`).**  
Pure white reads clinical and free. Warm off-white reads considered and expensive. The difference is 6 hex digits.

**5. Navy text (`#0D1B2A`), not black.**  
The blue undertones in the navy harmonise with gold accents. Pure black next to gold creates harsh contrast; navy creates a relationship.

**6. Generous whitespace inside panels.**  
Fewer numbers shown with confidence reads smarter than many numbers shown with anxiety. Aurum is a dashboard, not a terminal.

---

*Aurum Design Specification v1.0 · March 2026 · Anina Black*
