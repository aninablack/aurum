# Aurum

Premium financial intelligence dashboard with macro, sentiment, and geopolitical overlays.

## Project Structure
- `index.html` — dashboard UI shell and design system
- `fetch.js` — scheduled data pipeline
- `.github/workflows/aurum-pipeline.yml` — GitHub Actions scheduler
- `.env.example` — required environment variables

## 1) Local Dry Run (first)
Run the pipeline locally without Gist read/write:

```bash
node fetch.js --dry-run
```

This writes:
- `aurum-data.local.json`

Use this to validate API connectivity and output structure before setting up GitHub secrets.

## 2) Create the GitHub Gist
1. Create a new public or secret Gist.
2. Add one file named `aurum-data.json`.
3. Set initial content to `{}`.
4. Copy the Gist ID into `GIST_ID`.

## 3) Add GitHub Secrets
In your GitHub repo: `Settings -> Secrets and variables -> Actions`, add:
- `ALPHA_VANTAGE_KEY`
- `FRED_KEY`
- `NEWS_API_KEY`
- `METALS_DEV_KEY`
- `COINGECKO_KEY`
- `GIST_ID`
- `GIST_TOKEN`

## 4) Push and Run Pipeline
- Commit and push this repo.
- GitHub Actions will run on schedule.
- You can also trigger manually from `Actions -> Aurum data pipeline -> Run workflow`.

## 5) Deploy to Netlify
1. Connect the GitHub repo to Netlify.
2. For static deployment, publish the project root.
3. If you use a Netlify build hook, add `NETLIFY_BUILD_HOOK` secret in GitHub so each successful pipeline run can trigger a refresh.

## Notes
- `fetch.js --dry-run` intentionally skips Gist read/write.
- The production pipeline writes `aurum-data.json` to your configured Gist.
