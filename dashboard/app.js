// Uber Fare Monitor — dashboard frontend (vanilla JS, no build step)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`${path}: ${res.status} ${txt}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function tag(status) {
  const cls = String(status).toLowerCase().replace(/\s+/g, "_");
  return `<span class="tag ${cls}">${status}</span>`;
}

function metricCard(label, value, cls = "") {
  return `<div class="metric-card"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

// ── Navigation ──────────────────────────────────────────────────────────────
$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".view").forEach((v) => v.classList.remove("active"));
    $("#view-" + btn.dataset.view).classList.add("active");
    loadView(btn.dataset.view);
  });
});

async function loadView(view) {
  try {
    if (view === "dashboard") return loadDashboard();
    if (view === "routes") return loadRoutes();
    if (view === "prices") return loadPrices();
    if (view === "jobs") return loadJobs();
    if (view === "verification") return loadVerification();
    if (view === "exports") return loadExports();
  } catch (err) {
    console.error(err);
  }
}

// ── Health ──────────────────────────────────────────────────────────────────
async function loadHealth() {
  try {
    const h = await api("/api/health");
    const badge = $("#health-badge");
    if (h.status === "ok") {
      badge.textContent = h.authenticatedSession ? "● Authenticated" : "● No session";
      badge.className = "health-badge " + (h.authenticatedSession ? "ok" : "warn");
    } else {
      badge.textContent = "● Offline";
      badge.className = "health-badge warn";
    }
  } catch {
    $("#health-badge").textContent = "● Offline";
    $("#health-badge").className = "health-badge warn";
  }
}

// ── Dashboard ───────────────────────────────────────────────────────────────
async function loadDashboard() {
  const d = await api("/api/dashboard");
  const m = d.metrics;
  $("#metrics-grid").innerHTML = [
    metricCard("Requests Completed", m.requestsCompleted),
    metricCard("Fares Extracted", m.faresExtracted, "green"),
    metricCard("Cache Hits", m.cacheHits),
    metricCard("Retries", m.retries, m.retries > 0 ? "amber" : ""),
    metricCard("Failed Routes", m.failedRoutes, m.failedRoutes > 0 ? "red" : ""),
    metricCard("CAPTCHA Detections", m.captchaDetections, m.captchaDetections > 0 ? "red" : ""),
    metricCard("Pipeline Rows", d.pipeline.totalRows),
    metricCard("Rows With Fare", d.pipeline.rowsWithFare, "green"),
    metricCard("Verified Match", d.verification.matched, "green"),
    metricCard("Verified Mismatch", d.verification.mismatched, d.verification.mismatched > 0 ? "amber" : ""),
  ].join("");
  const s = d.session;
  const sCls = s.health === "healthy" ? "green" : s.health === "challenged" || s.health === "expired" ? "red" : "";
  $("#session-card").innerHTML = metricCard("Session Health", s.health, sCls) + metricCard("Batch Running", s.running ? "Yes" : "No", s.running ? "amber" : "");
  // Log
  try {
    const log = await api("/api/monitor/log");
    $("#monitor-log").textContent = log.slice(-4000) || "(no monitor log yet)";
  } catch {
    $("#monitor-log").textContent = "(no monitor log yet)";
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────
async function loadRoutes() {
  const data = await api("/api/routes");
  const tb = $("#routes-tbody");
  if (!data.routes.length) { tb.innerHTML = `<tr><td colspan="7" class="muted">No routes yet.</td></tr>`; return; }
  tb.innerHTML = data.routes.map((r) => {
    const id = r.id || r.routeId || r.routeKey || "—";
    const coords = r.pickup ? `${r.pickup.lat},${r.pickup.lng} → ${r.destination.lat},${r.destination.lng}` : (r.routeKey || "—");
    return `<tr>
      <td>${id}</td>
      <td>${r.pickupName ?? "—"}</td>
      <td>${r.destinationName ?? "—"}</td>
      <td>${coords}</td>
      <td>${r.source}</td>
      <td>${r.collected ? tag("done") : tag("pending")}</td>
      <td>${r.status ? tag(r.status) : (r.collected ? tag("done") : "—")}</td>
    </tr>`;
  }).join("");
}

// ── Prices ──────────────────────────────────────────────────────────────────
async function loadPrices() {
  const data = await api("/api/prices");
  const r = data.route;
  if (r) {
    $("#route-info").innerHTML = `<strong>${r.pickupName ?? "—"} → ${r.destinationName ?? "—"}</strong> · Task: ${r.taskId ?? "—"}` +
      (data.navigation ? ` · Distance: ${Math.round((data.navigation.distanceMeters ?? 0) / 1000 * 100) / 100} km` : "");
  } else {
    $("#route-info").innerHTML = `<span class="muted">No pipeline output yet.</span>`;
  }
  const tb = $("#prices-tbody");
  const rows = [...(data.pipelinePrices ?? []), ...(data.cachePrices ?? [])];
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="7" class="muted">No prices extracted yet.</td></tr>`; return; }
  tb.innerHTML = rows.map((p) => `<tr>
    <td>${p.displayName ?? "—"}</td>
    <td>${p.fare ?? "—"}</td>
    <td>${p.currencyCode ?? "—"}</td>
    <td>${p.surge ?? "—"}</td>
    <td>${p.eta ?? "—"}</td>
    <td>${p.tripTime ?? "—"}</td>
    <td>${p.source}</td>
  </tr>`).join("");
}

// ── Jobs ────────────────────────────────────────────────────────────────────
async function loadJobs() {
  const data = await api("/api/jobs");
  $("#run-status").textContent = data.running ? `Batch running (PID ${data.runningJob?.pid})…` : "";
  $("#run-batch-btn").disabled = data.running;
  if (data.metrics) {
    $("#jobs-metrics").innerHTML = [
      metricCard("Requests Completed", data.metrics.requestsCompleted),
      metricCard("Fares Extracted", data.metrics.faresExtracted, "green"),
      metricCard("Retries", data.metrics.retries, data.metrics.retries > 0 ? "amber" : ""),
      metricCard("Cache Hits", data.metrics.cacheHits),
      metricCard("Failed Routes", data.metrics.failedRoutes, data.metrics.failedRoutes > 0 ? "red" : ""),
      metricCard("CAPTCHA Detections", data.metrics.captchaDetections, data.metrics.captchaDetections > 0 ? "red" : ""),
    ].join("");
  } else {
    $("#jobs-metrics").innerHTML = "";
  }
  const tb = $("#jobs-tbody");
  if (!data.jobs.length) { tb.innerHTML = `<tr><td colspan="7" class="muted">No jobs yet. Run a batch to start.</td></tr>`; return; }
  tb.innerHTML = data.jobs.map((j) => `<tr>
    <td>${j.routeId}</td>
    <td>${j.pickupName}</td>
    <td>${j.destinationName}</td>
    <td>${tag(j.status)}</td>
    <td>${j.attempts}</td>
    <td>${fmtTime(j.completedAt)}</td>
    <td>${j.lastError ?? "—"}</td>
  </tr>`).join("");
}

$("#run-batch-btn")?.addEventListener("click", async () => {
  try {
    $("#run-status").textContent = "Starting batch…";
    $("#run-batch-btn").disabled = true;
    const res = await api("/api/jobs/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    $("#run-status").textContent = res.message ?? "Batch started.";
    setTimeout(loadJobs, 2000);
  } catch (err) {
    $("#run-status").textContent = "Error: " + err.message;
    $("#run-batch-btn").disabled = false;
  }
});

// ── Verification ────────────────────────────────────────────────────────────
async function loadVerification() {
  const data = await api("/api/verification");
  const s = data.summary;
  if (s) {
    $("#verification-summary").innerHTML = [
      metricCard("Matched", s.matched, "green"),
      metricCard("Mismatched", s.mismatched, s.mismatched > 0 ? "amber" : ""),
      metricCard("No Reference", s.noReference),
      metricCard("Not Extracted", s.notExtracted, s.notExtracted > 0 ? "red" : ""),
    ].join("");
  }
  const tb = $("#verification-tbody");
  if (!data.verifications.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">No verification data. Run an extraction first.</td></tr>`; return; }
  tb.innerHTML = data.verifications.map((v) => `<tr>
    <td>${v.displayName}</td>
    <td>${v.expected ?? "—"}</td>
    <td>${v.extracted ?? "—"}</td>
    <td>${v.delta !== null ? v.delta.toFixed(2) + "%" : "—"}</td>
    <td>${tag(v.status)}</td>
  </tr>`).join("");
}

// ── Exports ─────────────────────────────────────────────────────────────────
async function loadExports() {
  const data = await api("/api/exports");
  const tb = $("#exports-tbody");
  if (!data.exports.length) { tb.innerHTML = `<tr><td colspan="5" class="muted">No exports available.</td></tr>`; return; }
  tb.innerHTML = data.exports.map((e) => `<tr>
    <td>${e.name}</td>
    <td>${e.file}</td>
    <td>${fmtSize(e.size)}</td>
    <td>${fmtTime(e.modified)}</td>
    <td><a class="dl-btn" href="/api/exports/download?file=${encodeURIComponent(e.file)}">Download</a></td>
  </tr>`).join("");
}

// ── Init ────────────────────────────────────────────────────────────────────
loadHealth();
loadDashboard();
setInterval(loadHealth, 15000);
