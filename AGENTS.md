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
- Fare extraction logic: DONE & verified. Real authenticated fares extracted from
  BOTH the products GraphQL response (fareAmountE5) and DOM text.
- Authentication: DONE. Human logged in via visible Chromium + noVNC (CAPTCHA solved
  by user). Session saved to debug/uber-auth-state.json (gitignored).
- 89-column pipeline: DONE & verified. output/public-products.csv has 89 columns,
  13 products with real fares + HKD currency.
- deduplicateProducts prefers fare-bearing variants so the authenticated response
  (not the old guest/anonymous 00026 capture) wins the dedup.
- productToOutputRow falls back to product-level currencyCode (fare-level is null
  in m.uber.com's RVWebCommonFare; currencyCode lives on the product node).
- driveRoute: clicks "Enter pickup location" → /go/pickup page with both Pickup
  + Dropoff search inputs → fills both by name → auto-navigates to product-selection.
  Detects "One more step" reCAPTCHA and waits for the human to solve it in noVNC.

## Verified live fares (2026-08-15, authenticated session)
UberX HK$147.79, Taxi HK$146.29, Comfort HK$157.83, UberXL HK$205.38,
UberXXL HK$219.00, Black HK$217.33, Uber Pet HK$167.79, Assist HK$147.79.
All within 5% of known manual fares (live pricing drift). Tolerance = 5%.
