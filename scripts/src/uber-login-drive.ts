// Interactive Playwright driver for manual Uber login assistance.
// Launches a VISIBLE browser (same context as uber-fare-extract.ts) and reads
// line-delimited JSON commands from stdin. Prints JSON results to stdout.
//
// Commands:
//   {"cmd":"snap"}                              -> {ok, title, url, hasInputs:[...]}
//   {"cmd":"click","role":"textbox","name":"X"} -> {ok}
//   {"cmd":"clickText","text":"Continue"}       -> {ok}
//   {"cmd":"clickPlaceholder","ph":"phone"}     -> {ok}
//   {"cmd":"type","text":"..."}                 -> {ok}
//   {"cmd":"press","key":"Enter"}               -> {ok}
//   {"cmd":"eval","js":"document.title"}        -> {ok, value}
//   {"cmd":"inputs"}                            -> {ok, inputs:[{tag,name,ph,type,id}]}
//   {"cmd":"buttons"}                           -> {ok, buttons:[{text,role}]}
//   {"cmd":"screenshot","path":"/tmp/x.png"}    -> {ok}
//   {"cmd":"wait","ms":2000}                    -> {ok}
//   {"cmd":"logged"}                            -> {ok, isLoggedIn}
//   {"cmd":"saveState","path":"debug/uber-auth-state.json"} -> {ok}
//   {"cmd":"quit"}                              -> exits
import { chromium, devices } from "playwright";
import * as readline from "readline";
import { mkdirSync, existsSync } from "fs";

const ROUTE = { pickup: { lat: 22.395771, lng: 114.217333 }, dest: { lat: 22.325528, lng: 114.190810 } };
const HOME_URL = "https://m.uber.com/";
const AUTH_STATE_PATH = "debug/uber-auth-state.json";

async function isLoggedIn(page: import("playwright").Page): Promise<boolean> {
  const body = await page.locator("body").innerText().catch(() => "");
  const hasLoginCta = /log in|sign in|continue with phone|get started|登入|create account/i.test(body);
  if (hasLoginCta) return false;
  const accountAffordance = page
    .getByRole("button", { name: /account|profile|menu/i })
    .or(page.getByRole("link", { name: /account|profile/i }))
    .or(page.locator('[data-testid*="account" i], [aria-label*="account" i]'));
  try { await accountAffordance.first().waitFor({ state: "visible", timeout: 1500 }); return true; } catch { /* */ }
  const cookies = await page.context().cookies("https://m.uber.com/");
  const sid = cookies.find((c) => c.name === "sid");
  if (sid && sid.value && sid.value.length > 20) return true;
  return false;
}

async function send(obj: any) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function main() {
  mkdirSync("debug", { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const contextOpts: any = {
    ...devices["iPhone 13"],
    locale: "en-HK",
    timezoneId: "Asia/Hong_Kong",
    geolocation: { latitude: ROUTE.pickup.lat, longitude: ROUTE.pickup.lng },
    permissions: ["geolocation"],
  };
  if (existsSync(AUTH_STATE_PATH)) { contextOpts.storageState = AUTH_STATE_PATH; }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await page.goto(HOME_URL, { waitUntil: "load", timeout: 60000 }).catch(() => {});
  await send({ ok: true, ready: true, title: await page.title().catch(() => ""), url: page.url() });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cmd: any;
    try { cmd = JSON.parse(trimmed); } catch { await send({ ok: false, error: "invalid json" }); continue; }
    try {
      switch (cmd.cmd) {
        case "snap": {
          await page.waitForTimeout(500);
          await send({ ok: true, title: await page.title().catch(() => ""), url: page.url(), isLoggedIn: await isLoggedIn(page) });
          break;
        }
        case "inputs": {
          const els = await page.locator("input, textarea").all();
          const out: any[] = [];
          for (const e of els) {
            out.push({
              tag: await e.evaluate((n: any) => n.tagName).catch(() => ""),
              name: await e.getAttribute("name").catch(() => ""),
              ph: await e.getAttribute("placeholder").catch(() => ""),
              type: await e.getAttribute("type").catch(() => ""),
              id: await e.getAttribute("id").catch(() => ""),
              aria: await e.getAttribute("aria-label").catch(() => ""),
              visible: await e.isVisible().catch(() => false),
            });
          }
          await send({ ok: true, inputs: out });
          break;
        }
        case "buttons": {
          const els = await page.locator("button, a, [role=button]").all();
          const out: any[] = [];
          for (const e of els) {
            const t = (await e.innerText().catch(() => "")) || (await e.getAttribute("aria-label").catch(() => ""));
            if (t && (await e.isVisible().catch(() => false))) out.push({ text: t.trim().slice(0, 60) });
          }
          await send({ ok: true, buttons: out });
          break;
        }
        case "click": {
          const loc = (cmd.role === "textbox" ? page.getByRole("textbox", { name: new RegExp(cmd.name, "i") }) : page.getByRole(cmd.role || "button", { name: new RegExp(cmd.name, "i") })).first();
          await loc.waitFor({ state: "visible", timeout: 4000 });
          await loc.click({ timeout: 4000 });
          await send({ ok: true });
          break;
        }
        case "clickPlaceholder": {
          const loc = page.getByPlaceholder(new RegExp(cmd.ph, "i")).first();
          await loc.waitFor({ state: "visible", timeout: 4000 });
          await loc.click({ timeout: 4000 });
          await send({ ok: true });
          break;
        }
        case "clickText": {
          const loc = page.getByText(new RegExp(cmd.text, "i")).first();
          await loc.waitFor({ state: "visible", timeout: 4000 });
          await loc.click({ timeout: 4000 });
          await send({ ok: true });
          break;
        }
        case "type": {
          await page.keyboard.type(cmd.text, { delay: 40 });
          await send({ ok: true });
          break;
        }
        case "fill": {
          // fill the currently focused element
          await page.locator(":focus").fill(cmd.text).catch(async () => { await page.keyboard.type(cmd.text, { delay: 40 }); });
          await send({ ok: true });
          break;
        }
        case "press": { await page.keyboard.press(cmd.key); await send({ ok: true }); break; }
        case "eval": { const v = await page.evaluate(cmd.js); await send({ ok: true, value: v }); break; }
        case "screenshot": { await page.screenshot({ path: cmd.path || "/tmp/driver-snap.png" }); await send({ ok: true }); break; }
        case "wait": { await page.waitForTimeout(cmd.ms || 1000); await send({ ok: true }); break; }
        case "logged": { await send({ ok: true, isLoggedIn: await isLoggedIn(page) }); break; }
        case "goto": { await page.goto(cmd.url, { waitUntil: "load", timeout: 60000 }).catch(() => {}); await send({ ok: true, url: page.url() }); break; }
        case "saveState": { await context.storageState({ path: cmd.path || AUTH_STATE_PATH }); await send({ ok: true, path: cmd.path || AUTH_STATE_PATH }); break; }
        case "quit": { await browser.close(); process.exit(0); break; }
        default: await send({ ok: false, error: "unknown cmd: " + cmd.cmd });
      }
    } catch (err: any) {
      await send({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e) })); process.exit(1); });
