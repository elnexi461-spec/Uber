import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from "playwright";

const HOME_URL = "https://m.uber.com/";
const OUTPUT_DIR = join(process.cwd(), "debug");
const RESPONSE_DIR = join(OUTPUT_DIR, "uber-responses");
const LOG_PATH = join(OUTPUT_DIR, "network-log.json");
const ROUTE = {
  pickup: "22.395771,114.217333",
  destination: "22.325528,114.190810",
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
  failure?: {
    errorText: string | null;
    capturedAt: string;
  };
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

const logFile: LogFile = {
  tool: "Uber public mobile web network diagnostic",
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

function isUberRequest(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "uber.com" || hostname.endsWith(".uber.com");
  } catch {
    return false;
  }
}

function matchingTerms(value: string): string[] {
  const lowerValue = value.toLowerCase();
  return PRIORITY_TERMS.filter((term) => lowerValue.includes(term));
}

function mergeCandidateTerms(entry: NetworkEntry, ...values: string[]): void {
  const terms = new Set(entry.candidateTerms);
  for (const value of values) {
    for (const term of matchingTerms(value)) {
      terms.add(term);
    }
  }
  entry.candidateTerms = [...terms].sort();
}

function looksLikeJson(body: Buffer, contentType: string): boolean {
  if (contentType.includes("json")) {
    return true;
  }

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
  void handler.finally(() => pendingHandlers.delete(handler));
}

async function handleRequest(request: Request): Promise<void> {
  if (!captureActive || !isUberRequest(request.url())) {
    return;
  }

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
  if (!captureActive || !isUberRequest(response.url())) {
    return;
  }

  const entry = requestEntries.get(response.request());
  if (!entry) {
    return;
  }

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
  if (!captureActive || !isUberRequest(request.url())) {
    return;
  }

  const entry = requestEntries.get(request);
  if (entry) {
    entry.failure = {
      errorText: request.failure()?.errorText ?? null,
      capturedAt: new Date().toISOString(),
    };
    await writeLog();
  }
}

function installNetworkListeners(page: Page): void {
  page.on("request", (request) => {
    const handler = handleRequest(request);
    track(handler);
  });
  page.on("response", (response) => {
    const handler = handleResponse(response);
    track(handler);
  });
  page.on("requestfailed", (request) => {
    const handler = handleRequestFailed(request);
    track(handler);
  });
}

function printCandidateSummary(): void {
  const candidates = logFile.requests
    .filter((entry) => entry.candidateTerms.length > 0)
    .sort((a, b) => a.id - b.id);

  console.log("\nCandidate pricing/product requests");
  console.log("=================================");
  if (candidates.length === 0) {
    console.log("No requests matched the priority terms.");
    return;
  }

  for (const entry of candidates) {
    const status = entry.response?.status ?? (entry.failure ? "FAILED" : "pending");
    const bodyFile = entry.response?.responseBodyFile
      ? ` | JSON: ${entry.response.responseBodyFile}`
      : "";
    console.log(
      `#${entry.id} [${entry.candidateTerms.join(", ")}] ${entry.request.method} ${status} ${entry.request.url}${bodyFile}`,
    );
  }
  console.log(`\nMatched ${candidates.length} of ${logFile.requests.length} captured requests.`);
}

async function waitForManualInteraction(): Promise<void> {
  const readline = createInterface({ input, output });
  try {
    console.log("\nBrowser is open for manual interaction.");
    console.log(`Enter pickup: ${ROUTE.pickup}`);
    console.log(`Enter destination: ${ROUTE.destination}`);
    console.log('Complete the normal flow and click "See prices".');
    await readline.question(
      "\nWhen the price results are visible, press Enter to print the candidate summary and flush the log.",
    );
    await Promise.all([...pendingHandlers]);
    await writeLog();
    logFile.captureFinishedAt = new Date().toISOString();
    await writeLog();
    printCandidateSummary();
    console.log(`\nFull network log: ${LOG_PATH}`);
    console.log("The browser will remain open for inspection.");
    await readline.question("Press Enter when you are finished to close the browser and exit.");
  } finally {
    readline.close();
  }
}

async function main(): Promise<void> {
  await mkdir(RESPONSE_DIR, { recursive: true });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      ...devices["iPhone 13"],
      locale: "en-HK",
      timezoneId: "Asia/Hong_Kong",
    });
    const page = await context.newPage();
    installNetworkListeners(page);

    console.log(`Opening ${HOME_URL} in visible Chromium...`);
    await page.goto(HOME_URL, { waitUntil: "load" });
    captureActive = true;
    logFile.captureStartedAt = new Date().toISOString();
    await writeLog();
    await waitForManualInteraction();
  } finally {
    captureActive = false;
    await Promise.all([...pendingHandlers]);
    await writeLog();
    await context?.close();
    await browser?.close();
  }
}

main().catch((error: unknown) => {
  console.error("Uber diagnostic failed:", error);
  process.exitCode = 1;
});