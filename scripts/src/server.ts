/**
 * Minimal production API server for the Uber fare extraction engine.
 *
 * Reuses the existing extraction/job system WITHOUT rewriting it:
 *   - reads output/public-products.json + output/public-products.csv (89-col pipeline)
 *   - reads debug/monitor-*.json (metrics, cache, checkpoint — the hardened monitor)
 *   - reads debug/uber-fares.json (fare verification vs known manual fares)
 *   - triggers batch runs via the existing uber-monitor.ts (child process)
 *
 * Zero new runtime dependencies: Node.js built-in `http` only. Railway-compatible:
 * binds to $PORT, serves a /api/health check, and statically serves ./dashboard.
 *
 * Security: never reads or serves debug/uber-auth-state.json (session/cookies).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..", "..");
const OUTPUT_DIR = join(PROJECT_DIR, "output");
const DEBUG_DIR = join(PROJECT_DIR, "debug");
const DASHBOARD_DIR = join(PROJECT_DIR, "dashboard");
const SCRIPTS_DIR = join(PROJECT_DIR, "scripts");

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";

// Files the API reads (all gitignored operational artifacts + pipeline outputs).
const FILES = {
  productsJson: join(OUTPUT_DIR, "public-products.json"),
  productsCsv: join(OUTPUT_DIR, "public-products.csv"),
  metrics: join(DEBUG_DIR, "monitor-metrics.json"),
  cache: join(DEBUG_DIR, "monitor-cache.json"),
  checkpoint: join(DEBUG_DIR, "monitor-checkpoint.json"),
  fares: join(DEBUG_DIR, "uber-fares.json"),
  monitorLog: join(DEBUG_DIR, "monitor.log"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Json = unknown;

async function readJson<T = Json>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, ct = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": ct,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  // Prevent path traversal outside dashboard/.
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(DASHBOARD_DIR, safe);
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  const data = await readFile(filePath);
  sendText(res, 200, data.toString("utf8"), MIME[extname(filePath)] ?? "application/octet-stream");
}

// ─────────────────────────────────────────────────────────────────────────────
// API data shapes (reuse existing output file structures; no schema changes)
// ─────────────────────────────────────────────────────────────────────────────

interface MonitorMetrics {
  requestsCompleted: number;
  faresExtracted: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  rateLimitWaits: number;
  failedRoutes: number;
  challengedRoutes: number;
  sessionStatus: Record<string, string>;
  captchaDetections: number;
}

interface CacheEntry {
  routeId: string;
  routeKey: string;
  capturedAt: string;
  fares: Array<{ displayName: string; fare: string | null; fareAmountE5: number | null; currencyCode: string | null }>;
  reached: boolean;
}

interface CheckpointJob {
  route: {
    id: string;
    pickupName: string;
    destinationName: string;
    pickup: { lat: number; lng: number };
    destination: { lat: number; lng: number };
  };
  status: string;
  attempts: number;
  lastError: string | null;
  completedAt: string | null;
  result: unknown;
}

interface FaresOutput {
  taskId: string;
  capturedAt: string;
  route: unknown;
  fares: unknown[];
  verifications: Array<{
    displayName: string;
    expected: number | null;
    extracted: number | null;
    delta: number | null;
    withinTolerance: boolean;
    status: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// API route handlers
// ─────────────────────────────────────────────────────────────────────────────

/** Track an in-flight monitor batch so the UI can show running state. */
let runningJob: {
  pid: number;
  startedAt: string;
  routes: number;
  exitCode: number | null;
  stderr: string[];
  error: string | null;
} | null = null;

async function apiHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authed = existsSync(join(DEBUG_DIR, "uber-auth-state.json"));
  const products = existsSync(FILES.productsJson);

  // Runtime capability checks
  const tsxPath = join(SCRIPTS_DIR, "node_modules", ".bin", "tsx");
  const playwrightPath = join(SCRIPTS_DIR, "node_modules", "playwright");
  const monitorPath = join(SCRIPTS_DIR, "src", "uber-monitor.ts");
  const monitorStat = await stat(monitorPath).catch(() => null);

  sendJson(res, 200, {
    status: "ok",
    time: new Date().toISOString(),
    authenticatedSession: authed,
    hasPipelineOutput: products,
    runtime: {
      tsxExists: existsSync(tsxPath),
      playwrightExists: existsSync(playwrightPath),
      monitorScriptExists: existsSync(monitorPath),
      monitorScriptSize: monitorStat?.size ?? 0,
      monitorScriptHealthy: (monitorStat?.size ?? 0) > 1000,
    },
  });
}

async function apiDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const metrics = await readJson<MonitorMetrics>(FILES.metrics);
  const products = await readJson<{ rows: Array<{ fare?: string | null }> }>(FILES.productsJson);
  const cache = await readJson<CacheEntry[]>(FILES.cache);
  const checkpoint = await readJson<{ jobs: CheckpointJob[]; updatedAt: string }>(FILES.checkpoint);
  const fares = await readJson<FaresOutput>(FILES.fares);

  const rows = products?.rows ?? [];
  const withFare = rows.filter((r) => {
    const fare = r.fare;
    return fare && fare !== "" && fare !== "Select Time";
  }).length;

  const sessionStatuses = metrics ? Object.values(metrics.sessionStatus) : [];
  const sessionHealth = sessionStatuses.length === 0
    ? "unknown"
    : sessionStatuses.some((s) => s === "challenged") ? "challenged"
    : sessionStatuses.some((s) => s === "expired") ? "expired"
    : sessionStatuses.every((s) => s === "closed") ? "closed"
    : "healthy";

  const verification = fares?.verifications ?? [];
  const matched = verification.filter((v) => v.status === "match").length;
  const mismatched = verification.filter((v) => v.status === "mismatch").length;

  sendJson(res, 200, {
    metrics: metrics ?? {
      requestsCompleted: 0, faresExtracted: 0, retries: 0, cacheHits: 0,
      cacheMisses: 0, rateLimitWaits: 0, failedRoutes: 0, challengedRoutes: 0,
      sessionStatus: {}, captchaDetections: 0,
    },
    pipeline: {
      totalRows: rows.length,
      rowsWithFare: withFare,
      products: rows.length,
      navigationAvailable: Boolean(checkpoint),
      lastUpdated: checkpoint?.updatedAt ?? null,
    },
    cache: { entries: cache?.length ?? 0 },
    session: { health: sessionHealth, running: Boolean(runningJob) },
    verification: { matched, mismatched, total: verification.length },
    capturedAt: fares?.capturedAt ?? null,
  });
}

async function apiRoutes(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cache = await readJson<CacheEntry[]>(FILES.cache);
  const checkpoint = await readJson<{ jobs: CheckpointJob[] }>(FILES.checkpoint);
  const products = await readJson<{ route: { taskId: string; pickupName: string; destinationName: string; pickup: { lat: number; lng: number }; destination: { lat: number; lng: number } } }>(FILES.productsJson);

  const routes: Array<Record<string, unknown>> = [];
  // Primary route from pipeline output.
  if (products?.route) {
    routes.push({ ...products.route, source: "pipeline", collected: true });
  }
  // Routes from checkpoint jobs (includes failed/pending).
  for (const job of checkpoint?.jobs ?? []) {
    if (!routes.some((r) => (r["id"] as string | undefined) === job.route.id)) {
      routes.push({ ...job.route, id: job.route.id, source: "checkpoint", collected: job.status === "done" || job.status === "cached", status: job.status });
    }
  }
  // Routes from cache (successfully collected).
  for (const entry of cache ?? []) {
    if (!routes.some((r) => (r["routeKey"] as string | undefined) === entry.routeKey)) {
      routes.push({ routeKey: entry.routeKey, routeId: entry.routeId, source: "cache", collected: true, capturedAt: entry.capturedAt });
    }
  }
  sendJson(res, 200, { routes });
}

async function apiPrices(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  type PriceRow = { description: string | null; fare: string | null; currencyCode: string | null; surgeMultiplier: string | null; etaStringShort: string | null; estimatedTripTime: number | null };
  type PriceOutput = { route: { pickupName?: string; destinationName?: string; taskId?: string } | null; navigation: { distanceMeters?: number | null } | null; rows: PriceRow[] };
  const products = await readJson<PriceOutput>(FILES.productsJson);
  const cache = await readJson<CacheEntry[]>(FILES.cache);

  const pipelineRows = (products?.rows ?? []).map((r) => ({
    source: "pipeline",
    displayName: r.description,
    fare: r.fare,
    currencyCode: r.currencyCode,
    surge: r.surgeMultiplier,
    eta: r.etaStringShort,
    tripTime: r.estimatedTripTime,
  }));

  const cacheFares = (cache ?? []).flatMap((e) =>
    e.fares.map((f) => ({
      source: "cache",
      routeId: e.routeId,
      routeKey: e.routeKey,
      capturedAt: e.capturedAt,
      displayName: f.displayName,
      fare: f.fare,
      fareAmountE5: f.fareAmountE5,
      currencyCode: f.currencyCode,
    })),
  );

  sendJson(res, 200, {
    route: products?.route ?? null,
    navigation: products?.navigation ?? null,
    pipelinePrices: pipelineRows,
    cachePrices: cacheFares,
  });
}

async function apiJobs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const checkpoint = await readJson<{ startedAt: string; updatedAt: string; jobs: CheckpointJob[]; metrics: MonitorMetrics }>(FILES.checkpoint);

  const lastBatch = runningJob
    ? {
        status: runningJob.exitCode === null ? "running" : "finished",
        pid: runningJob.pid,
        startedAt: runningJob.startedAt,
        routes: runningJob.routes,
        exitCode: runningJob.exitCode,
        recentStderr: runningJob.stderr.slice(-10),
        spawnError: runningJob.error,
      }
    : null;

  if (!checkpoint) {
    sendJson(res, 200, { jobs: [], startedAt: null, updatedAt: null, running: Boolean(runningJob && runningJob.exitCode === null), lastBatch });
    return;
  }
  const jobs = checkpoint.jobs.map((j) => ({
    routeId: j.route.id,
    pickupName: j.route.pickupName,
    destinationName: j.route.destinationName,
    status: j.status,
    attempts: j.attempts,
    lastError: j.lastError,
    completedAt: j.completedAt,
  }));
  sendJson(res, 200, {
    jobs,
    startedAt: checkpoint.startedAt,
    updatedAt: checkpoint.updatedAt,
    metrics: checkpoint.metrics,
    running: Boolean(runningJob && runningJob.exitCode === null),
    lastBatch,
  });
}

async function apiJobsRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (runningJob) {
    sendJson(res, 409, { error: "A batch is already running", runningJob });
    return;
  }
  // Parse optional routes JSON from the request body.
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) break; // 1MB cap
  }
  let routesArg: string[] = [];
  let extraArgs: string[] = [];
  try {
    if (body) {
      const parsed = JSON.parse(body) as { routes?: unknown; concurrency?: number; minIntervalMs?: number; retryBudget?: number };
      if (Array.isArray(parsed.routes) && parsed.routes.length > 0) {
        // Write routes to a temp file for --routes flag.
        const routesFile = join(DEBUG_DIR, "monitor-routes-input.json");
        await writeFile(routesFile, JSON.stringify(parsed.routes), "utf8");
        routesArg = ["--routes", routesFile];
      }
      if (typeof parsed.concurrency === "number") extraArgs.push("--max-concurrency", String(parsed.concurrency));
      if (typeof parsed.minIntervalMs === "number") extraArgs.push("--min-interval-ms", String(parsed.minIntervalMs));
      if (typeof parsed.retryBudget === "number") extraArgs.push("--retry-budget", String(parsed.retryBudget));
    }
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const display = process.env["DISPLAY"] ?? "";
  const tsx = join(SCRIPTS_DIR, "node_modules", ".bin", "tsx");
  const monitorScript = join(SCRIPTS_DIR, "src", "uber-monitor.ts");
  const args = [monitorScript, ...routesArg, ...extraArgs, "--challenge-wait-ms", "45000"];
  const child = spawn(tsx, args, {
    cwd: PROJECT_DIR,
    env: { ...process.env, DISPLAY: display || ":99" },
    stdio: "ignore",
    detached: false,
  });

  runningJob = { pid: child.pid ?? 0, startedAt: new Date().toISOString(), routes: routesArg.length > 0 ? 1 : 1 };

  child.on("exit", (code) => {
    runningJob = null;
    console.log(`[monitor] batch exited with code ${code}`);
  });
  child.on("error", (err) => {
    runningJob = null;
    console.error(`[monitor] batch failed to start:`, err.message);
  });

  sendJson(res, 202, { accepted: true, pid: child.pid, startedAt: runningJob.startedAt, message: "Batch started. Poll GET /api/jobs for progress." });
}

async function apiVerification(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fares = await readJson<FaresOutput>(FILES.fares);
  if (!fares) {
    sendJson(res, 200, { verifications: [], capturedAt: null, taskId: null });
    return;
  }
  const summary = {
    matched: fares.verifications.filter((v) => v.status === "match").length,
    mismatched: fares.verifications.filter((v) => v.status === "mismatch").length,
    noReference: fares.verifications.filter((v) => v.status === "no_reference").length,
    notExtracted: fares.verifications.filter((v) => v.status === "not_extracted").length,
  };
  sendJson(res, 200, {
    taskId: fares.taskId,
    capturedAt: fares.capturedAt,
    summary,
    verifications: fares.verifications,
  });
}

async function apiExports(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const exports: Array<{ name: string; file: string; size: number; modified: string | null }> = [];
  const candidates = [
    { name: "89-column CSV (public-products)", file: FILES.productsCsv },
    { name: "Pipeline JSON (public-products)", file: FILES.productsJson },
    { name: "Monitor metrics", file: FILES.metrics },
    { name: "Monitor cache (fares)", file: FILES.cache },
    { name: "Monitor checkpoint (jobs)", file: FILES.checkpoint },
    { name: "Fare verification", file: FILES.fares },
  ];
  for (const c of candidates) {
    if (existsSync(c.file)) {
      const st = await stat(c.file);
      exports.push({ name: c.name, file: c.file.replace(PROJECT_DIR + "/", ""), size: st.size, modified: st.mtime.toISOString() });
    }
  }
  // Also list any batch response files.
  const batchDir = join(DEBUG_DIR, "uber-responses", "batch");
  if (existsSync(batchDir)) {
    const files = await readdir(batchDir);
    for (const f of files) {
      const fp = join(batchDir, f);
      const st = await stat(fp);
      exports.push({ name: `Batch response: ${f}`, file: fp.replace(PROJECT_DIR + "/", ""), size: st.size, modified: st.mtime.toISOString() });
    }
  }
  sendJson(res, 200, { exports });
}

async function apiExportDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const rel = url.searchParams.get("file");
  if (!rel) {
    sendJson(res, 400, { error: "Missing ?file= parameter" });
    return;
  }
  // Only allow downloading from output/ or debug/ (never uber-auth-state.json).
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PROJECT_DIR, safe);
  if (!filePath.startsWith(PROJECT_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (filePath.includes("uber-auth-state.json")) {
    sendText(res, 403, "Forbidden: session state is not exportable");
    return;
  }
  if (!existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  const data = await readFile(filePath);
  const ct = MIME[extname(filePath)] ?? "application/octet-stream";
  const filename = filePath.split("/").pop() ?? "download";
  res.writeHead(200, {
    "content-type": ct,
    "content-length": data.length,
    "content-disposition": `attachment; filename="${filename}"`,
  });
  res.end(data);
}

async function apiMonitorLog(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const log = await readText(FILES.monitorLog);
  sendText(res, 200, log ?? "(no monitor log yet)", "text/plain; charset=utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

async function routeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  try {
    if (url === "/api/health") return await apiHealth(req, res);
    if (url === "/api/dashboard") return await apiDashboard(req, res);
    if (url === "/api/routes") return await apiRoutes(req, res);
    if (url === "/api/prices") return await apiPrices(req, res);
    if (url === "/api/jobs" && method === "GET") return await apiJobs(req, res);
    if (url === "/api/jobs/run" && method === "POST") return await apiJobsRun(req, res);
    if (url === "/api/verification") return await apiVerification(req, res);
    if (url === "/api/exports" && method === "GET") return await apiExports(req, res);
    if (url === "/api/exports/download") return await apiExportDownload(req, res);
    if (url === "/api/monitor/log") return await apiMonitorLog(req, res);
    sendJson(res, 404, { error: `Unknown API route: ${method} ${url}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[api] ${method} ${url} error:`, msg);
    sendJson(res, 500, { error: "Internal server error", message: msg });
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/api/")) {
    await routeApi(req, res);
    return;
  }
  // Static dashboard.
  await serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Uber dashboard server listening on http://${HOST}:${PORT}`);
  console.log(`  API:      http://${HOST}:${PORT}/api/health`);
  console.log(`  Dashboard: http://${HOST}:${PORT}/`);
});

export { server };
