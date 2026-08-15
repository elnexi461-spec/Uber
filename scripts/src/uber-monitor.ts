/**
 * Hardened batch Uber fare monitor.
 *
 * Reuses the authenticated Playwright extractor (uber-fare-extract.ts) and the
 * 89-column pipeline (uber-public-extract.ts) without rewriting either. Adds
 * only the production-hardening layer:
 *   - persistent authenticated browser session (reuses debug/uber-auth-state.json)
 *   - per-session rate limiting (min interval between requests)
 *   - global concurrency limit (semaphore)
 *   - exponential backoff with jitter
 *   - request/result caching (persisted, route-keyed)
 *   - duplicate-route detection (skip already-collected routes)
 *   - checkpointing + resumable jobs
 *   - retry budgets (per-route and global)
 *   - session health/expiry detection
 *   - CAPTCHA/challenge detection → pause that session, preserve results
 *   - clean recovery after temporary failures
 *   - structured logging + basic metrics
 *
 * Flow: route queue → scheduler → healthy authenticated session → rate-limited
 * Playwright request → fare extraction → validation → 89-column output → checkpoint
 *
 * Security: never logs passwords, OTPs, cookies, or session-state contents.
 * Never solves/bypasses CAPTCHA. A challenged session is paused and marked as
 * requiring human verification; completed results are preserved.
 *
 * Usage:
 *   DISPLAY=:99 ./scripts/node_modules/.bin/tsx scripts/src/uber-monitor.ts \
 *     [--routes <json>] [--max-concurrency 1] [--min-interval-ms 15000] \
 *     [--retry-budget 2] [--challenge-wait-ms 30000] [--dry-run]
 */
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";
import {
  AUTH_STATE_PATH,
  DEBUG_DIR,
  HOME_URL,
  RESPONSE_DIR,
  ROUTE,
  createResponseCollector,
  extractRouteFares,
  isLoggedIn,
  saveAuthState,
  fareMagnitude,
  type ExtractedFare,
  type ResponseCollector,
  type RouteDef,
  type RouteExtractionResult,
} from "./uber-fare-extract.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SessionStatus = "healthy" | "expired" | "challenged" | "closed";

interface MonitoredSession {
  id: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  status: SessionStatus;
  lastRequestAt: number;
  requestCount: number;
}

interface RouteJob {
  route: RouteDef;
  status: "pending" | "in_progress" | "done" | "failed" | "challenged" | "cached";
  attempts: number;
  lastError: string | null;
  result: RouteExtractionResult | null;
  completedAt: string | null;
}

interface CacheEntry {
  routeId: string;
  routeKey: string;
  capturedAt: string;
  fares: ExtractedFare[];
  reached: boolean;
}

interface CheckpointState {
  startedAt: string;
  updatedAt: string;
  jobs: RouteJob[];
  metrics: Metrics;
}

interface Metrics {
  requestsCompleted: number;
  faresExtracted: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  rateLimitWaits: number;
  failedRoutes: number;
  challengedRoutes: number;
  sessionStatus: Record<number, SessionStatus>;
  captchaDetections: number;
}

interface MonitorConfig {
  maxConcurrency: number;
  minIntervalMs: number; // per-session rate limit
  retryBudget: number; // max retries per route
  globalRetryBudget: number; // max total retries across batch
  challengeWaitMs: number; // how long driveRoute waits for a challenge to clear
  maxBackoffMs: number;
  baseBackoffMs: number;
  cacheTtlMs: number; // 0 = no expiry
  pollIntervalMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & paths
// ─────────────────────────────────────────────────────────────────────────────

const CHECKPOINT_PATH = join(DEBUG_DIR, "monitor-checkpoint.json");
const CACHE_PATH = join(DEBUG_DIR, "monitor-cache.json");
const LOG_PATH = join(DEBUG_DIR, "monitor.log");
const METRICS_PATH = join(DEBUG_DIR, "monitor-metrics.json");
const BATCH_RESPONSE_DIR = join(RESPONSE_DIR, "batch");

const DEFAULT_CONFIG: MonitorConfig = {
  maxConcurrency: 1,
  minIntervalMs: 15000,
  retryBudget: 2,
  globalRetryBudget: 8,
  challengeWaitMs: 30000,
  maxBackoffMs: 60000,
  baseBackoffMs: 2000,
  cacheTtlMs: 0,
  pollIntervalMs: 1000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Structured logging (no secrets — never logs cookies/session contents)
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function ts(): string {
  return new Date().toISOString();
}

async function log(level: LogLevel, event: string, fields?: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: ts(), level, event, ...fields });
  console.log(line);
  await appendFile(LOG_PATH, line + "\n", "utf8").catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic route key for dedup + caching (rounded coords absorb GPS jitter). */
function routeKey(route: RouteDef): string {
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return `${r(route.pickup.lat)},${r(route.pickup.lng)}→${r(route.destination.lat)},${r(route.destination.lng)}`;
}

/** Exponential backoff with full jitter. */
function backoffMs(attempt: number, cfg: MonitorConfig): number {
  const exp = cfg.baseBackoffMs * 2 ** attempt;
  const cap = Math.min(exp, cfg.maxBackoffMs);
  return Math.floor(Math.random() * cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Simple async semaphore for global concurrency limiting. */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.available = permits;
  }
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available--;
  }
  release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache (route-keyed, persisted)
// ─────────────────────────────────────────────────────────────────────────────

class ResultCache {
  private entries = new Map<string, CacheEntry>();

  static async load(): Promise<ResultCache> {
    const cache = new ResultCache();
    if (existsSync(CACHE_PATH)) {
      try {
        const data = JSON.parse(await readFile(CACHE_PATH, "utf8")) as CacheEntry[];
        for (const e of data) cache.entries.set(e.routeKey, e);
      } catch {
        /* corrupt cache — start fresh */
      }
    }
    return cache;
  }

  has(route: RouteDef, ttlMs: number): boolean {
    const e = this.entries.get(routeKey(route));
    if (!e) return false;
    if (ttlMs > 0 && Date.now() - new Date(e.capturedAt).getTime() > ttlMs) return false;
    return e.reached && e.fares.length > 0;
  }

  get(route: RouteDef): CacheEntry | null {
    return this.entries.get(routeKey(route)) ?? null;
  }

  set(route: RouteDef, result: RouteExtractionResult): void {
    if (!result.reached || result.fares.length === 0) return;
    this.entries.set(routeKey(route), {
      routeId: route.id,
      routeKey: routeKey(route),
      capturedAt: ts(),
      fares: result.fares,
      reached: result.reached,
    });
  }

  async save(): Promise<void> {
    await writeFile(CACHE_PATH, JSON.stringify([...this.entries.values()], null, 2) + "\n", "utf8");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpointing
// ─────────────────────────────────────────────────────────────────────────────

async function loadCheckpoint(): Promise<CheckpointState | null> {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(await readFile(CHECKPOINT_PATH, "utf8")) as CheckpointState;
  } catch {
    return null;
  }
}

async function saveCheckpoint(state: CheckpointState): Promise<void> {
  state.updatedAt = ts();
  await writeFile(CHECKPOINT_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────────

async function createSession(id: number, route: RouteDef): Promise<MonitoredSession> {
  const browser = await chromium.launch({ headless: false });
  const contextOpts: Parameters<Browser["newContext"]>[0] = {
    ...devices["iPhone 13"],
    locale: "en-HK",
    timezoneId: "Asia/Hong_Kong",
    geolocation: { latitude: route.pickup.lat, longitude: route.pickup.lng },
    permissions: ["geolocation"],
  };
  if (existsSync(AUTH_STATE_PATH)) {
    contextOpts.storageState = AUTH_STATE_PATH;
  } else {
    throw new Error(`No authenticated session at ${AUTH_STATE_PATH}. Run uber-fare-extract.ts --login first.`);
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { id, browser, context, page, status: "healthy", lastRequestAt: 0, requestCount: 0 };
}

/** Health check: navigate home and verify the session is still authenticated. */
async function checkSessionHealth(session: MonitoredSession): Promise<boolean> {
  if (session.status !== "healthy") return false;
  try {
    await session.page.goto(HOME_URL, { waitUntil: "load", timeout: 30000 });
    const ok = await isLoggedIn(session.page);
    if (!ok) {
      session.status = "expired";
      await log("warn", "session_expired", { sessionId: session.id });
    }
    return ok;
  } catch {
    session.status = "closed";
    await log("warn", "session_unreachable", { sessionId: session.id });
    return false;
  }
}

/** Per-session rate limit: enforce min interval between requests. */
async function rateLimit(session: MonitoredSession, cfg: MonitorConfig, metrics: Metrics): Promise<void> {
  const elapsed = Date.now() - session.lastRequestAt;
  const wait = cfg.minIntervalMs - elapsed;
  if (wait > 0) {
    metrics.rateLimitWaits++;
    await log("info", "rate_limit_wait", { sessionId: session.id, waitMs: wait });
    await sleep(wait);
  }
  session.lastRequestAt = Date.now();
}

async function closeSession(session: MonitoredSession): Promise<void> {
  try {
    await session.context.close();
  } catch {
    /* ignore */
  }
  try {
    await session.browser.close();
  } catch {
    /* ignore */
  }
  session.status = "closed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-route collection (with retry budget + backoff)
// ─────────────────────────────────────────────────────────────────────────────

interface CollectOutcome {
  job: RouteJob;
  fromCache: boolean;
}

async function collectRoute(
  session: MonitoredSession,
  job: RouteJob,
  cfg: MonitorConfig,
  cache: ResultCache,
  metrics: Metrics,
): Promise<CollectOutcome> {
  const route = job.route;

  // Duplicate-route detection / cache hit.
  if (cache.has(route, cfg.cacheTtlMs)) {
    const entry = cache.get(route)!;
    job.status = "cached";
    job.result = {
      routeId: route.id,
      reached: true,
      challenged: false,
      fares: entry.fares,
      domFares: [],
      productsJson: null,
      bodyText: "",
    };
    job.completedAt = ts();
    metrics.cacheHits++;
    await log("info", "cache_hit", { routeId: route.id, routeKey: routeKey(route) });
    return { job, fromCache: true };
  }
  metrics.cacheMisses++;

  let attempt = 0;
  while (attempt <= cfg.retryBudget) {
    job.attempts = attempt + 1;
    if (session.status !== "healthy") {
      job.status = session.status === "challenged" ? "challenged" : "failed";
      job.lastError = `session ${session.status}`;
      await log("warn", "route_aborted_session_unhealthy", { routeId: route.id, sessionStatus: session.status });
      return { job, fromCache: false };
    }

    await rateLimit(session, cfg, metrics);
    const collector: ResponseCollector = createResponseCollector();
    session.page.removeAllListeners("response");
    session.page.on("response", collector.handler);

    try {
      await log("info", "route_request_start", { routeId: route.id, attempt, sessionId: session.id });
      // Re-navigate to home so the pickup planner opens cleanly each time.
      await session.page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 });
      if (!(await isLoggedIn(session.page))) {
        session.status = "expired";
        job.status = "failed";
        job.lastError = "session expired mid-batch";
        metrics.failedRoutes++;
        await log("error", "session_expired_mid_batch", { routeId: route.id });
        return { job, fromCache: false };
      }

      const result = await extractRouteFares(session.page, route, collector, {
        challengeWaitMs: cfg.challengeWaitMs,
      });

      if (result.challenged) {
        // CAPTCHA/security challenge: stop this session, preserve results, do NOT retry aggressively.
        session.status = "challenged";
        job.status = "challenged";
        job.lastError = "security challenge detected — session requires human verification";
        metrics.challengedRoutes++;
        metrics.captchaDetections++;
        await log("error", "captcha_detected", { routeId: route.id, sessionId: session.id });
        await saveAuthState(session.context).catch(() => {});
        return { job, fromCache: false };
      }

      if (result.reached && result.fares.length > 0) {
        job.status = "done";
        job.result = result;
        job.completedAt = ts();
        metrics.requestsCompleted++;
        const count = result.fares.filter((f) => fareMagnitude(f) !== null).length;
        metrics.faresExtracted += count;
        cache.set(route, result);
        // Persist the raw products response for the 89-column pipeline.
        if (result.productsJson) {
          await mkdir(BATCH_RESPONSE_DIR, { recursive: true });
          const stamp = ts().replace(/[:.]/g, "");
          const file = join(BATCH_RESPONSE_DIR, `${stamp}-${route.id}-products-auth.json`);
          await writeFile(file, JSON.stringify(result.productsJson, null, 2) + "\n", "utf8");
          await log("info", "products_response_saved", { routeId: route.id, file });
        }
        await log("info", "route_done", { routeId: route.id, fares: count, attempt });
        return { job, fromCache: false };
      }

      // Temporary failure (no fares but no challenge) — back off and retry within budget.
      job.lastError = "reached screen but no fares extracted";
      await log("warn", "route_no_fares", { routeId: route.id, attempt });
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      await log("warn", "route_error", { routeId: route.id, attempt, error: job.lastError });
    }

    attempt++;
    if (attempt <= cfg.retryBudget) {
      metrics.retries++;
      const wait = backoffMs(attempt, cfg);
      await log("info", "retry_backoff", { routeId: route.id, attempt, waitMs: wait });
      await sleep(wait);
    }
  }

  job.status = "failed";
  metrics.failedRoutes++;
  await log("error", "route_failed", { routeId: route.id, attempts: job.attempts, error: job.lastError });
  return { job, fromCache: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { routes: RouteDef[]; cfg: Partial<MonitorConfig>; dryRun: boolean } {
  const cfg: Partial<MonitorConfig> = {};
  let dryRun = false;
  let routesFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--routes") routesFile = argv[++i];
    else if (a === "--max-concurrency") cfg.maxConcurrency = Number(argv[++i]);
    else if (a === "--min-interval-ms") cfg.minIntervalMs = Number(argv[++i]);
    else if (a === "--retry-budget") cfg.retryBudget = Number(argv[++i]);
    else if (a === "--global-retry-budget") cfg.globalRetryBudget = Number(argv[++i]);
    else if (a === "--challenge-wait-ms") cfg.challengeWaitMs = Number(argv[++i]);
    else if (a === "--cache-ttl-ms") cfg.cacheTtlMs = Number(argv[++i]);
  }

  let routes: RouteDef[];
  if (routesFile) {
    routes = JSON.parse(readFileSyncSync(routesFile)) as RouteDef[];
  } else {
    // Default: the confirmed HK route (used for the test batch).
    routes = [ROUTE];
  }
  return { routes, cfg, dryRun };
}

function readFileSyncSync(path: string): string {
  return readFileSync(path, "utf8");
}

async function runBatch(routes: RouteDef[], cfgOverrides: Partial<MonitorConfig>, dryRun: boolean): Promise<void> {
  const cfg: MonitorConfig = { ...DEFAULT_CONFIG, ...cfgOverrides };
  await mkdir(DEBUG_DIR, { recursive: true });
  await mkdir(RESPONSE_DIR, { recursive: true });

  const cache = await ResultCache.load();

  // Resume from checkpoint if present; otherwise initialize fresh jobs.
  const prev = await loadCheckpoint();
  let jobs: RouteJob[];
  if (prev && prev.jobs.length === routes.length) {
    jobs = prev.jobs.map((j, i) => ({
      ...j,
      route: routes[i], // refresh route defs in case input changed
      status: j.status === "in_progress" ? "pending" : j.status, // resume interrupted
    }));
    await log("info", "checkpoint_resumed", { resumed: jobs.filter((j) => j.status === "done" || j.status === "cached").length });
  } else {
    jobs = routes.map((route) => ({
      route,
      status: "pending",
      attempts: 0,
      lastError: null,
      result: null,
      completedAt: null,
    }));
  }

  const metrics: Metrics = {
    requestsCompleted: 0,
    faresExtracted: 0,
    retries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    rateLimitWaits: 0,
    failedRoutes: 0,
    challengedRoutes: 0,
    sessionStatus: {},
    captchaDetections: 0,
  };

  if (dryRun) {
    await log("info", "dry_run", { routes: routes.length, cacheHits: routes.filter((r) => cache.has(r, cfg.cacheTtlMs)).length });
    for (const route of routes) {
      const hit = cache.has(route, cfg.cacheTtlMs);
      await log("info", "dry_run_route", { routeId: route.id, routeKey: routeKey(route), wouldCacheHit: hit });
    }
    return;
  }

  const sem = new Semaphore(cfg.maxConcurrency);
  let globalRetries = 0;
  const state: CheckpointState = { startedAt: ts(), updatedAt: ts(), jobs, metrics };

  // Single persistent authenticated session (concurrency is bounded by the
  // semaphore; one browser avoids opening many authed sessions at once).
  const holder: { session: MonitoredSession | null } = { session: null };

  async function ensureSession(route: RouteDef): Promise<MonitoredSession | null> {
    if (holder.session && holder.session.status === "healthy") return holder.session;
    if (holder.session && (holder.session.status === "challenged" || holder.session.status === "expired")) {
      await log("error", "session_unavailable", { status: holder.session.status });
      return null;
    }
    try {
      holder.session = await createSession(1, route);
      metrics.sessionStatus[holder.session.id] = holder.session.status;
      await log("info", "session_created", { sessionId: holder.session.id });
      if (!(await checkSessionHealth(holder.session))) {
        await log("error", "session_health_check_failed", { sessionId: holder.session.id });
        return null;
      }
      return holder.session;
    } catch (err) {
      await log("error", "session_create_failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  await log("info", "batch_start", { routes: routes.length, config: cfg });

  // Process routes sequentially within the semaphore (concurrency=1 by default
  // to respect a single authenticated session; raise --max-concurrency only
  // when multiple authenticated sessions are available).
  for (const job of jobs) {
    if (job.status === "done" || job.status === "cached") {
      // Already completed in a prior run — count as cache hit for reporting.
      metrics.cacheHits++;
      await log("info", "skip_completed", { routeId: job.route.id, status: job.status });
      continue;
    }

    await sem.acquire();
    try {
      const sess = await ensureSession(job.route);
      if (!sess) {
        job.status = "failed";
        job.lastError = "no healthy session available";
        metrics.failedRoutes++;
        await log("error", "route_no_session", { routeId: job.route.id });
        continue;
      }

      const outcome = await collectRoute(sess, job, cfg, cache, metrics);
      metrics.sessionStatus[sess.id] = sess.status;

      // If a retry was consumed, account against the global budget.
      if (outcome.job.attempts > 1) {
        globalRetries += outcome.job.attempts - 1;
        if (globalRetries >= cfg.globalRetryBudget) {
          await log("warn", "global_retry_budget_exhausted", { globalRetries });
        }
      }

      // Checkpoint after every route (resumable).
      state.metrics = metrics;
      await saveCheckpoint(state);
      await cache.save();

      // If the session became challenged, stop scheduling further routes on it.
      if (sess.status === "challenged") {
        await log("error", "session_paused_challenged", { sessionId: sess.id, remaining: jobs.filter((j) => j.status === "pending").length });
        // Mark remaining pending routes as deferred (not failed — they can resume).
        for (const j of jobs) {
          if (j.status === "pending") {
            j.status = "failed";
            j.lastError = "deferred: session challenged, requires human verification";
          }
        }
        state.metrics = metrics;
        await saveCheckpoint(state);
        break;
      }
    } finally {
      sem.release();
    }
  }

  const finalSession: MonitoredSession | null = holder.session;
  if (finalSession) {
    await closeSession(finalSession);
    metrics.sessionStatus[finalSession.id] = finalSession.status;
  }

  state.metrics = metrics;
  await saveCheckpoint(state);
  await cache.save();
  await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + "\n", "utf8");

  // Print the final report.
  printReport(metrics, jobs, cfg);
}

function printReport(metrics: Metrics, jobs: RouteJob[], cfg: MonitorConfig): void {
  console.log("\n" + "=".repeat(70));
  console.log("UBER MONITOR — BATCH REPORT");
  console.log("=".repeat(70));
  console.log(`requests completed:    ${metrics.requestsCompleted}`);
  console.log(`fares extracted:       ${metrics.faresExtracted}`);
  console.log(`retries:               ${metrics.retries}`);
  console.log(`cache hits:            ${metrics.cacheHits}`);
  console.log(`cache misses:          ${metrics.cacheMisses}`);
  console.log(`rate-limit waits:      ${metrics.rateLimitWaits}`);
  console.log(`failed routes:         ${metrics.failedRoutes}`);
  console.log(`challenged routes:     ${metrics.challengedRoutes}`);
  console.log(`CAPTCHA detections:    ${metrics.captchaDetections}`);
  console.log(`session status:        ${JSON.stringify(metrics.sessionStatus)}`);
  console.log(`-`.repeat(70));
  console.log("Per-route:");
  for (const j of jobs) {
    const fares = j.result ? j.result.fares.filter((f) => fareMagnitude(f) !== null).length : 0;
    console.log(`  ${j.route.id}: ${j.status} (attempts=${j.attempts}, fares=${fares})${j.lastError ? " — " + j.lastError : ""}`);
  }
  console.log(`-`.repeat(70));
  console.log(`checkpoint:            ${CHECKPOINT_PATH}`);
  console.log(`cache:                 ${CACHE_PATH}`);
  console.log(`metrics:               ${METRICS_PATH}`);
  console.log(`log:                   ${LOG_PATH}`);
  console.log("=".repeat(70));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { routes, cfg, dryRun } = parseArgs(process.argv.slice(2));
  try {
    await runBatch(routes, cfg, dryRun);
  } catch (err) {
    await log("error", "batch_fatal", { error: err instanceof Error ? err.message : String(err) });
    console.error("Batch failed:", err);
    process.exitCode = 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error: unknown) => {
    console.error("Uber monitor failed:", error);
    process.exitCode = 1;
  });
}

export { runBatch, parseArgs, routeKey, backoffMs, Semaphore, ResultCache };
export type { RouteJob, Metrics, MonitorConfig, SessionStatus, MonitoredSession };
