# Uber Fare Monitor — Production Dashboard

Minimal production frontend and API built around the existing Uber extraction engine.

## What this is

A zero-new-dependency Node.js HTTP server (`scripts/src/server.ts`) that:
- Serves a static dashboard (`dashboard/`) with 6 views: **Dashboard, Routes, Prices, Jobs, Verification, Exports**
- Exposes a minimal API that reads the existing pipeline outputs and operational artifacts
- Triggers batch runs via the existing hardened `uber-monitor.ts` (Playwright + Chromium)

It reuses the existing types, functions, outputs, and session handling — **the extraction engine and 89-column pipeline are untouched**.

## Run locally

```bash
# From the scripts directory (Playwright + tsx already installed)
cd scripts
PORT=3000 npx tsx ./src/server.ts
```

Then open http://localhost:3000/

For Playwright batch runs (needs a display):
```bash
Xvfb :99 -screen 0 1280x960x24 & DISPLAY=:99 PORT=3000 npx tsx ./src/server.ts
```

## Railway deployment

The `nixpacks.toml` at the repo root configures Railway to:
1. Install Chromium runtime dependencies
2. Install pnpm dependencies (Playwright + tsx)
3. Install the Playwright Chromium browser
4. Start the server via `tsx ./src/server.ts`

Railway injects `PORT` automatically; the server binds to `0.0.0.0:$PORT`.

## Authenticated session (Render/Railway secret)

The authenticated Playwright session (`debug/uber-auth-state.json`) is gitignored
and **never committed** — it contains live credentials. On Render/Railway, supply
it via the `UBER_AUTH_STATE_B64` environment variable/secret:

1. Locally, base64-encode the existing storage state:
   ```bash
   base64 -w0 debug/uber-auth-state.json
   ```
2. In the Render/Railway dashboard, add a secret `UBER_AUTH_STATE_B64` with that
   value.

At startup, the server decodes the secret, validates it is a Playwright storage
state (has `cookies`), and recreates `debug/uber-auth-state.json` **before any
monitor batch runs**. The extractor, monitor, `AUTH_STATE_PATH`, checkpointing,
caching, and 89-column pipeline are all unchanged. If the secret is absent, the
server falls back to an existing file (local dev). `/api/health` reports the
session source (`provisioned` | `file` | `none`).

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Healthcheck (Railway) — reports auth session source (`provisioned`/`file`/`none`) + Playwright presence |
| GET | `/api/dashboard` | Summary metrics (monitor + pipeline + verification) |
| GET | `/api/routes` | Known routes (pipeline + checkpoint + cache) |
| GET | `/api/prices` | Real extracted fares (89-col pipeline + monitor cache) |
| GET | `/api/jobs` | Job state (from monitor checkpoint) |
| POST | `/api/jobs/run` | Trigger a monitor batch run (spawns uber-monitor.ts) |
| GET | `/api/verification` | Fare verification vs known manual fares |
| GET | `/api/exports` | List exportable files |
| GET | `/api/exports/download?file=` | Download a file (session state is blocked) |
| GET | `/api/monitor/log` | Recent monitor log |

## Security

- Never reads or serves `debug/uber-auth-state.json` (session/cookies)
- Path traversal protection on all file-serving endpoints
- No passwords, OTPs, or session contents are logged or exposed

## Data sources (all reused, none modified)

- `output/public-products.json` / `.csv` — 89-column pipeline output
- `debug/monitor-metrics.json` — hardened monitor metrics
- `debug/monitor-cache.json` — collected fares cache
- `debug/monitor-checkpoint.json` — job state
- `debug/uber-fares.json` — fare verification
