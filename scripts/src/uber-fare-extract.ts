/**
 * Real Uber fare extractor for the Hong Kong route
 *   沙田醫院 (22.395771, 114.217333) → 南方花園 (22.325528, 114.190810)
 *
 * Reuses the Playwright + network-capture pattern from uber-autonomous.ts.
 *
 * Flow:
 *   1. Reuse a saved authenticated session at debug/uber-auth-state.json if present.
 *   2. Otherwise launch a VISIBLE Chromium, open m.uber.com, wait for a human to
 *      log in (no credentials/MFA are touched by this script), then save the
 *      session via context.storageState().
 *   3. Drive the HK route to the ride-selection screen.
 *   4. Capture the authenticated products GraphQL response (the same operation
 *      that uber-autonomous.ts already captures, but now with real fares).
 *   5. Extract REAL fares from DOM/network JSON (never OCR, never fabricated).
 *   6. Save minimal debug evidence (debug/uber-fares.json + one screenshot).
 *   7. Verify extracted values against the known manual fares.
 *
 * Security: the saved auth state is gitignored and never logged/committed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from "playwright";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(dirname(SCRIPT_DIR));
const DEBUG_DIR = join(PROJECT_DIR, "debug");
const OUTPUT_DIR = join(PROJECT_DIR, "output");
const AUTH_STATE_PATH = join(DEBUG_DIR, "uber-auth-state.json");
const FARES_PATH = join(DEBUG_DIR, "uber-fares.json");
const SCREENSHOT_PATH = join(DEBUG_DIR, "uber-ride-selection.png");
const RESPONSE_DIR = join(DEBUG_DIR, "uber-responses");

const HOME_URL = "https://m.uber.com/";
const ROUTE = {
  pickupName: "沙田醫院",
  destinationName: "南方花園",
  pickup: { lat: 22.395771, lng: 114.217333 },
  destination: { lat: 22.325528, lng: 114.19081 },
};

// Manually confirmed reference fares (real authenticated session).
const EXPECTED_FARES: Record<string, number> = {
  UberX: 151.16,
  Taxi: 149.98,
  Comfort: 160.26,
  UberXL: 207.0,
  UberXXL: 219.0,
  Black: 221.0,
  "Uber Pet": 171.0,
  Assist: 151.0,
};

// Tolerance for surge/promo drift between captures.
const FARE_TOLERANCE = 0.02; // 2%

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface ExtractedFare {
  displayName: string;
  fare: string | null;
  fareAmountE5: number | null;
  currencyCode: string | null;
  formattedFare: string | null;
  source: string;
}

interface Verification {
  displayName: string;
  expected: number | null;
  extracted: number | null;
  delta: number | null;
  withinTolerance: boolean;
  status: "match" | "mismatch" | "no_reference" | "not_extracted";
}

const productsResponses: { url: string; json: Json }[] = [];

function isUberRequest(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "uber.com" || hostname.endsWith(".uber.com");
  } catch {
    return false;
  }
}

function looksLikeProductsResponse(url: string, json: Json): boolean {
  if (!isUberRequest(url)) return false;
  // The m.uber.com products GraphQL operation exposes tiers[].products[].fares[]
  const data = (json as { data?: Json })?.data;
  if (typeof data !== "object" || !data) return false;
  const products = (data as { products?: Json })?.products;
  if (typeof products !== "object" || !products) return false;
  const tiers = (products as { tiers?: Json })?.tiers;
  return Array.isArray(tiers);
}

function onUberResponse(response: Response): void {
  const url = response.url();
  if (!isUberRequest(url)) return;
  response
    .body()
    .then(async (body) => {
      const ct = (response.headers()["content-type"] ?? "").toLowerCase();
      const isJson = ct.includes("json") || body.slice(0, 1).toString("utf8") === "{";
      if (!isJson) return;
      let json: Json;
      try {
        json = JSON.parse(body.toString("utf8")) as Json;
      } catch {
        return;
      }
      if (looksLikeProductsResponse(url, json)) {
        productsResponses.push({ url, json });
        await mkdir(RESPONSE_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = join(RESPONSE_DIR, `products-auth-${stamp}.json`);
        await writeFile(file, body);
        console.log(`  captured products response -> ${file}`);
      }
    })
    .catch(() => {
      /* ignore response read failures */
    });
}

function num(value: Json): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: Json): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseMoney(text: string | null): number | null {
  if (!text) return null;
  // Match a decimal magnitude, ignoring currency symbols/code (HK$, HKD, $).
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const v = Number(match[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Extract real fares from the authenticated products GraphQL response.
 * Reads fares[].fare / fareAmountE5 / currencyCode and formatted strings.
 */
export function extractFaresFromProducts(json: Json): ExtractedFare[] {
  const out: ExtractedFare[] = [];
  const data = (json as { data?: Json })?.data;
  const products = (data as { products?: Json })?.products;
  const tiers = (products as { tiers?: Json })?.tiers;
  if (!Array.isArray(tiers)) return out;
  for (const tier of tiers) {
    const items = (tier as { products?: Json })?.products;
    if (!Array.isArray(items)) continue;
    for (const p of items) {
      const node = p as { [key: string]: Json };
      const displayName = str(node.displayName) ?? str(node.description) ?? "(unknown)";
      const fares = node.fares;
      const fareNode = Array.isArray(fares) && fares.length > 0 ? (fares[0] as { [key: string]: Json }) : {};
      const fareStr = str(fareNode.fare) ?? str(node.preAdjustmentValue);
      const fareAmountE5 = num(fareNode.fareAmountE5);
      const currencyCode = str(fareNode.currencyCode) ?? str(node.currencyCode);
      const formattedFare =
        str(fareNode.formattedFare) ??
        str(fareNode.discountPrimary) ??
        str(fareNode.formattedFareDisplay) ??
        null;
      out.push({
        displayName,
        fare: fareStr,
        fareAmountE5,
        currencyCode,
        formattedFare,
        source: "products.graphql",
      });
    }
  }
  return out;
}

/** Pick the best numeric fare for a product, preferring exact magnitude fields. */
export function fareMagnitude(f: ExtractedFare): number | null {
  if (f.fareAmountE5 !== null) return f.fareAmountE5 / 1e5;
  const fromFare = parseMoney(f.fare);
  if (fromFare !== null) return fromFare;
  return parseMoney(f.formattedFare);
}

export function verifyFares(extracted: ExtractedFare[]): Verification[] {
  const byName = new Map(extracted.map((f) => [f.displayName, f]));
  const results: Verification[] = [];
  for (const [name, expected] of Object.entries(EXPECTED_FARES)) {
    const f = byName.get(name);
    const extractedVal = f ? fareMagnitude(f) : null;
    if (extractedVal === null) {
      results.push({ displayName: name, expected, extracted: null, delta: null, withinTolerance: false, status: "not_extracted" });
      continue;
    }
    const delta = extractedVal - expected;
    const withinTolerance = Math.abs(delta) <= expected * FARE_TOLERANCE;
    results.push({
      displayName: name,
      expected,
      extracted: extractedVal,
      delta: Number(delta.toFixed(2)),
      withinTolerance,
      status: withinTolerance ? "match" : "mismatch",
    });
  }
  // Report any extracted products that have no reference (informational).
  for (const f of extracted) {
    if (!(f.displayName in EXPECTED_FARES)) {
      const v = fareMagnitude(f);
      results.push({ displayName: f.displayName, expected: null, extracted: v, delta: null, withinTolerance: false, status: "no_reference" });
    }
  }
  return results;
}

async function isLoggedIn(page: Page): Promise<boolean> {
  // Authenticated m.uber.com shows the ride planner with an account affordance
  // and NO "Log in" / "Continue with phone" CTA. Guest sessions set a
  // jwt-session cookie too, so a cookie alone is NOT a reliable signal.
  const body = await page.locator("body").innerText().catch(() => "");
  const hasLoginCta = /log in|sign in|continue with phone|get started|登入|create account/i.test(body);
  if (hasLoginCta) return false;
  // An authenticated session exposes an account/profile entry point.
  const accountLocator = page
    .getByRole("button", { name: /account|profile|menu/i })
    .or(page.getByRole("link", { name: /account|profile/i }))
    .or(page.locator('[data-testid*="account" i], [aria-label*="account" i]'));
  const hasAccount = await accountLocator.first().isVisible().catch(() => false);
  if (hasAccount) return true;
  // Fallback: a jwt-session cookie whose JWT payload carries a rider subject.
  const cookies = await page.context().cookies("https://m.uber.com/");
  const jwt = cookies.find((c) => c.name === "jwt-session");
  if (jwt) {
    const payload = jwt.value.split(".")[1];
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { sub?: string; user_id?: string; rider_id?: string; uuid?: string };
      const riderId = decoded.sub ?? decoded.user_id ?? decoded.rider_id ?? decoded.uuid;
      // Guest JWTs carry an empty / placeholder subject; real riders have a UUID.
      if (riderId && /^[0-9a-f]{8}-/i.test(riderId)) return true;
    } catch {
      /* not a JWT */
    }
  }
  return false;
}

async function saveAuthState(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  await mkdir(DEBUG_DIR, { recursive: true });
  await writeFile(AUTH_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  console.log(`Auth session saved -> ${AUTH_STATE_PATH} (gitignored; never commit)`);
}

async function waitForLogin(page: Page, timeoutMs: number): Promise<boolean> {
  console.log("\n>>> VISIBLE BROWSER OPENED FOR MANUAL UBER AUTHENTICATION <<<");
  console.log("    Please complete login (phone/SMS/MFA) in the browser window.");
  console.log("    This script does NOT touch passwords, OTPs, or CAPTCHA.");
  console.log(`    Waiting up to ${Math.round(timeoutMs / 60000)} min for login...\n`);
  await page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(page)) {
      console.log("    Login detected.");
      return true;
    }
  }
  return false;
}

async function clickByRole(page: Page, patterns: RegExp[]): Promise<boolean> {
  for (const pattern of patterns) {
    const loc = page.getByRole("button", { name: pattern }).or(page.getByRole("link", { name: pattern })).first();
    try {
      await loc.waitFor({ state: "visible", timeout: 1500 });
      await loc.click({ timeout: 2000 });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function chooseLocationInput(
  page: Page,
  kind: "pickup" | "destination",
): Promise<Locator | null> {
  const candidates = [
    page.getByRole("textbox", { name: /where to|destination|dropoff/i }),
    page.getByRole("textbox", { name: /pickup/i }),
    page.getByPlaceholder(/where to|destination|dropoff|pickup/i),
  ];
  for (const c of candidates) {
    try {
      const first = c.first();
      await first.waitFor({ state: "visible", timeout: 1500 });
      return first;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fillLocation(
  page: Page,
  kind: "pickup" | "destination",
  name: string,
  coords: string,
): Promise<boolean> {
  await clickByRole(
    page,
    kind === "pickup"
      ? [/pickup/i, /edit pickup/i]
      : [/dropoff/i, /where to/i, /destination/i, /plan a ride/i],
  );
  await page.waitForTimeout(500);
  const input = await chooseLocationInput(page, kind);
  if (!input) {
    console.log(`  [${kind}] no input found`);
    return false;
  }
  await input.click();
  await input.fill(name);
  await page.waitForTimeout(1500);
  // Click the first suggestion matching the place name.
  const suggestion = page.locator('[role="option"], [role="listbox"] [role="option"], li').filter({ hasText: name }).first();
  try {
    await suggestion.waitFor({ state: "visible", timeout: 4000 });
    await suggestion.click({ timeout: 2000 });
    console.log(`  [${kind}] selected by name: ${name}`);
    return true;
  } catch {
    /* fall back to coordinates */
  }
  await input.fill(coords);
  await page.waitForTimeout(1500);
  try {
    await page.locator('[role="option"], li').first().click({ timeout: 3000 });
    console.log(`  [${kind}] selected by coordinates: ${coords}`);
    return true;
  } catch {
    console.log(`  [${kind}] could not select suggestion`);
    return false;
  }
}

async function driveRoute(page: Page): Promise<boolean> {
  await clickByRole(page, [/accept all/i, /^accept$/i, /^got it$/i]);
  await clickByRole(page, [/where to/i, /enter destination/i, /plan a ride/i]);
  const destOk = await fillLocation(page, "destination", ROUTE.destinationName, `${ROUTE.destination.lat},${ROUTE.destination.lng}`);
  if (!destOk) return false;
  const pickOk = await fillLocation(page, "pickup", ROUTE.pickupName, `${ROUTE.pickup.lat},${ROUTE.pickup.lng}`);
  if (!pickOk) return false;
  await clickByRole(page, [/see prices/i, /view prices/i, /show prices/i, /get a ride/i]);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText().catch(() => "");
    if (/HK\$|HKD|UberX|fare/i.test(body)) {
      console.log("  ride-selection screen reached (price text detected).");
      await page.waitForTimeout(4000); // let products GraphQL settle
      return true;
    }
  }
  console.log("  ride-selection screen not detected within 60s.");
  return false;
}

async function main(): Promise<void> {
  await mkdir(DEBUG_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const hasState = existsSync(AUTH_STATE_PATH);
  const loginMode = process.argv.includes("--login");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: false });
    const contextOpts: Parameters<Browser["newContext"]>[0] = {
      ...devices["iPhone 13"],
      locale: "en-HK",
      timezoneId: "Asia/Hong_Kong",
      geolocation: { latitude: ROUTE.pickup.lat, longitude: ROUTE.pickup.lng },
      permissions: ["geolocation"],
    };
    if (hasState && !loginMode) {
      contextOpts.storageState = AUTH_STATE_PATH;
      console.log(`Reusing saved session: ${AUTH_STATE_PATH}`);
    }
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    page.on("response", onUberResponse);

    if (!hasState || loginMode) {
      const ok = await waitForLogin(page, 10 * 60 * 1000);
      if (!ok) {
        console.error("Login was not completed within the timeout. Re-run with --login to retry.");
        process.exitCode = 2;
        return;
      }
      await saveAuthState(context);
      if (loginMode) {
        console.log("Login mode complete. Re-run without --login to extract fares.");
        return;
      }
    }

    console.log(`\nNavigating to ${HOME_URL} with saved session...`);
    await page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 });
    if (!(await isLoggedIn(page))) {
      console.error("Saved session is no longer authenticated. Re-run with --login.");
      process.exitCode = 2;
      return;
    }

    console.log("Driving HK route to ride-selection screen...");
    const reached = await driveRoute(page);
    if (!reached) {
      console.error("Could not reach the ride-selection screen.");
      process.exitCode = 3;
    }
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
    console.log(`Screenshot -> ${SCREENSHOT_PATH}`);

    if (productsResponses.length === 0) {
      console.error("No authenticated products GraphQL response was captured.");
      process.exitCode = 4;
      return;
    }

    const merged = productsResponses.map((r) => extractFaresFromProducts(r.json)).flat();
    const latest = productsResponses[productsResponses.length - 1];
    const fares = extractFaresFromProducts(latest.json);
    const anyRealFare = (merged.length ? merged : fares).some((f) => fareMagnitude(f) !== null);
    if (!anyRealFare) {
      console.error(
        "Products response captured but all fares are empty — the session is a GUEST/anonymous " +
          "session, not an authenticated rider. Re-run with --login and complete Uber login.",
      );
      await writeFile(
        FARES_PATH,
        JSON.stringify({ taskId: "hk_202606192058594097", capturedAt: new Date().toISOString(), route: ROUTE, fares, authenticated: false }, null, 2) + "\n",
        "utf8",
      );
      process.exitCode = 6;
      return;
    }
    const verifications = verifyFares(merged.length ? merged : fares);

    await writeFile(
      FARES_PATH,
      JSON.stringify(
        {
          taskId: "hk_202606192058594097",
          capturedAt: new Date().toISOString(),
          route: ROUTE,
          productsResponseUrl: latest.url,
          fares,
          verifications,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`\nExtracted fares -> ${FARES_PATH}`);
    console.log("\n=== Fare verification (vs known manual fares) ===");
    let allMatch = true;
    for (const v of verifications) {
      if (v.status === "no_reference") continue;
      const tag =
        v.status === "match" ? "OK " :
        v.status === "mismatch" ? "!! " :
        v.status === "not_extracted" ? "-- " : "?? ";
      console.log(`  ${tag}${v.displayName}: expected=${v.expected} extracted=${v.extracted} delta=${v.delta}`);
      if (tag !== "OK ") allMatch = false;
    }
    console.log(`\nRESULT: ${allMatch ? "ALL KNOWN FARES MATCH" : "MISMATCH/MISSING — review debug/uber-fares.json"}`);

    // Hand off to the 89-column pipeline: write the raw authenticated products
    // GraphQL response into debug/uber-responses/ so uber-public-extract.ts can
    // ingest it without schema changes. Only written when real fares were found.
    await mkdir(RESPONSE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "");
    const respPath = join(RESPONSE_DIR, `${stamp}-go-graphql-auth.json`);
    await writeFile(respPath, JSON.stringify(latest.json, null, 2) + "\n", "utf8");
    console.log(`\nAuth products response -> ${respPath}`);
    console.log('To build the 89-column CSV, run: pnpm uber-extract');
    if (!allMatch) process.exitCode = 5;
  } finally {
    await browser?.close();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error: unknown) => {
    console.error("Uber fare extraction failed:", error);
    process.exitCode = 1;
  });
}
