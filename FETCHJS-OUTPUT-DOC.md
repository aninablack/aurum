# Aurum fetch.js Output Document

## Purpose
`fetch.js` aggregates market, macro, sentiment, crypto, and geopolitical data into one snapshot and writes it to `aurum-data.json` in your configured GitHub Gist.

## Runtime
- Triggered by GitHub Actions (`aurum-pipeline.yml`)
- Schedule: every 15 minutes (Mon-Fri) + weekend keepalive run
- Environment: Node.js 20

## Required Secrets
- `ALPHA_VANTAGE_KEY`
- `FRED_KEY`
- `NEWS_API_KEY`
- `METALS_DEV_KEY`
- `COINGECKO_KEY` (optional but recommended)
- `GIST_ID`
- `GIST_TOKEN`

## Data Sources
- Fear & Greed: `alternative.me`
- FX: `open.er-api.com`
- Metals: `metals.dev` (+ `freegoldapi.com` fallback for gold)
- Indices proxies: `Alpha Vantage`
- Macro: `FRED`
- News sentiment: `NewsAPI`
- Crypto: `CoinGecko`
- Geopolitical risk: `GDELT`

## Output Shape (Top-Level)
- `meta`
- `fearGreed`
- `metals`
- `indices`
- `fx`
- `macro`
- `crypto`
- `sentiment`
- `geopolitical`
- `history`

## Reliability Behaviors
- Each source is wrapped in `safe(...)` so one failure does not crash the pipeline.
- Previous snapshot data is reused where needed to avoid blank panels.
- Rolling history arrays are maintained up to 90 points.

## Important Fix Applied
The narrative generator now receives gold with full delta context (not just a raw price), so “gold vs yields” logic can actually appear in the intelligence headline.

## Expected Console Outcome
- Successful source fetch logs
- Snapshot write confirmation to Gist
- Final size/history summary
- Explicit failed source list (if any)
