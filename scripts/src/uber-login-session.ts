/**
 * Remote browser session manager for Uber authentication.
 *
 * Creates a temporary Playwright browser session accessible via a secure URL.
 * The user interacts with the remote browser through screenshot polling and
 * input forwarding. Once authenticated, the Playwright storageState is saved
 * to the scraper's AUTH_STATE_PATH.
 *
 * Security:
 *   - Session IDs are cryptographically random 24-byte hex strings.
 *   - Sessions expire after 15 minutes and are automatically destroyed.
 *   - StorageState is never exposed through API responses.
 *   - Only one pending login session is allowed at a time.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_STATE_PATH, isLoggedIn, saveAuthState } from "./uber-fare-extract.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(dirname(SCRIPT_DIR));
const DEBUG_DIR = join(PROJECT_DIR, "debug");
const SESSION_TTL_MS = 15 * 60 * 1000;        // 15 minutes
const SCREENSHOT_INTERVAL_MS = 600;           // 600ms
const AUTH_CHECK_INTERVAL_MS = 2500;          // 2.5s
const VIEWPORT = { width: 390, height: 844 }; // iPhone 13

interface RemoteLoginSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  status: "pending" | "authenticated" | "expired" | "failed";
  createdAt: number;
  expiresAt: number;
  lastScreenshot: Buffer | null;
  lastScreenshotAt: number;
}

const sessions = new Map<string, RemoteLoginSession>();

function generateSessionId(): string {
  return randomBytes(24).toString("hex");
}

/** Close any existing pending session to enforce one-at-a-time. */
async function closePendingSessions(): Promise<void> {
  for (const [id, s] of sessions) {
    if (s.status === "pending") {
      await closeSession(id);
    }
  }
}

export async function createLoginSession(serverUrl: string): Promise<{
  id: string;
  loginUrl: string;
  expiresAt: string;
}> {
  await closePendingSessions();

  const id = generateSessionId();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-HK",
    timezoneId: "Asia/Hong_Kong",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto("https://m.uber.com/", { waitUntil: "domcontentloaded", timeout: 30000 });

  const now = Date.now();
  const session: RemoteLoginSession = {
    id,
    browser,
    context,
    page,
    status: "pending",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastScreenshot: null,
    lastScreenshotAt: 0,
  };
  sessions.set(id, session);

  startScreenshotLoop(id);
  startAuthCheckLoop(id);

  const loginUrl = `${serverUrl}/auth/session/${id}`;
  return { id, loginUrl, expiresAt: new Date(session.expiresAt).toISOString() };
}

async function startScreenshotLoop(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session || session.status !== "pending") return;

  try {
    const screenshot = await session.page.screenshot({
      type: "jpeg",
      quality: 55,
      fullPage: false,
    });
    session.lastScreenshot = screenshot;
    session.lastScreenshotAt = Date.now();
  } catch {
    // Page may have navigated or closed
  }

  setTimeout(() => startScreenshotLoop(id), SCREENSHOT_INTERVAL_MS);
}

async function startAuthCheckLoop(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session || session.status !== "pending") return;

  if (Date.now() > session.expiresAt) {
    session.status = "expired";
    await closeSession(id);
    return;
  }

  try {
    const loggedIn = await isLoggedIn(session.page);
    if (loggedIn) {
      session.status = "authenticated";
      await saveAuthState(session.context);
      await closeSession(id);
      return;
    }
  } catch {
    // Page may be navigating
  }

  setTimeout(() => startAuthCheckLoop(id), AUTH_CHECK_INTERVAL_MS);
}

export function getScreenshot(id: string): Buffer | null {
  const session = sessions.get(id);
  if (!session) return null;
  if (session.status !== "pending") return null;
  return session.lastScreenshot;
}

export async function forwardClick(id: string, x: number, y: number): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.status !== "pending") return false;
  try {
    await session.page.mouse.click(Math.round(x), Math.round(y));
    return true;
  } catch {
    return false;
  }
}

export async function forwardType(id: string, text: string, pressEnter?: boolean): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.status !== "pending") return false;
  try {
    await session.page.keyboard.type(text);
    if (pressEnter) await session.page.keyboard.press("Enter");
    return true;
  } catch {
    return false;
  }
}

export function getSessionInfo(id: string): { status: string; expiresAt: string } | null {
  const session = sessions.get(id);
  if (!session) return null;
  return { status: session.status, expiresAt: new Date(session.expiresAt).toISOString() };
}

export function hasPendingSession(): boolean {
  return [...sessions.values()].some((s) => s.status === "pending");
}

export function hasRecentlyAuthenticated(): boolean {
  return [...sessions.values()].some((s) => s.status === "authenticated");
}

export async function closeSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  try {
    await session.context.close();
  } catch {}
  try {
    await session.browser.close();
  } catch {}
  sessions.delete(id);
}

/** Clean up stale sessions periodically. */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt + 60000) {
      closeSession(id);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, 60000);
cleanupTimer.unref();

/** Get the overall auth status for the scraper. */
export async function getAuthStatus(): Promise<{
  status: "loginRequired" | "loginInProgress" | "authenticated" | "expired";
  connected: boolean;
  lastAuthenticated: string | null;
  ageHours: number | null;
}> {
  if (hasPendingSession()) {
    return { status: "loginInProgress", connected: false, lastAuthenticated: null, ageHours: null };
  }

  if (hasRecentlyAuthenticated()) {
    // Give the dashboard a few seconds to see "authenticated" before clearing
    setTimeout(() => {
      for (const [id, s] of sessions) {
        if (s.status === "authenticated") closeSession(id);
      }
    }, 5000);
    return { status: "authenticated", connected: true, lastAuthenticated: new Date().toISOString(), ageHours: 0 };
  }

  if (!existsSync(AUTH_STATE_PATH)) {
    return { status: "loginRequired", connected: false, lastAuthenticated: null, ageHours: null };
  }

  const st = await stat(AUTH_STATE_PATH).catch(() => null);
  if (!st) {
    return { status: "loginRequired", connected: false, lastAuthenticated: null, ageHours: null };
  }

  const ageMs = Date.now() - st.mtime.getTime();
  const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
  const stale = ageMs > 7 * 24 * 60 * 60 * 1000; // 7 days

  if (stale) {
    return { status: "expired", connected: false, lastAuthenticated: st.mtime.toISOString(), ageHours };
  }

  return { status: "authenticated", connected: true, lastAuthenticated: st.mtime.toISOString(), ageHours };
}

/** Delete the stored auth state. */
export async function clearAuthState(): Promise<void> {
  for (const id of sessions.keys()) {
    await closeSession(id);
  }
  if (existsSync(AUTH_STATE_PATH)) {
    await unlink(AUTH_STATE_PATH);
  }
}
