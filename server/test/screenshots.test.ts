// Real org screenshots (QA evidence in live mode), with stand-ins only: the fake Salesforce CLI hands out a "login URL"
// that points at a local page served by this test, and the locally installed Chrome (if any) takes the screenshot.
import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { TMP } from "./setup.ts";

process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
process.env.ARM_SF_BIN = path.resolve(import.meta.dirname, "fixtures/fake-sf.mjs");
process.env.ARM_FAKE_SF_LOG = path.join(TMP, "sf-calls.jsonl");

const { all, insert, now, uid } = await import("../src/db.ts");
const { createItem, getProject, readWorkspaceBinary, rootFor } = await import("../src/store.ts");
const { saveAppSettings } = await import("../src/settings.ts");
const { addManualOrg } = await import("../src/salesforce.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { executeTool } = await import("../src/agents/tools.ts");
const { chromeAvailable, orgPath, redact } = await import("../src/screenshots.ts");

// Looks like the session part of a real one-time login URL; must never leave the screenshot module.
const SECRET = "SESSION-otp-7f3c9a1b";
let server: http.Server;
let base = "";
const HAS_CHROME = await chromeAvailable();

before(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><body style="font-family:sans-serif"><h1>Case 00001042</h1><p>Status: Ready for dispatch</p></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ARM_FAKE_SF_OPEN_URL = `${base}/secur/frontdoor.jsp?otp=${SECRET}`;
  saveAppSettings({ mode: "live" });
  addManualOrg({ alias: "QA-SANDBOX", type: "sandbox" });
});

after(() => {
  server?.close();
  saveAppSettings({ mode: "simulation" });
});

function makeProject(key: string, mode: "live" | "simulation") {
  const id = uid("prj");
  fs.mkdirSync(path.join(TMP, "data", "projects", key, "workspace"), { recursive: true });
  insert("projects", {
    id, key, name: key, description: "", status: "running", stages: [], agent_ids: [], estimate: null, mode, created_at: now(), updated_at: now(),
    settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, targetOrg: "QA-SANDBOX" },
  });
  const project = getProject(id)!;
  const item = createItem(id, { type: "story", title: "Dispatch a case", category: "development" });
  const agent = { ...defaultAgentFor("qa"), id: "agt_qa_test" };
  const ctx = { project, agent, runId: uid("run"), item, iteration: 1, outcome: {} };
  return { project, item, ctx };
}

const leaked = (projectId: string) =>
  all<{ summary: string; detail: string | null }>("SELECT summary, detail FROM activity WHERE project_id = ?", projectId).some((r) => `${r.summary} ${r.detail ?? ""}`.includes(SECRET));

test("only pages inside the org are allowed", () => {
  assert.equal(orgPath("/lightning/r/Case/500000000000001/view"), "/lightning/r/Case/500000000000001/view");
  assert.equal(orgPath("/home/home.jsp"), "/home/home.jsp");
  for (const bad of ["https://evil.example.com/x", "//evil.example.com/x", "lightning/r/Case", "/\\evil.example.com", "javascript:alert(1)", "/lightning/x?u=https://evil.example.com", ""]) {
    assert.throws(() => orgPath(bad), /Only pages inside the org/, bad);
  }
});

test("redaction removes login URLs and session parameters", () => {
  const url = `https://acme.my.salesforce.com/secur/frontdoor.jsp?otp=${SECRET}&retURL=%2F`;
  assert.ok(!redact(`page.goto: net::ERR navigating to "${url}"`, url).includes(SECRET));
  assert.ok(!redact(`navigating to "${url}"`).includes(SECRET), "even without the exact URL");
  assert.ok(!redact(`failed: sid=${SECRET}`).includes(SECRET));
});

test("simulation falls back to capture_evidence without contacting Salesforce", async () => {
  const { ctx } = makeProject("SSIM", "simulation");
  const r = await executeTool("capture_screenshot", { ac_ref: "AC 1", caption: "Case is ready", path: "/lightning/o/Case/list" }, ctx as any);
  assert.equal(r.ok, true);
  assert.match(r.content, /^Simulation — use capture_evidence/);
});

test("external URLs are refused before any org call", async () => {
  const { ctx, project } = makeProject("SEXT", "live");
  const log = process.env.ARM_FAKE_SF_LOG!;
  const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  for (const p of ["https://evil.example.com/steal", "//evil.example.com/steal"]) {
    const r = await executeTool("capture_screenshot", { ac_ref: "AC 1", caption: "x", path: p }, ctx as any);
    assert.equal(r.ok, false);
    assert.match(r.content, /Only pages inside the org/);
  }
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", before, "no sf call was made");
  assert.equal(leaked(project.id), false);
});

test("live: a real PNG screenshot is saved in the task's evidence folder", { skip: HAS_CHROME ? false : "Google Chrome is not installed on this computer" }, async () => {
  const { ctx, item, project } = makeProject("SLIVE", "live");
  const input = { ac_ref: "AC 1 — case ready", caption: "Case shows Ready for dispatch", path: "/lightning/r/Case/500000000000001/view", wait_for_text: "Ready for dispatch" };
  const r = await executeTool("capture_screenshot", input, ctx as any);
  assert.equal(r.ok, true, r.content);
  assert.ok(!r.content.includes(SECRET), "the session URL is not in the tool output");
  const out = JSON.parse(r.content);
  assert.equal(out.image, "evidence/ac-1-case-ready-1.png");
  assert.equal(out.markdown, "![AC 1 — case ready — Case shows Ready for dispatch](evidence/ac-1-case-ready-1.png)");
  assert.equal(out.warning, undefined, "the awaited text appeared");
  const rel = `docs/stories/${item.code}/${out.image}`;
  const png = readWorkspaceBinary(project, rel, item.code)!;
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.ok(fs.existsSync(path.join(rootFor(project, item.code), rel)));
  const row = all<{ bytes: number; item_id: string }>("SELECT bytes, item_id FROM files WHERE project_id = ? AND path = ?", project.id, rel)[0];
  assert.equal(row.bytes, png.length);
  assert.equal(row.item_id, item.id);
  assert.equal(all("SELECT 1 FROM file_versions WHERE project_id = ? AND path = ?", project.id, rel).length, 0, "no text versions for binaries");

  // A second screenshot for the same check gets the next number.
  const again = JSON.parse((await executeTool("capture_screenshot", input, ctx as any)).content);
  assert.equal(again.image, "evidence/ac-1-case-ready-2.png");
  assert.equal(leaked(project.id), false, "the session URL is not in the activity log");
});

test("live: a failing page load reports an error without the session URL", { skip: HAS_CHROME ? false : "Google Chrome is not installed on this computer" }, async () => {
  const { ctx, project } = makeProject("SFAIL", "live");
  const prev = process.env.ARM_FAKE_SF_OPEN_URL;
  // Nothing listens on port 9 (discard): navigation fails and Playwright's error names the URL it tried.
  process.env.ARM_FAKE_SF_OPEN_URL = `http://127.0.0.1:9/secur/frontdoor.jsp?otp=${SECRET}`;
  try {
    const r = await executeTool("capture_screenshot", { ac_ref: "AC 2", caption: "x", path: "/lightning/o/Case/list" }, ctx as any);
    assert.equal(r.ok, false);
    assert.match(r.content, /^Screenshot failed/);
    assert.ok(!r.content.includes(SECRET), r.content);
  } finally {
    process.env.ARM_FAKE_SF_OPEN_URL = prev;
  }
  assert.equal(leaked(project.id), false);
});
