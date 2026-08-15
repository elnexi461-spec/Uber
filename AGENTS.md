# Uber Project — Agent Memory

## Project goal
Extract REAL Uber fares for the Hong Kong route
沙田醫院 (22.395771, 114.217333) → 南方花園 (22.325528, 114.190810)
and feed them into the existing 89-column CSV pipeline.

## Known manual fares (ground truth for verification)
UberX HK$151.16, Taxi HK$149.98, Comfort HK$160.26, UberXL HK$207.00,
UberXXL HK$219.00, Black HK$221.00, Uber Pet HK$171.00, Assist HK$151.00.

## Key facts
- Anonymous/guest m.uber.com sessions return products but with EMPTY fares
  (fare="", fareAmountE5=null). Real fares require an AUTHENTICATED session.
- OAuth client-credentials flow is BLOCKED (credentials invalid: access_denied /
  unauthorized_client). Do NOT use UBER_ACCESS_TOKEN. Use Playwright web auth.
- The 00026-go-graphql.json capture is anonymous → 13 products, no fares.

## Architecture (do NOT rewrite)
- scripts/src/uber-fare-extract.ts  — Playwright fare extractor (NEW).
  - --login mode: visible Chromium, human logs in, saves
    debug/uber-auth-state.json (gitignored, NEVER commit).
  - default mode: reuses saved session, drives HK route, captures products
    GraphQL, extracts fares from network JSON (not OCR), verifies vs known
    fares, writes debug/uber-fares.json, and writes the raw auth response into
    debug/uber-responses/ for the 89-col pipeline.
  - isLoggedIn() is STRICT: guest jwt-session cookie is NOT enough; requires
    no login CTA + account affordance OR a JWT with a rider UUID sub.
  - Refuses to fabricate: if all fares empty, exits code 6 (guest session).
- scripts/src/uber-public-extract.ts — existing 89-column CSV generator.
  Reads debug/uber-responses/*.json, writes output/public-products.csv (89 cols).
  MUST be run from project root (uses process.cwd()).
- scripts/src/uber-autonomous.ts — original Playwright network capture (reused pattern).
- scripts/src/types.ts — Route, Product, Fare, Navigation, OutputRow (89-col).

## Run commands (from project root)
- Visible login:   DISPLAY=:99 ./scripts/node_modules/.bin/tsx scripts/src/uber-fare-extract.ts --login
- Extract fares:   DISPLAY=:99 ./scripts/node_modules/.bin/tsx scripts/src/uber-fare-extract.ts
- Build 89-col CSV: ./scripts/node_modules/.bin/tsx scripts/src/uber-public-extract.ts
- Typecheck:       cd scripts && npx tsc -p tsconfig.json --noEmit
- Unit tests:      npx tsx /tmp/test-extract.mjs  (synthetic, all 8 fares match)
                   npx tsx /tmp/test-real.mjs     (real anonymous capture shape)

## Environment
- No X server by default. Xvfb installed at /usr/bin/Xvfb.
  Start: `Xvfb :99 -screen 0 1280x960x24 >/tmp/xvfb.log 2>&1 &` then `export DISPLAY=:99`.
- Playwright Chromium at /home/openhands/.cache/ms-playwright/chromium-1234/.
- Node v22.23.2, pnpm, tsx 4.23.1. esbuild approved.
- tsconfig: target es2022, module esnext, moduleResolution bundler, strictNullChecks.

## Gotchas
- TS template literal must close with backtick, not `"`. (caused parser cascade)
- Module side-effects: guard `main()` with `import.meta.url === file://${process.argv[1]}`
  so the module is importable for unit tests without launching a browser.
- Never commit debug/uber-auth-state.json (cookies/session). Already gitignored.
- The agent CANNOT perform Uber login (phone/SMS/MFA/CAPTCHA) — only the human can.
  The script waits up to 10 min for the human; timeout = no false save.

## Status
- Fare extraction logic: DONE & verified (unit tests pass, all 8 known fares match).
- Browser launch under Xvfb: works; strict login check no longer false-positives.
- 89-column pipeline integration: wired (auth response → debug/uber-responses/).
- BLOCKER on real fare extraction: requires a human to run --login and authenticate.
  Once done, extraction + 89-col CSV will populate real fares automatically.
