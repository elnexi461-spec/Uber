import { describe, it } from "node:test";
import assert from "node:assert";
import { server } from "../server.js";

const BASE = `http://localhost:3456`;

async function req(path: string, opts?: RequestInit) {
  const url = new URL(path, BASE);
  const res = await fetch(url.toString(), opts);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body };
}

describe("Auth endpoints", async () => {
  const originalPort = process.env["PORT"];
  process.env["PORT"] = "3456";

  await new Promise<void>((resolve) => {
    server.listen(3456, "127.0.0.1", resolve);
  });

  it("POST /api/auth/login returns a token and instructions", async () => {
    const { status, body } = await req("/api/auth/login", { method: "POST" });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "local_login_required");
    assert.ok(body.token, "token should be present");
    assert.ok(body.command, "command should be present");
    assert.ok(body.expiresInMinutes, "expiresInMinutes should be present");
  });

  it("GET /api/auth/status shows not connected when no session", async () => {
    const { status, body } = await req("/api/auth/status");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.connected, false);
    assert.strictEqual(body.exists, false);
  });

  it("POST /api/auth/callback rejects invalid token", async () => {
    const { status, body } = await req("/api/auth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invalid", storageState: "abc" }),
    });
    assert.strictEqual(status, 403);
    assert.ok(body.error);
  });

  it("POST /api/auth/callback accepts valid token and saves session", async () => {
    const loginRes = await req("/api/auth/login", { method: "POST" });
    const token = loginRes.body.token;

    const fakeState = JSON.stringify({ cookies: [], origins: [] });
    const b64 = Buffer.from(fakeState).toString("base64");

    const { status, body } = await req("/api/auth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, storageState: b64 }),
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "saved");

    const statusRes = await req("/api/auth/status");
    assert.strictEqual(statusRes.body.connected, true);
    assert.ok(statusRes.body.lastAuthenticated);
  });

  it("POST /api/auth/logout clears session", async () => {
    const { status, body } = await req("/api/auth/logout", { method: "POST" });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "cleared");

    const statusRes = await req("/api/auth/status");
    assert.strictEqual(statusRes.body.connected, false);
  });

  it("POST /api/jobs/run rejects when no auth session", async () => {
    const { status, body } = await req("/api/jobs/run", { method: "POST" });
    assert.strictEqual(status, 403);
    assert.ok(body.error.includes("No authenticated Uber session"));
  });

  server.close();
  process.env["PORT"] = originalPort;
});
