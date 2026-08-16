/**
 * Local Uber login helper.
 *
 * Runs on the user's local machine (not on Render).
 * Opens a visible Chromium browser, navigates to m.uber.com,
 * waits for the user to complete login/OTP/CAPTCHA manually,
 * then uploads the Playwright storageState to the remote server.
 *
 * Usage:
 *   npx tsx scripts/src/uber-login-remote.ts --token <token> --server <url>
 */
import { chromium, devices } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_URL = "https://m.uber.com/";

async function isLoggedIn(page: import("playwright").Page): Promise<boolean> {
  const body = await page.locator("body").innerText().catch(() => "");
  const hasLoginCta = /log in|sign in|continue with phone|get started|登入|create account/i.test(body);
  if (hasLoginCta) return false;
  const accountLocator = page
    .getByRole("button", { name: /account|profile|menu/i })
    .or(page.getByRole("link", { name: /account|profile/i }))
    .or(page.locator('[data-testid*="account" i], [aria-label*="account" i]'));
  const hasAccount = await accountLocator.first().isVisible().catch(() => false);
  if (hasAccount) return true;
  const cookies = await page.context().cookies("https://m.uber.com/");
  const jwt = cookies.find((c) => c.name === "jwt-session");
  if (jwt) {
    const payload = jwt.value.split(".")[1];
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { sub?: string; user_id?: string; rider_id?: string; uuid?: string };
      const riderId = decoded.sub ?? decoded.user_id ?? decoded.rider_id ?? decoded.uuid;
      if (riderId && /^[0-9a-f]{8}-/i.test(riderId)) return true;
    } catch { /* not a JWT */ }
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const tokenIdx = args.indexOf("--token");
  const serverIdx = args.indexOf("--server");

  const token = tokenIdx >= 0 ? args[tokenIdx + 1] : null;
  const serverUrl = serverIdx >= 0 ? args[serverIdx + 1] : "http://localhost:3000";

  if (!token) {
    console.error("Usage: npx tsx scripts/src/uber-login-remote.ts --token <token> [--server <url>]");
    process.exit(1);
  }

  console.log(">>> Starting local Uber login helper");
  console.log(`    Server: ${serverUrl}`);
  console.log(`    Token:  ${token.slice(0, 8)}...${token.slice(-8)}\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    locale: "en-HK",
    timezoneId: "Asia/Hong_Kong",
  });
  const page = await context.newPage();

  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log(">>> VISIBLE BROWSER OPENED FOR MANUAL UBER AUTHENTICATION");
  console.log("    Please complete login (phone / SMS / CAPTCHA) in the browser window.");
  console.log("    Waiting up to 10 minutes for successful authentication...\n");

  const start = Date.now();
  const timeout = 10 * 60 * 1000;
  let loggedIn = false;

  while (Date.now() - start < timeout) {
    loggedIn = await isLoggedIn(page);
    if (loggedIn) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!loggedIn) {
    console.error("\n❌ Login was not completed within the timeout.");
    await browser.close();
    process.exit(1);
  }

  console.log("\n✅ Login detected! Uploading session to server...\n");

  const state = await context.storageState();
  const tmpDir = join(tmpdir(), "uber-login-" + Date.now());
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, "auth-state.json");
  await writeFile(tmpPath, JSON.stringify(state), "utf8");

  const b64 = await readFile(tmpPath, "base64");

  const resp = await fetch(`${serverUrl}/api/auth/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, storageState: b64 }),
  });

  await browser.close();

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    console.error(`\n❌ Upload failed: ${resp.status} ${errText}`);
    process.exit(1);
  }

  console.log("✅ Session uploaded successfully!");
  console.log("   You can now close this terminal and return to the dashboard.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
