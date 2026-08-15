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

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = dirname(dirname(SCRIPT_DIR));
export const DEBUG_DIR = join(PROJECT_DIR, "debug");
export const OUTPUT_DIR = join(PROJECT_DIR, "output");
export const AUTH_STATE_PATH = join(DEBUG_DIR, "uber-auth-state.json");
export const FARES_PATH = join(DEBUG_DIR, "uber-fares.json");
export const SCREENSHOT_PATH = join(DEBUG_DIR, "uber-ride-selection.png");
export const RESPONSE_DIR = join(DEBUG_DIR, "uber-responses");

export const HOME_URL = "https://m.uber.com/";
export const ROUTE: RouteDef = {
  id: "hk_202606192058594097",
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

// Tolerance for surge/promo drift between captures. Live upfront fares fluctuate
// with demand and time of day; 5% accommodates real drift while still catching
// fabricated or stale (guest) values, which differ far more.
const FARE_TOLERANCE = 0.05; // 5%

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A route definition usable by the batch monitor and the single-route CLI. */
export interface RouteDef {
  id: string;
  pickupName: string;
  destinationName: string;
  pickup: { lat: number; lng: number };
  destination: { lat: number; lng: number };
}

export interface ExtractedFare {
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

/** Per-context products-response collector (avoids module-level races). */
export interface ResponseCollector {
  responses: { url: string; json: Json }[];
  handler: (response: Response) => void;
}

export function createResponseCollector(): ResponseCollector {
  const responses: { url: string; json: Json }[] = [];
  const handler = (response: Response): void => {
    const url = response.url();
    if (!isUberRequest(url)) return;
    response
      .body()
      .then((body) => {
        const ct = (response.headers()["content-type"] ?? "").toLowerCase();
        const isJson = ct.includes("json") || body.slice(0, 1).toString("utf8") === "{";
        if (!isJson) return;
        let json: Json;
        try {
          json = JSON.parse(body.toString("utf8")) as Json;
        } catch {
          return;
        }
        if (looksLikeProductsResponse(url, json)) responses.push({ url, json });
      })
      .catch(() => {});
  };
  return { responses, handler };
}

/** Result of a single route extraction attempt. */
export interface RouteExtractionResult {
  routeId: string;
  reached: boolean;
  challenged: boolean;
  fares: ExtractedFare[];
  domFares: ExtractedFare[];
  productsJson: Json | null;
  bodyText: string;
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

/**
 * Extract real fares from the ride-selection DOM text. Each product block on
 * m.uber.com/go/product-selection renders as "<DisplayName><capacity>\nHK$<fare>".
 * This is a fallback when the products GraphQL response shape cannot be matched.
 */
export function extractFaresFromDom(bodyText: string): ExtractedFare[] {
  const out: ExtractedFare[] = [];
  // Known product display names (order matches the UI). Match a line that is a
  // known product name optionally followed by a capacity digit, then a later
  // HK$/HKD price line.
  const known = [
    "UberX", "Taxi", "Meter Taxi", "Comfort", "UberXL", "UberXXL",
    "Car Seat (4-7yo)", "Car Seat (1-7yo)", "Elite", "Uber Pet", "Black", "Assist",
  ];
  const lines = bodyText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /().-]*?)\s*(\d+)?$/);
    if (!m) continue;
    const candidate = m[1].trim();
    const isKnown = known.some((k) => k.toLowerCase() === candidate.toLowerCase());
    if (!isKnown) continue;
    // Search the next few lines for a price.
    let fareStr: string | null = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const pm = lines[j].match(/^(?:HK\$|HKD\$?|\$)\s*([\d,]+(?:\.\d+)?)/i);
      if (pm) { fareStr = lines[j]; break; }
    }
    if (!fareStr) continue;
    const amount = parseMoney(fareStr.match(/([\d,]+(?:\.\d+)?)/)?.[1] ?? null);
    out.push({
      displayName: candidate,
      fare: fareStr,
      fareAmountE5: amount !== null ? Math.round(amount * 1e5) : null,
      currencyCode: "HKD",
      formattedFare: fareStr,
      source: "dom.text",
    });
  }
  return out;
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

export async function isLoggedIn(page: Page): Promise<boolean> {
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

export async function saveAuthState(context: BrowserContext): Promise<void> {
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
  const phPattern = kind === "pickup" ? /pickup/i : /dropoff/i;
  const candidates = [
    page.getByPlaceholder(phPattern),
    page.getByPlaceholder(/where to|destination|dropoff|pickup/i),
    page.getByRole("textbox", { name: kind === "pickup" ? /pickup/i : /where to|destination|dropoff/i }),
  ];
  for (const c of candidates) {
    try {
      const first = c.first();
      await first.waitFor({ state: "visible", timeout: 2000 });
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
  const input = await chooseLocationInput(page, kind);
  if (!input) {
    console.log(`  [${kind}] no input found`);
    return false;
  }
  await input.click();
  await input.fill(name);
  await page.waitForTimeout(1500);
  // Click the first suggestion whose text starts with the place name.
  const suggestion = page
    .locator('[role="option"], [role="listbox"] [role="option"], li')
    .filter({ hasText: name })
    .first();
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

/**
 * Drive a single route to the ride-selection screen. Parameterized so the batch
 * monitor can reuse it for arbitrary routes. Returns `reached` and `challenged`
 * flags (challenge = CAPTCHA/security interstitial detected — never bypassed).
 */
export async function driveRoute(page: Page, route: RouteDef = ROUTE, opts?: { challengeWaitMs?: number }): Promise<{ reached: boolean; challenged: boolean }> {
  const challengeWaitMs = opts?.challengeWaitMs ?? 180000;
  await clickByRole(page, [/accept all/i, /^accept$/i, /^got it$/i]);
  // Home screen exposes "Enter pickup location" which opens the pickup planner
  // with both Pickup and Dropoff search inputs.
  const opened = await clickByRole(page, [
    /enter pickup location/i,
    /where to/i,
    /enter destination/i,
    /plan a ride/i,
  ]);
  if (!opened) {
    // Fallback: navigate directly to the pickup planner URL.
    await page.goto("https://m.uber.com/go/pickup", { waitUntil: "load", timeout: 60000 }).catch(() => {});
  }
  await page.waitForTimeout(800);
  const destOk = await fillLocation(page, "destination", route.destinationName, `${route.destination.lat},${route.destination.lng}`);
  if (!destOk) return { reached: false, challenged: false };
  const pickOk = await fillLocation(page, "pickup", route.pickupName, `${route.pickup.lat},${route.pickup.lng}`);
  if (!pickOk) return { reached: false, challenged: false };
  // After both locations are set, Uber auto-navigates to product-selection
  // (possibly via a reCAPTCHA "One more step" interstitial that must be solved
  // by the user in the visible browser — never bypassed).
  const deadline = Date.now() + challengeWaitMs;
  let challenged = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const url = page.url();
    const body = await page.locator("body").innerText().catch(() => "");
    if (/one more step/i.test(body) || /challenge/i.test(url) || url.includes("/go/challenge")) {
      if (!challenged) {
        console.log("  reCAPTCHA 'One more step' challenge detected.");
        challenged = true;
      }
      continue;
    }
    if (/HK\$|HKD/.test(body) && /UberX/i.test(body)) {
      console.log("  ride-selection screen reached (price text detected).");
      await page.waitForTimeout(4000); // let products GraphQL settle
      return { reached: true, challenged: false };
    }
  }
  // Timed out: if a challenge was seen at any point, report it as challenged.
  return { reached: false, challenged };
}

/**
 * Reusable single-route extraction: drive the route on an authenticated page
 * (with a per-page response collector attached), then extract fares from the
 * products GraphQL response and DOM text. Never fabricates fares. Returns a
 * structured result the batch monitor can cache, checkpoint, and validate.
 *
 * The caller is responsible for launching the browser/context, attaching the
 * collector's `handler` as a page "response" listener, and checking that the
 * session is authenticated before calling this.
 */
export async function extractRouteFares(
  page: Page,
  route: RouteDef,
  collector: ResponseCollector,
  opts?: { challengeWaitMs?: number },
): Promise<RouteExtractionResult> {
  const { reached, challenged } = await driveRoute(page, route, opts);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const domFares = extractFaresFromDom(bodyText);
  let fares: ExtractedFare[] = [];
  let productsJson: Json | null = null;
  if (collector.responses.length > 0) {
    const latest = collector.responses[collector.responses.length - 1];
    productsJson = latest.json;
    fares = extractFaresFromProducts(latest.json);
  }
  const source = fares.length > 0 ? fares : domFares;
  return {
    routeId: route.id,
    reached,
    challenged,
    fares: source,
    domFares,
    productsJson,
    bodyText,
  };
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
    const { reached, challenged } = await driveRoute(page);
    if (challenged) {
      console.error("Security challenge detected — session paused. Re-run after solving in the browser.");
      process.exitCode = 7;
      return;
    }
    if (!reached) {
      console.error("Could not reach the ride-selection screen.");
      process.exitCode = 3;
    }
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
    console.log(`Screenshot -> ${SCREENSHOT_PATH}`);

    // DOM text is always available on the ride-selection screen and contains the
    // real upfront fares. Use it as a reliable source, and as a fallback when the
    // products GraphQL response shape cannot be matched.
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const domFares = extractFaresFromDom(bodyText);
    if (domFares.length > 0) {
      await writeFile(join(DEBUG_DIR, "uber-fares-dom.txt"), bodyText, "utf8").catch(() => {});
      console.log(`  extracted ${domFares.length} fares from DOM text.`);
    }

    let fares: ExtractedFare[] = [];
    let latest: { url: string; json: Json } | null = null;
    if (productsResponses.length > 0) {
      latest = productsResponses[productsResponses.length - 1];
      fares = extractFaresFromProducts(latest.json);
    }
    const merged = productsResponses.map((r) => extractFaresFromProducts(r.json)).flat();
    // Prefer GraphQL fares when present; otherwise fall back to DOM fares.
    const source = fares.length > 0 ? fares : domFares.length > 0 ? domFares : [];
    const allExtracted = merged.length > 0 ? merged : source;
    const anyRealFare = allExtracted.some((f) => fareMagnitude(f) !== null);
    if (!anyRealFare) {
      console.error(
        "No real fares extracted (GraphQL and DOM both empty) — the session may be a " +
          "GUEST/anonymous session, not an authenticated rider. Re-run with --login and complete Uber login.",
      );
      await writeFile(
        FARES_PATH,
        JSON.stringify({ taskId: "hk_202606192058594097", capturedAt: new Date().toISOString(), route: ROUTE, fares: source, authenticated: false }, null, 2) + "\n",
        "utf8",
      );
      process.exitCode = 6;
      return;
    }
    const verifications = verifyFares(allExtracted);

    await writeFile(
      FARES_PATH,
      JSON.stringify(
        {
          taskId: "hk_202606192058594097",
          capturedAt: new Date().toISOString(),
          route: ROUTE,
          productsResponseUrl: latest ? latest.url : null,
          fares: source,
          domFares,
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
    if (latest) {
      const respPath = join(RESPONSE_DIR, `${stamp}-go-graphql-auth.json`);
      await writeFile(respPath, JSON.stringify(latest.json, null, 2) + "\n", "utf8");
      console.log(`\nAuth products response -> ${respPath}`);
    } else {
      // DOM-only extraction: persist the captured DOM fares for the pipeline.
      const domPath = join(RESPONSE_DIR, `${stamp}-dom-fares-auth.json`);
      await writeFile(domPath, JSON.stringify({ source: "dom.text", fares: domFares, route: ROUTE }, null, 2) + "\n", "utf8");
      console.log(`\nDOM fares (no GraphQL capture) -> ${domPath}`);
    }
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
