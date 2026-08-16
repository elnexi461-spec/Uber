import { describe, it } from "node:test";
import assert from "node:assert";
import { server } from "../server.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BASE = `http://localhost:3456`;
const AUTH_STATE_PATH = join(process.cwd(), "..", "..", "debug", "uber-auth-state.json");

async function req(path: string, opts?: RequestInit) {
  const url = new URL(path, BASE);
  const res = await fetch(url.toString(), opts);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body };
}

describe("Auth endpoints (remote browser session)", async () => {
  const originalPort = process.env["PORT"];
  process.env["PORT"] = "3456";

  await new Promise<void>((resolve) => {
    server.listen(3456, "127.0.0.1", resolve);
  });

  it("GET /api/auth/status shows loginRequired when no session", async () => {
    const { status, body } = await req("/api/auth/status");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "loginRequired");
    assert.strictEqual(body.connected, false);
  });

  it("POST /api/auth/login starts a remote browser session", async () => {
    const { status, body } = await req("/api/auth/login", { method: "POST" });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "login_started");
    assert.ok(body.sessionId, "sessionId should be present");
    assert.ok(body.loginUrl, "loginUrl should be present");
    assert.ok(body.loginUrl.includes("/auth/session/"), "loginUrl should contain /auth/session/");
    assert.strictEqual(body.expiresInMinutes, 15);
  });

  it("GET /api/auth/status shows loginInProgress after login start", async () => {
    const { status, body } = await req("/api/auth/status");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "loginInProgress");
    assert.strictEqual(body.connected, false);
  });

  it("GET /auth/session/:id returns the remote browser HTML page", async () => {
    const loginRes = await req("/api/auth/login", { method: "POST" });
    const sessionId = loginRes.body.sessionId;
    const { status, body } = await req(`/auth/session/${sessionId}`);
    assert.strictEqual(status, 200);
    assert.ok(body.includes("Uber Remote Login"), "should contain remote login title");
    assert.ok(body.includes("screenshot"), "should reference screenshot endpoint");
  });

  it("GET /api/auth/session/:id/screenshot returns 404 for invalid session", async () => {
    const { status, body } = await req("/api/auth/session/invalid123/screenshot");
    assert.strictEqual(status, 404);
    assert.ok(body.error);
  });

  it("POST /api/auth/session/:id/click returns 404 for invalid session", async () => {
    const { status, body } = await req("/api/auth/session/invalid123/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 100, y: 200 }),
    });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.ok, false);
  });

  it("POST /api/auth/session/:id/type returns 404 for invalid session", async () => {
    const { status, body } = await req("/api/auth/session/invalid123/type", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.ok, false);
  });

  it("POST /api/auth/logout clears session", async () => {
    const { status, body } = await req("/api/auth/logout", { method: "POST" });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "cleared");

    const statusRes = await req("/api/auth/status");
    assert.strictEqual(statusRes.body.status, "loginRequired");
    assert.strictEqual(statusRes.body.connected, false);
  });

  it("POST /api/jobs/run rejects when no auth session", async () => {
    const { status, body } = await req("/api/jobs/run", { method: "POST" });
    assert.strictEqual(status, 403);
    assert.ok(body.error.includes("No authenticated Uber session"));
  });

  it("GET /api/health reports auth status", async () => {
    const { status, body } = await req("/api/health");
    assert.strictEqual(status, 200);
    assert.ok("authenticatedSession" in body);
    assert.ok("authStatus" in body);
    assert.ok("sessionAgeHours" in body);
  });

  // Cleanup
  server.close();
  process.env["PORT"] = originalPort;
});
