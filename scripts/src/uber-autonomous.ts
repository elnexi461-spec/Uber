import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "playwright";

const HOME_URL = "https://m.uber.com/";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(dirname(SCRIPT_DIR));
const DEBUG_DIR = join(PROJECT_DIR, "debug");
const RESPONSE_DIR = join(DEBUG_DIR, "uber-responses");
const OUTPUT_DIR = join(PROJECT_DIR, "output");
const LOG_PATH = join(DEBUG_DIR, "network-log.json");
const CANDIDATES_PATH = join(DEBUG_DIR, "candidate-responses.json");
const MAPPING_PATH = join(DEBUG_DIR, "field-mapping.json");
const REPORT_PATH = join(DEBUG_DIR, "test-report.md");
const RAW_RESPONSE_PATH = join(OUTPUT_DIR, "raw-response.json");
const CSV_OUTPUT_PATH = join(OUTPUT_DIR, "hong-kong-test.csv");
const ROUTE = {
  taskId: "hk_202606192058594097",
  pickupName: "沙田醫院",
  destinationName: "南方花園",
  pickup: { lat: 22.395771, lng: 114.217333 },
  destination: { lat: 22.325528, lng: 114.19081 },
};
const PRIORITY_TERMS = [
  "price",
  "estimate",
  "fare",
  "product",
  "trip",
  "ride",
  "upfront",
  "eta",
  "promotion",
];
const TARGET_FIELDS = [
  "accountid",
  "pullTime",
  "executeTime",
  "fare",
  "description",
  "country",
  "currencyCode",
  "flng",
  "flat",
  "tlng",
  "tlat",
  "originLat",
  "originLng",
  "destinationLat",
  "destinationLng",
  "vehicleViewId",
  "surgeMultiplier",
  "formattedFare",
  "estimatedTripTime",
  "etaString",
  "predictDistance",
  "predictEta",
  "discountPrimaryMagnitude",
  "discountedPrice",
  "fareLineItems",
  "baseValue",
  "perDistanceUnitValue",
  "perMinuteValue",
  "minimumValue",
  "minFare",
  "maxFare",
  "polyline",
  "title",
  "header",
  "accessibilityText",
  "routeId",
  "taskId",
] as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type FieldSource = "direct" | "derived" | "missing";
type NetworkEntry = {
  id: number;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postBody: string | null;
    capturedAt: string;
  };
  response?: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    contentType: string | null;
    isJson: boolean;
    responseBodyFile: string | null;
    responseBodyBytes: number | null;
    capturedAt: string;
  };
  failure?: { errorText: string | null; capturedAt: string };
  candidateTerms: string[];
};
type LogFile = {
  tool: string;
  pageUrl: string;
  route: typeof ROUTE;
  captureStartedAt: string | null;
  captureFinishedAt: string | null;
  requests: NetworkEntry[];
};
type Leaf = { path: string; key: string; value: JsonValue; depth: number };
type FieldMapping = {
  csv_column: string;
  json_path: string;
  source: FieldSource;
  example_value: JsonValue;
  notes: string;
};
type Candidate = {
  response_file: string;
  url: string;
  method: string;
  status: number;
  confidence: number;
  reason: string;
  relevant_keys: string[];
};

const logFile: LogFile = {
  tool: "Uber public mobile web autonomous discovery diagnostic",
  pageUrl: HOME_URL,
  route: ROUTE,
  captureStartedAt: null,
  captureFinishedAt: null,
  requests: [],
};
const requestEntries = new WeakMap<Request, NetworkEntry>();
const pendingHandlers = new Set<Promise<void>>();
let captureActive = false;
let nextEntryId = 1;
let writeChain = Promise.resolve();

const FIELD_ALIASES: Record<string, string[]> = {
  accountid: ["accountid", "account_id", "account"],
  pullTime: ["pulltime", "pickuptime", "pickup_timestamp"],
  executeTime: ["executetime", "executiontime", "requestedat"],
  fare: ["fare", "totalfare", "upfrontfare", "estimatedfare", "price", "totalprice"],
  description: ["description", "productdescription", "servicedescription"],
  country: ["country", "countrycode"],
  currencyCode: ["currencycode", "currency", "currency_code"],
  flng: ["flng", "pickuplng", "pickuplongitude", "originlng", "originlongitude"],
  flat: ["flat", "pickuplat", "pickuplatitude", "originlat", "originlatitude"],
  tlng: ["tlng", "destinationlng", "destinationlongitude", "dropofflng", "droplongitude"],
  tlat: ["tlat", "destinationlat", "destinationlatitude", "dropofflat", "droplatitude"],
  originLat: ["originlat", "originlatitude", "pickuplat", "pickuplatitude", "flat"],
  originLng: ["originlng", "originlongitude", "pickuplng", "pickuplongitude", "flng"],
  destinationLat: ["destinationlat", "destinationlatitude", "dropofflat", "dropofflatitude", "tlat"],
  destinationLng: ["destinationlng", "destinationlongitude", "dropofflng", "dropofflongitude", "tlng"],
  vehicleViewId: ["vehicleviewid", "vehicleid", "productid", "product_id", "uuid"],
  surgeMultiplier: ["surgemultiplier", "surge", "surge_multiplier"],
  formattedFare: ["formattedfare", "displayfare", "formattedprice", "priceformatted"],
  estimatedTripTime: ["estimatedtriptime", "tripduration", "duration", "durationseconds"],
  etaString: ["etastring", "eta", "pickupeta", "etaformatted"],
  predictDistance: ["predictdistance", "distance", "distancemeters", "distancekm"],
  predictEta: ["predicteta", "etaseconds", "estimatedtime"],
  discountPrimaryMagnitude: ["discountprimarymagnitude", "discount", "discountamount", "promotionamount"],
  discountedPrice: ["discountedprice", "promotionalprice", "saleprice"],
  fareLineItems: ["farelineitems", "lineitems", "farebreakdown", "breakdown"],
  baseValue: ["basevalue", "basefare", "baseamount"],
  perDistanceUnitValue: ["perdistanceunitvalue", "perdistance", "distanceunitprice"],
  perMinuteValue: ["perminutevalue", "perminute", "minuteunitprice"],
  minimumValue: ["minimumvalue", "minimumfare", "minimumamount"],
  minFare: ["minfare", "minimumfare", "lowfare"],
  maxFare: ["maxfare", "maximumfare", "highfare"],
  polyline: ["polyline", "encodedpolyline", "routepolyline"],
  title: ["title", "productname", "servicename", "vehiclename", "displayname"],
  header: ["header", "heading", "label"],
  accessibilityText: ["accessibilitytext", "accessiblelabel", "aria_label"],
  routeId: ["routeid", "route_id"],
  taskId: ["taskid", "task_id"],
};

function isUberRequest(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "uber.com" || hostname.endsWith(".uber.com");
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchingTerms(value: string): string[] {
  const lower = value.toLowerCase();
  return PRIORITY_TERMS.filter((term) => lower.includes(term));
}

function mergeCandidateTerms(entry: NetworkEntry, ...values: string[]): void {
  const terms = new Set(entry.candidateTerms);
  for (const value of values) {
    for (const term of matchingTerms(value)) terms.add(term);
  }
  entry.candidateTerms = [...terms].sort();
}

function looksLikeJson(body: Buffer, contentType: string): boolean {
  if (contentType.includes("json")) return true;
  const text = body.toString("utf8").trimStart();
  return text.startsWith("{") || text.startsWith("[");
}

function safeResponseFileName(entry: NetworkEntry, response: Response): string {
  const pathPart = new URL(response.url()).pathname
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${String(entry.id).padStart(5, "0")}-${pathPart || "response"}.json`;
}

async function writeLog(): Promise<void> {
  await mkdir(RESPONSE_DIR, { recursive: true });
  writeChain = writeChain.then(() =>
    writeFile(LOG_PATH, `${JSON.stringify(logFile, null, 2)}\n`, "utf8"),
  );
  await writeChain;
}

function track(handler: Promise<void>): void {
  pendingHandlers.add(handler);
  void handler.then(
    () => pendingHandlers.delete(handler),
    () => pendingHandlers.delete(handler),
  );
}

async function handleRequest(request: Request): Promise<void> {
  if (!captureActive || !isUberRequest(request.url())) return;
  const postBody = request.postData();
  const entry: NetworkEntry = {
    id: nextEntryId++,
    request: {
      url: request.url(),
      method: request.method(),
      headers: {},
      postBody,
      capturedAt: new Date().toISOString(),
    },
    candidateTerms: [],
  };
  requestEntries.set(request, entry);
  logFile.requests.push(entry);
  mergeCandidateTerms(entry, entry.request.url, postBody ?? "");
  entry.request.headers = await request.allHeaders();
  await writeLog();
}

async function handleResponse(response: Response): Promise<void> {
  if (!captureActive || !isUberRequest(response.url())) return;
  const entry = requestEntries.get(response.request());
  if (!entry) return;

  const headers = await response.allHeaders();
  const contentType = headers["content-type"] ?? null;
  let bodyFile: string | null = null;
  let bodyBytes: number | null = null;
  let isJson = false;
  try {
    const body = await response.body();
    bodyBytes = body.byteLength;
    isJson = looksLikeJson(body, contentType?.toLowerCase() ?? "");
    if (isJson) {
      const fileName = safeResponseFileName(entry, response);
      await writeFile(join(RESPONSE_DIR, fileName), body);
      bodyFile = join("debug", "uber-responses", fileName);
      mergeCandidateTerms(entry, body.toString("utf8"));
    }
  } catch (error) {
    entry.failure = {
      errorText: error instanceof Error ? error.message : String(error),
      capturedAt: new Date().toISOString(),
    };
  }
  entry.response = {
    url: response.url(),
    status: response.status(),
    statusText: response.statusText(),
    headers,
    contentType,
    isJson,
    responseBodyFile: bodyFile,
    responseBodyBytes: bodyBytes,
    capturedAt: new Date().toISOString(),
  };
  mergeCandidateTerms(entry, response.url(), contentType ?? "");
  await writeLog();
}

async function handleRequestFailed(request: Request): Promise<void> {
  if (!captureActive || !isUberRequest(request.url())) return;
  const entry = requestEntries.get(request);
  if (!entry) return;
  entry.failure = {
    errorText: request.failure()?.errorText ?? null,
    capturedAt: new Date().toISOString(),
  };
  await writeLog();
}

function installNetworkListeners(page: Page): void {
  page.on("request", (request) => track(handleRequest(request)));
  page.on("response", (response) => track(handleResponse(response)));
  page.on("requestfailed", (request) => track(handleRequestFailed(request)));
}

async function visibleLocator(
  locator: Locator,
  timeout = 800,
): Promise<Locator | null> {
  const candidate = locator.first();
  try {
    await candidate.waitFor({ state: "visible", timeout });
    return candidate;
  } catch {
    return null;
  }
}

async function clickByRole(page: Page, names: RegExp[]): Promise<boolean> {
  for (const name of names) {
    const button = await visibleLocator(page.getByRole("button", { name }), 700);
    if (button) {
      try {
        await button.click();
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

async function clickSuggestion(page: Page, text: string): Promise<boolean> {
  const exact = await visibleLocator(page.getByText(text, { exact: false }), 1500);
  if (exact) {
    await exact.click();
    return true;
  }
  return false;
}

async function visibleInputs(page: Page): Promise<Locator[]> {
  const inputs = page.locator('input:visible:not([readonly]):not([disabled])');
  const result: Locator[] = [];
  for (let i = 0; i < await inputs.count(); i++) result.push(inputs.nth(i));
  return result;
}

async function chooseLocationInput(
  page: Page,
  kind: "pickup" | "destination",
): Promise<Locator | null> {
  const inputs = await visibleInputs(page);
  const keywords =
    kind === "pickup"
      ? ["pickup", "pick up", "origin", "from", "starting", "current"]
      : ["destination", "where to", "dropoff", "drop off", "to"];
  for (const input of inputs) {
    const attributes = [
      await input.getAttribute("placeholder"),
      await input.getAttribute("aria-label"),
      await input.getAttribute("name"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (keywords.some((keyword) => attributes.includes(keyword))) return input;
  }
  if (inputs.length === 0) return null;
  return kind === "pickup" ? inputs[0] : inputs[inputs.length - 1];
}

function protectedGate(text: string): string | null {
  const lower = text.toLowerCase();
  if (/captcha|verify you are human|human verification|security check/.test(lower)) {
    return "CAPTCHA or human verification was shown; no bypass was attempted.";
  }
  if (/access denied|unusual traffic|rate limit|too many requests/.test(lower)) {
    return "Uber displayed an access/rate-limit condition; no bypass was attempted.";
  }
  if (/authentication required|log in to continue|sign in to continue/.test(lower)) {
    return "Uber required authentication; no login was attempted.";
  }
  return null;
}

async function fillLocation(
  page: Page,
  kind: "pickup" | "destination",
  name: string,
  coordinates: string,
): Promise<{ ok: boolean; detail: string }> {
  await clickByRole(
    page,
    kind === "pickup"
      ? [/pickup location/i, /^pickup$/i, /edit pickup/i]
      : [/dropoff location/i, /^dropoff$/i, /where to/i, /destination/i],
  );
  await page.waitForTimeout(400);
  const input = await chooseLocationInput(page, kind);
  if (!input) return { ok: false, detail: `No visible ${kind} location input was found.` };
  await input.click();
  await input.fill(name);
  await page.waitForTimeout(1200);
  const gate = protectedGate(await page.locator("body").innerText().catch(() => ""));
  if (gate) return { ok: false, detail: gate };
  const selected = await clickSuggestion(page, name);
  if (selected) return { ok: true, detail: `${kind} selected by name: ${name}` };
  await input.fill(coordinates);
  await page.waitForTimeout(1200);
  const selectedByCoordinates = await clickSuggestion(page, coordinates);
  return selectedByCoordinates
    ? { ok: true, detail: `${kind} selected by coordinates: ${coordinates}` }
    : { ok: false, detail: `No ${kind} suggestion could be selected.` };
}

async function attemptRideFlow(page: Page): Promise<{
  status: string;
  details: string[];
  resultsDetected: boolean;
}> {
  const details: string[] = [];
  await page.waitForTimeout(1500);
  let gate = protectedGate(await page.locator("body").innerText().catch(() => ""));
  if (gate) return { status: "protected_gate", details: [gate], resultsDetected: false };

  await clickByRole(page, [/accept all/i, /^accept$/i, /^agree$/i, /^got it$/i]);
  await clickByRole(page, [/where to/i, /enter destination/i, /plan a ride/i]);

  const destination = await fillLocation(
    page,
    "destination",
    ROUTE.destinationName,
    `${ROUTE.destination.lat},${ROUTE.destination.lng}`,
  );
  details.push(destination.detail);
  if (!destination.ok) return { status: "destination_input_failed", details, resultsDetected: false };

  const pickup = await fillLocation(
    page,
    "pickup",
    ROUTE.pickupName,
    `${ROUTE.pickup.lat},${ROUTE.pickup.lng}`,
  );
  details.push(pickup.detail);
  if (!pickup.ok) return { status: "pickup_input_failed", details, resultsDetected: false };

  await clickByRole(page, [/see prices/i, /view prices/i, /show prices/i]);
  const deadline = Date.now() + 45000;
  let resultsDetected = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    gate = protectedGate(bodyText);
    if (gate) {
      details.push(gate);
      return { status: "protected_gate_after_input", details, resultsDetected };
    }
    if (/HK\$|HKD|UberX|estimated fare|fare estimate|price estimate/i.test(bodyText)) {
      resultsDetected = true;
      break;
    }
  }
  if (resultsDetected) {
    details.push("Price-like text was detected in the rendered page.");
    await page.waitForTimeout(5000);
    return { status: "results_detected", details, resultsDetected };
  }
  details.push("The normal UI did not expose a price result within 45 seconds.");
  return { status: "results_not_detected", details, resultsDetected };
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function keyWords(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function hasKeyTerm(key: string, term: string): boolean {
  return new RegExp(`(?:^|\\s)${term}(?:\\s|$)`, "i").test(keyWords(key));
}

function flatten(value: JsonValue, path = "$", result: Leaf[] = [], depth = 0): Leaf[] {
  if (result.length > 10000) return result;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, result, depth + 1));
    return result;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = childPath(path, key);
      result.push({ path: nextPath, key, value: item, depth });
      flatten(item, nextPath, result, depth + 1);
    }
  }
  return result;
}

function valueString(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function findField(value: JsonValue, field: string): Leaf | null {
  const aliases = new Set((FIELD_ALIASES[field] ?? [normalize(field)]).map(normalize));
  const leaves = flatten(value).filter((leaf) => aliases.has(normalize(leaf.key)));
  leaves.sort((a, b) => {
    const exactA = normalize(a.key) === normalize(field) ? 0 : 1;
    const exactB = normalize(b.key) === normalize(field) ? 0 : 1;
    return exactA - exactB || a.depth - b.depth;
  });
  return leaves[0] ?? null;
}

function mappingForJson(value: JsonValue): Record<string, FieldMapping> {
  const mapping: Record<string, FieldMapping> = {};
  for (const field of TARGET_FIELDS) {
    const found = findField(value, field);
    if (found) {
      mapping[field] = {
        csv_column: field,
        json_path: found.path,
        source: "direct",
        example_value: found.value,
        notes: `Matched response key "${found.key}"; source value is preserved without transformation.`,
      };
    } else {
      mapping[field] = {
        csv_column: field,
        json_path: "",
        source: "missing",
        example_value: null,
        notes: "No matching field was found in the verified JSON response.",
      };
    }
  }
  return mapping;
}

function emptyMapping(note: string): Record<string, FieldMapping> {
  const mapping: Record<string, FieldMapping> = {};
  for (const field of TARGET_FIELDS) {
    mapping[field] = {
      csv_column: field,
      json_path: "",
      source: "missing",
      example_value: null,
      notes: note,
    };
  }
  return mapping;
}

function findRelevantKeys(value: JsonValue): string[] {
  const leaves = flatten(value);
  return leaves
    .filter((leaf) => {
      const key = keyWords(leaf.key);
      return (
        PRIORITY_TERMS.some((term) => hasKeyTerm(leaf.key, term)) ||
        /(?:^|\s)(product|vehicle|service|price|fare|currency|eta|duration|distance|surge|promotion|discount|offer|quote|breakdown|polyline|route)(?:\s|$)/.test(
          key,
        )
      );
    })
    .map((leaf) => leaf.path)
    .slice(0, 100);
}

function countIndicators(value: JsonValue): number {
  const keys = flatten(value).map((leaf) => keyWords(leaf.key)).join(" ");
  return [
    /(?:^|\s)(product|vehicle|service)(?:\s|$)/,
    /(?:^|\s)(fare|price|upfront)(?:\s|$)/,
    /(?:^|\s)currency(?:\s|$)/,
    /(?:^|\s)(eta|duration)(?:\s|$)/,
    /(?:^|\s)distance(?:\s|$)/,
    /(?:^|\s)surge(?:\s|$)/,
    /(?:^|\s)(promotion|discount)(?:\s|$)/,
  ].filter((pattern) => pattern.test(keys)).length;
}

function extractOffers(value: JsonValue): { path: string; items: JsonValue[] } {
  let best = { path: "$", items: [] as JsonValue[], score: -1 };
  function walk(current: JsonValue, path: string): void {
    if (Array.isArray(current)) {
      const objects = current.filter(
        (item): item is { [key: string]: JsonValue } =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      );
      const score =
        objects.length +
        objects.filter((item) => /product|vehicle|service|fare|price|eta|offer|quote/i.test(JSON.stringify(item))).length * 4;
      if (objects.length > 0 && score > best.score) {
        best = { path, items: objects, score };
      }
      current.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (current !== null && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) walk(item, childPath(path, key));
    }
  }
  walk(value, "$");
  return { path: best.path, items: best.items };
}

function primitiveValuesForKeys(value: JsonValue, pattern: RegExp): JsonValue[] {
  return flatten(value)
    .filter((leaf) => pattern.test(leaf.key) && (typeof leaf.value !== "object" || leaf.value === null))
    .map((leaf) => leaf.value)
    .filter((item, index, all) => JSON.stringify(item) !== JSON.stringify(all[index - 1]));
}

function parseCsvHeader(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(current);
      current = "";
    } else current += char;
  }
  fields.push(current);
  return fields;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function findSchemaFile(): Promise<string | null> {
  const target = "2026-08-11_21_N_price_V04.csv";
  async function walk(dir: string): Promise<string | null> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".cache", "dist"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === target) return path;
      if (entry.isDirectory()) {
        const found = await walk(path);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(PROJECT_DIR);
}

async function analyzeResponses(): Promise<{
  candidates: Candidate[];
  strongest: { entry: NetworkEntry; json: JsonValue } | null;
  mapping: Record<string, FieldMapping>;
  offers: JsonValue[];
  schemaPath: string | null;
}> {
  const parsed: { entry: NetworkEntry; json: JsonValue }[] = [];
  for (const entry of logFile.requests) {
    const file = entry.response?.responseBodyFile;
    if (!entry.response?.isJson || !file) continue;
    try {
      const json = JSON.parse(await readFile(join(PROJECT_DIR, file), "utf8")) as JsonValue;
      parsed.push({ entry, json });
    } catch {
      // The raw body remains saved even when it is not parseable JSON.
    }
  }

  const ranked = parsed
    .map(({ entry, json }) => {
      const indicators = countIndicators(json);
      const relevantKeys = findRelevantKeys(json);
      const termScore = matchingTerms(`${entry.request.url} ${entry.request.postBody ?? ""}`).length;
      const nonDataAsset = /_translations|sprite|\/style\/|maps_provenance/.test(entry.request.url);
      const score = Math.max(
        0,
        Math.min(
          1,
          indicators * 0.11 +
            termScore * 0.04 +
            (entry.response?.status === 200 ? 0.12 : 0) -
            (nonDataAsset ? 0.35 : 0),
        ),
      );
      const reasons = [
        termScore ? `matched request terms: ${matchingTerms(`${entry.request.url} ${entry.request.postBody ?? ""}`).join(", ")}` : "",
        indicators ? `${indicators}/7 pricing data indicator groups found` : "",
        relevantKeys.length ? `${relevantKeys.length} relevant JSON paths` : "",
        nonDataAsset ? "static/translation asset deprioritized" : "",
      ].filter(Boolean);
      return {
        entry,
        json,
        candidate: {
          response_file: filePath(entry.response?.responseBodyFile),
          url: entry.response?.url ?? entry.request.url,
          method: entry.request.method,
          status: entry.response?.status ?? 0,
          confidence: Number(score.toFixed(3)),
          reason: reasons.join("; ") || "JSON response captured; no pricing indicators found.",
          relevant_keys: relevantKeys,
        },
      };
    })
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence);

  const candidates = ranked.map((item) => item.candidate);
  const strongestRanked = ranked.find(
    (item) =>
      item.candidate.confidence >= 0.3 &&
      item.candidate.relevant_keys.length > 0 &&
      !/_translations|sprite|\/style\/|maps_provenance/.test(item.entry.request.url),
  );
  const strongest = strongestRanked
    ? { entry: strongestRanked.entry, json: strongestRanked.json }
    : null;
  const mapping = strongest
    ? mappingForJson(strongest.json)
    : emptyMapping("No parseable JSON response was captured.");
  const offers = strongest ? extractOffers(strongest.json).items : [];
  return { candidates, strongest, mapping, offers, schemaPath: await findSchemaFile() };
}

function filePath(value: string | null | undefined): string {
  return value ?? "";
}

async function writeCsvIfPossible(
  mapping: Record<string, FieldMapping>,
  offers: JsonValue[],
  schemaPath: string | null,
): Promise<{ created: boolean; reason: string }> {
  if (!schemaPath) {
    return { created: false, reason: "The required 89-column CSV schema file was not found." };
  }
  if (offers.length === 0) {
    return { created: false, reason: "No product/offer array was found in the strongest response." };
  }
  const firstLine = (await readFile(schemaPath, "utf8")).split(/\r?\n/, 1)[0] ?? "";
  const headers = parseCsvHeader(firstLine);
  if (headers.length !== 89) {
    return { created: false, reason: `The supplied schema contains ${headers.length} columns, not 89.` };
  }
  const rows = offers.map((offer) =>
    headers.map((header) => {
      const field = mapping[header];
      if (!field || !field.json_path) return "";
      const found = findField(offer, header);
      return csvCell(found?.value ?? "");
    }),
  );
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(CSV_OUTPUT_PATH, [headers.map(csvCell).join(","), ...rows.map((row) => row.join(",")), ""].join("\n"));
  return { created: true, reason: `Created one row per discovered offer using ${headers.length} schema columns.` };
}

function summaryValues(json: JsonValue | null, pattern: RegExp): string[] {
  if (!json) return [];
  return primitiveValuesForKeys(json, pattern).map(valueString).slice(0, 20);
}

async function writeReport(
  flow: { status: string; details: string[]; resultsDetected: boolean; navigationError?: string },
  analysis: Awaited<ReturnType<typeof analyzeResponses>>,
  csv: { created: boolean; reason: string },
): Promise<void> {
  const strongest = analysis.strongest;
  const direct = Object.values(analysis.mapping).filter((item) => item.source === "direct").map((item) => item.csv_column);
  const missing = Object.values(analysis.mapping).filter((item) => item.source === "missing").map((item) => item.csv_column);
  const products = summaryValues(strongest?.json ?? null, /productName|serviceName|vehicleName|displayName|^name$/i);
  const fares = summaryValues(strongest?.json ?? null, /fare|price|amount/i);
  const currencies = summaryValues(strongest?.json ?? null, /currency/i);
  const etas = summaryValues(strongest?.json ?? null, /eta|duration/i);
  const promotions = summaryValues(strongest?.json ?? null, /promotion|discount|promo/i);
  const blocker = flow.navigationError ?? (flow.status === "results_detected" ? "None." : flow.details.at(-1) ?? flow.status);
  const strongestCandidate = analysis.candidates[0];
  const sufficient = Boolean(strongest && analysis.offers.length > 0 && csv.created);
  const report = [
    "# Hong Kong Uber public-flow diagnostic",
    "",
    `- Task: \`${ROUTE.taskId}\``,
    `- Route: ${ROUTE.pickupName} (${ROUTE.pickup.lat}, ${ROUTE.pickup.lng}) → ${ROUTE.destinationName} (${ROUTE.destination.lat}, ${ROUTE.destination.lng})`,
    `- Flow status: **${flow.status}**`,
    `- Public flow worked: **${flow.resultsDetected ? "yes" : "no"}**`,
    `- Exact blocker: ${blocker}`,
    `- Requests captured: **${logFile.requests.length}**`,
    `- JSON responses: **${logFile.requests.filter((entry) => entry.response?.isJson).length}**`,
    `- Products/offers discovered: **${analysis.offers.length}**`,
    `- Schema file: ${analysis.schemaPath ? `\`${relative(PROJECT_DIR, analysis.schemaPath)}\`` : "not found"}`,
    `- CSV output: **${csv.created ? "created" : "not created"}** — ${csv.reason}`,
    "",
    "## Strongest candidate response",
    "",
    strongestCandidate
      ? `- \`${strongestCandidate.response_file}\` — ${strongestCandidate.method} ${strongestCandidate.status} ${strongestCandidate.url}`
      : "- None",
    strongestCandidate ? `- Confidence: ${strongestCandidate.confidence}` : "",
    strongestCandidate ? `- Reason: ${strongestCandidate.reason}` : "",
    "",
    "## Discovered values",
    "",
    `- Product/service names: ${products.length ? products.join("; ") : "none found"}`,
    `- Fare values: ${fares.length ? fares.join("; ") : "none found"}`,
    `- Currency: ${currencies.length ? currencies.join("; ") : "none found"}`,
    `- ETA/duration: ${etas.length ? etas.join("; ") : "none found"}`,
    `- Promotions/discounts: ${promotions.length ? promotions.join("; ") : "none found"}`,
    "",
    "## Field availability",
    "",
    `- Directly available (${direct.length}): ${direct.length ? direct.join(", ") : "none"}`,
    `- Missing (${missing.length}): ${missing.length ? missing.join(", ") : "none"}`,
    "",
    "## Assessment",
    "",
    `The public response appears ${sufficient ? "" : "not "}sufficient to reproduce the client's dataset for this route.`,
    "Only values present in captured JSON were considered. No undocumented endpoint, proxy, CAPTCHA bypass, authentication bypass, or synthetic Uber value was used.",
    "",
    "## Interaction trace",
    "",
    ...flow.details.map((detail) => `- ${detail}`),
    "",
  ].join("\n");
  await writeFile(REPORT_PATH, report, "utf8");
}

async function finalizeArtifacts(
  flow: { status: string; details: string[]; resultsDetected: boolean; navigationError?: string },
): Promise<void> {
  logFile.captureFinishedAt = new Date().toISOString();
  await Promise.all([...pendingHandlers]);
  await writeLog();
  const analysis = await analyzeResponses();
  await mkdir(OUTPUT_DIR, { recursive: true });
  if (analysis.strongest?.entry.response?.responseBodyFile) {
    const raw = await readFile(join(PROJECT_DIR, analysis.strongest.entry.response.responseBodyFile));
    await writeFile(RAW_RESPONSE_PATH, raw);
  } else {
    await writeFile(RAW_RESPONSE_PATH, "null\n", "utf8");
  }
  await writeFile(CANDIDATES_PATH, `${JSON.stringify(analysis.candidates, null, 2)}\n`, "utf8");
  await writeFile(MAPPING_PATH, `${JSON.stringify(analysis.mapping, null, 2)}\n`, "utf8");
  const csv = await writeCsvIfPossible(analysis.mapping, analysis.offers, analysis.schemaPath);
  await writeReport(flow, analysis, csv);
  console.log("\nAutonomous diagnostic summary");
  console.log("=============================");
  console.log(`Flow: ${flow.status}`);
  console.log(`Requests captured: ${logFile.requests.length}`);
  console.log(`JSON responses: ${logFile.requests.filter((entry) => entry.response?.isJson).length}`);
  console.log(`Products/offers discovered: ${analysis.offers.length}`);
  console.log(`Strongest candidate: ${analysis.candidates[0]?.response_file ?? "none"}`);
  console.log(`Candidate report: ${CANDIDATES_PATH}`);
  console.log(`Field mapping: ${MAPPING_PATH}`);
  console.log(`Test report: ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  await mkdir(RESPONSE_DIR, { recursive: true });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const flow = { status: "not_started", details: [] as string[], resultsDetected: false, navigationError: undefined as string | undefined };
  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      ...devices["iPhone 13"],
      locale: "en-HK",
      timezoneId: "Asia/Hong_Kong",
      geolocation: {
        latitude: ROUTE.pickup.lat,
        longitude: ROUTE.pickup.lng,
      },
      permissions: ["geolocation"],
    });
    const page = await context.newPage();
    installNetworkListeners(page);
    captureActive = true;
    logFile.captureStartedAt = new Date().toISOString();
    await writeLog();
    console.log(`Opening ${HOME_URL} in visible Chromium...`);
    await page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 });
    const result = await attemptRideFlow(page);
    flow.status = result.status;
    flow.details = result.details;
    flow.resultsDetected = result.resultsDetected;
  } catch (error) {
    flow.status = "run_failed";
    flow.navigationError = error instanceof Error ? error.message : String(error);
    flow.details.push("The run ended without bypassing the encountered error.");
  } finally {
    captureActive = false;
    await finalizeArtifacts(flow);
    await context?.close();
    await browser?.close();
  }
}

main().catch((error: unknown) => {
  console.error("Uber autonomous diagnostic failed:", error);
  process.exitCode = 1;
});