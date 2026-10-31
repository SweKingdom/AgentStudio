import "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { unzipSync, strFromU8 } from "fflate";
import { FIXTURE_PDF } from "./setup.ts";
import { createApp } from "../src/app.ts";

let server: Server;
let base = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`${base}/api${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const project = () => api("GET", "/projects/NFS");
const items = () => api<any[]>("GET", "/projects/NFS/items");
const idle = async () => {
  const p = await project();
  return !p.running && p.jobs.length === 0;
};

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("PUT", "/settings", { mode: "simulation", simulationSpeed: 0 });
});

after(() => server.close());

test("a project needs a git repository URL without credentials", async () => {
  const agents = await api<any[]>("GET", "/agents");
  const base = { name: "No repo", agentIds: agents.map((a) => a.id), description: "Agents must log calls. Managers need a report. Leads must be routed." };
  await assert.rejects(api("POST", "/projects", { ...base, key: "NOREPO", settings: {} }), /repository URL is required/);
  await assert.rejects(api("POST", "/projects", { ...base, key: "TOKREPO", settings: { repo: { url: "https://user:ghp_secret@github.com/org/repo.git" } } }), /never stores credentials/);
  await assert.rejects(api("POST", "/projects", { ...base, key: "BADREPO", settings: { repo: { url: "not-a-url" } } }), /https:\/\/ or git@/);
});

test("estimate from an uploaded PDF", async () => {
  const fd = new FormData();
  fd.append("pdf", new Blob([fs.readFileSync(FIXTURE_PDF)], { type: "application/pdf" }), "field-service-requirements.pdf");
  const agents = await api<any[]>("GET", "/agents");
  fd.append("agentIds", JSON.stringify(agents.map((a) => a.id)));
  const est = await api("POST", "/projects/estimate", fd);
  assert.ok(est.uploadId);
  assert.equal(est.pdfPages, 2);
  assert.ok(est.estimate.totalUsd > 0);
  assert.equal(est.estimate.agents.length, 7);
  // The estimate comes from what the document asks for, not from its page count.
  assert.equal(est.estimate.basis, "document");
  assert.equal(est.estimate.stories, 19, "stories found in the requirements");
  assert.ok(est.estimate.detected.byCategory.integration >= 1 && est.estimate.detected.byCategory.data_migration >= 1);
  assert.equal(est.estimate.storyPoints, est.estimate.detected.stories.reduce((n: number, x: any) => n + x.points, 0));
  const none = await api("POST", "/projects/estimate", { agentIds: agents.map((a) => a.id) });
  assert.equal(none.estimate, null, "no requirements → no invented estimate");
  const typed = await api("POST", "/projects/estimate", { agentIds: agents.map((a) => a.id), description: "Agents must log calls against the account. Managers need a weekly report of calls per region. Leads must be routed to the right queue by country." });
  assert.ok(typed.estimate.stories >= 1);

  await api("POST", "/projects", {
    name: "Nordic Field Service",
    key: "NFS",
    agentIds: agents.map((a) => a.id),
    uploadId: est.uploadId,
    pdfName: "field-service-requirements.pdf",
    pdfPages: est.pdfPages,
    estimate: est.estimate,
    settings: { gates: false, parallelism: 3, budgetUsd: 0, maxRework: 2, repo: { url: "https://github.com/sirocco-demo/nordic-field-service.git", branch: "main" } },
    start: true,
  });
});

test("the full pipeline runs on the document's own requirements", async () => {
  // Stories held by open questions aren't delivered, so the project stops at the undelivered-items gate.
  await waitFor(async () => (await project()).stage === "open_items" && !(await project()).running, "the undelivered-items gate");
  const atGate = await project();
  assert.equal(atGate.status, "awaiting_approval");
  const questionsNow = await api<any[]>("GET", "/projects/NFS/questions");
  const heldIds = new Set(questionsNow.filter((q) => q.item_id && !q.answer).map((q) => q.item_id));
  assert.ok(heldIds.size >= 2, "the analyst raised questions on some stories");
  assert.deepEqual(new Set(atGate.undelivered.map((i: any) => i.id)), heldIds, "exactly the held stories are left");
  assert.ok(atGate.undelivered.every((i: any) => /open question/.test(i.reason)));
  await api("POST", "/projects/NFS/finish");
  const p = await project();
  assert.equal(p.status, "completed");
  assert.equal(p.counts.epics, 6);
  assert.equal(p.counts.stories, 19);
  assert.equal(p.counts.done, 19 - heldIds.size, "every story without open questions is deployed");
  assert.ok(p.costUsd > 0);

  const all = await items();
  assert.ok(all.some((i) => i.title === "Select a reason when a job cannot be completed"));
  const reworked = all.filter((i) => i.rework_count > 0);
  assert.equal(reworked.length, 1, "exactly one story went back from QA to development");
  assert.equal(reworked[0].category, "integration");
  for (const i of all.filter((x) => heldIds.has(x.id))) {
    assert.equal(i.state, "Requires additional information", `${i.code} is held by its open questions`);
    assert.ok(!i.phases.some((x: any) => ["architecture", "planning", "development"].includes(x.phase)), `${i.code} didn't advance`);
  }
  for (const i of all.filter((x) => (x.type === "story" || x.type === "task") && !heldIds.has(x.id))) {
    assert.ok(i.story_points && i.sprint && i.rank, `${i.code} planned`);
    for (const ph of ["analysis", "development", "qa", "documentation", "release"]) {
      assert.ok(i.phases.some((x: any) => x.phase === ph && x.ended_at), `${i.code} has a finished ${ph} phase`);
    }
  }

  const questions = await api<any[]>("GET", "/projects/NFS/questions");
  assert.ok(questions.length >= 2);
  const releases = await api<any[]>("GET", "/projects/NFS/releases");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].version, "1.0.0");
  assert.equal(JSON.parse(releases[0].validation).ok, true, "static validation passes");

  const docs = await api<any[]>("GET", "/projects/NFS/documents");
  for (const k of ["project_brief", "solution_design", "delivery_plan", "user_manual", "technical_overview", "changelog", "release_notes"]) {
    assert.ok(docs.some((d) => d.kind === k), `has ${k}`);
  }
  assert.equal(docs.filter((d) => d.kind === "task_doc").length, 19 - heldIds.size);

  // QA evidence: one test report per story, screenshots served as images, rework message points the developer to it.
  assert.equal(docs.filter((d) => d.kind === "test_report").length, 19 - heldIds.size);
  const reworkedDetail = await api("GET", `/items/${reworked[0].id}`);
  const report = await api("GET", `/documents/${reworkedDetail.documents.find((d: any) => d.kind === "test_report").id}`);
  assert.equal(report.version, 2, "report rewritten on the second iteration");
  assert.match(report.content, /✅ Approved/);
  const shot = report.content.match(/\]\((evidence\/[^)]+\.svg)\)/)[1];
  const img = await fetch(`${base}/api/projects/NFS/raw?path=${encodeURIComponent(`docs/stories/${reworked[0].code}/${shot}`)}`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(img.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  assert.doesNotMatch(await img.text(), /<script/i);
  assert.equal((await fetch(`${base}/api/projects/NFS/raw?path=${encodeURIComponent("../../../.env")}`)).status, 404);
  assert.ok(reworkedDetail.messages.some((m: any) => m.kind === "rework" && /Test report v1/.test(m.content)));
  assert.ok(reworkedDetail.files.some((f: any) => /evidence\/.+-i1\.svg$/.test(f.path)), "iteration-1 evidence kept");

  const graph = await api("GET", "/projects/NFS/graph");
  assert.ok(graph.edges.some((e: any) => e.from === "agt_qa" && e.to === "agt_developer" && e.kinds.includes("rework")));
  assert.ok(graph.edges.some((e: any) => e.from === "agt_developer" && e.to === "agt_architect"), "developer consulted the architect");
});

test("the workspace is a git repo: one commit per agent run, a tag per release", async () => {
  const log = await api("GET", "/projects/NFS/git");
  assert.equal(log.branch, "main");
  assert.equal(log.repo.url, "https://github.com/sirocco-demo/nordic-field-service.git");
  const authors = new Set(log.commits.map((c: any) => c.author.split(" (")[0]));
  for (const a of ["Meiga", "Basajaun", "Trasgu", "Cuélebre", "Xana", "Nuberu"]) assert.ok(authors.has(a), `commits by ${a}`);
  // Accented names still give clean commit emails.
  assert.ok(log.commits.some((c: any) => c.email === "cuelebre@agentstudio.local"), "Cuélebre commits as cuelebre@agentstudio.local");
  assert.ok(log.commits.some((c: any) => c.tags.includes("v1.0.0")), "release tagged");
  assert.ok(log.commits.some((c: any) => /^US-\d+: development — /.test(c.subject)));
  // One branch per task, merged into the base branch once the task is documented.
  const branches = log.branches as any[];
  const done = (await items()).filter((i: any) => i.state === "Deployed (Done)" && (i.type === "story" || i.type === "task"));
  for (const i of done) {
    assert.match(i.branch ?? "", new RegExp(`^feature/${i.code}-`), `${i.code} has its own branch`);
    const b = branches.find((x) => x.name === i.branch);
    assert.ok(b?.merged, `${i.branch} is merged into main`);
    assert.ok(!b.active, `${i.branch} has no worktree left`);
  }
  assert.ok(log.commits.some((c: any) => /^Merge feature\/US-\d+/.test(c.subject)), "merge commits on main");
  assert.ok(log.commits.some((c: any) => c.branches.some((b: string) => b.startsWith("feature/"))), "commits carry their branch");
  const files = await api<any[]>("GET", "/projects/NFS/files");
  assert.ok(!files.some((f) => f.path.startsWith(".git/")), ".git is not listed as a workspace file");
  // Editing the repository on an existing project updates origin.
  const edited = await api("PATCH", "/projects/NFS", { settings: { repo: { url: "git@github.com:sirocco-demo/nfs.git", branch: "main" } } });
  assert.equal(edited.repoInfo.webUrl, "https://github.com/sirocco-demo/nfs");
  await assert.rejects(api("PATCH", "/projects/NFS", { settings: { repo: { url: "https://x:y@github.com/a/b" } } }), /never stores credentials/);
});

test("spend timeline is continuous: every bucket from the first call, sums match the total", async () => {
  const c = await api("GET", "/costs?projectId=NFS");
  assert.ok(c.timelineStep > 0);
  assert.ok(c.timelineBuckets.length >= 1 && c.timelineBuckets.length <= 49, `${c.timelineBuckets.length} buckets`);
  for (let i = 1; i < c.timelineBuckets.length; i++) {
    assert.equal(new Date(c.timelineBuckets[i]).getTime() - new Date(c.timelineBuckets[i - 1]).getTime(), c.timelineStep * 1000, "no gaps between buckets");
  }
  assert.ok(c.timeline.every((x: any) => c.timelineBuckets.includes(x.bucket)), "every value sits in a listed bucket");
  const sum = c.timeline.reduce((n: number, x: any) => n + x.costUsd, 0);
  assert.ok(Math.abs(sum - c.totals.costUsd) < 1e-6, "timeline adds up to the total");
});

test("human control: comment, reorder, split", async () => {
  const all = await items();
  const story = all.find((i) => i.title === "Create a work order from a case in one click")!;
  await api("POST", `/items/${story.id}/comments`, { content: "Copy the preferred technician too." });
  const detail = await api("GET", `/items/${story.id}`);
  assert.equal(detail.comments.at(-1).content, "Copy the preferred technician too.");

  const deliverables = all.filter((i) => i.type === "story" || i.type === "task").sort((a, b) => a.rank - b.rank);
  const last = deliverables.at(-1)!;
  await api("POST", "/projects/NFS/items/reorder", { ids: [last.id] });
  assert.equal((await api("GET", `/items/${last.id}`)).rank, 1);

  const multi = all.find((i) => (i.acceptance_criteria.match(/### AC/g) ?? []).length >= 3)!;
  const split = await api("POST", `/items/${multi.id}/split`, { title: "Split part", acIndexes: [1] });
  const original = await api("GET", `/items/${multi.id}`);
  assert.match(split.acceptance_criteria, /^### AC 1:/);
  assert.equal((original.acceptance_criteria.match(/### AC/g) ?? []).length, (multi.acceptance_criteria.match(/### AC/g) ?? []).length - 1);
});

test("states follow the pipeline: no skipping; start work calls the agents in order", async () => {
  const created = await api("POST", "/projects/NFS/items", { type: "story", title: "Show the technician's next job on the home page", category: "development", acceptance_criteria: "### AC 1: Next job shown\nThe home page shows the technician's next appointment." });
  assert.equal(created.state, "Ready for Refinement");

  // A person can't jump a card ahead of the agents.
  await assert.rejects(api("PATCH", `/items/${created.id}`, { state: "In Progress" }), /follow the pipeline/);
  await assert.rejects(api("PATCH", `/items/${created.id}`, { state: "Deployed (Done)" }), /follow the pipeline/);
  // …but can put it on hold, cancel and reopen it.
  await api("PATCH", `/items/${created.id}`, { state: "Cancelled" });
  const blockedPlan = await api("GET", `/items/${created.id}/start-plan`);
  assert.match(blockedPlan.blockedBy.join(" "), /cancelled/);
  await api("PATCH", `/items/${created.id}`, { state: "New" });

  const plan = await api("GET", `/items/${created.id}/start-plan`);
  assert.deepEqual(plan.steps.map((x: any) => x.role), ["architect", "planner", "developer", "qa", "writer"]);
  assert.deepEqual(plan.blockedBy, []);

  await api("POST", `/items/${created.id}/start`);
  await waitFor(idle, "start work to finish");
  const done = await api("GET", `/items/${created.id}`);
  assert.equal(done.state, "Release Ready");
  assert.ok(done.story_points && done.sprint && done.rank, "planned by the planner");
  const order = ["architecture", "planning", "development", "qa", "documentation"];
  const firstOf = (ph: string) => done.phases.findIndex((x: any) => x.phase === ph);
  for (let i = 1; i < order.length; i++) assert.ok(firstOf(order[i - 1]) < firstOf(order[i]), `${order[i - 1]} before ${order[i]}`);
  const handoffs = done.messages.filter((m: any) => m.kind === "handoff").map((m: any) => `${m.from_agent_id}>${m.to_agent_id}`);
  for (const h of ["orchestrator>agt_architect", "agt_architect>agt_planner", "agt_planner>agt_developer", "agt_developer>agt_qa", "agt_qa>agt_writer"]) assert.ok(handoffs.includes(h), `handoff ${h}`);
});

test("an item with open questions can't advance until they're answered", async () => {
  const open = (await api<any[]>("GET", "/projects/NFS/questions")).filter((x) => x.item_id && !x.answer);
  const q = open[0];
  // Start work, developer re-runs and moving it by hand are all refused while the question is open.
  assert.match((await api("GET", `/items/${q.item_id}/start-plan`)).blockedBy.join(" "), /unanswered question/);
  await assert.rejects(api("POST", `/items/${q.item_id}/start`), /unanswered question/);
  await assert.rejects(api("POST", `/items/${q.item_id}/rerun`, { role: "developer", feedback: "go" }), /unanswered question/);
  // The analyst may still revise it.
  await api("POST", `/items/${q.item_id}/rerun`, { role: "requirements", feedback: "Clarify the scope." });
  await waitFor(idle, "analyst revision");
  assert.equal((await api("GET", `/items/${q.item_id}`)).state, "Requires additional information");
  // Answer every question on the item → it goes back to refinement and can be started.
  for (const x of open.filter((y) => y.item_id === q.item_id)) await api("POST", `/questions/${x.id}/answer`, { answer: "Exclude Closed and Prospect accounts." });
  assert.equal((await api("GET", `/items/${q.item_id}`)).state, "Ready for Refinement");
  await api("POST", `/items/${q.item_id}/start`);
  await waitFor(idle, "start work after answering");
  assert.equal((await api("GET", `/items/${q.item_id}`)).state, "Release Ready");
});

test("re-run one story with feedback goes back through build, test and docs", async () => {
  const story = (await items()).find((i) => i.title === "Create a work order from a case in one click")!;
  await api("POST", `/items/${story.id}/rerun`, { role: "developer", feedback: "Also copy the preferred technician." });
  await waitFor(idle, "re-run to finish");
  const after = await api("GET", `/items/${story.id}`);
  assert.equal(after.state, "Release Ready");
  assert.ok(after.phases.filter((p: any) => p.phase === "development").length >= 2);
  assert.ok(after.tests.some((t: any) => /feedback applied/i.test(t.ac_ref)));
  assert.ok(after.messages.some((m: any) => m.from_agent_id === "human" && m.kind === "rework"));
});

test("bug after release → fix → patch release", async () => {
  const story = (await items()).find((i) => i.category === "integration" && i.state === "Deployed (Done)")!;
  const bug = await api("POST", `/items/${story.id}/bugs`, {
    title: "Stock check times out for large orders",
    steps: "1. Reserve 30 parts\n2. Wait",
    expected: "Answer within 10 seconds",
    actual: "Spinner for two minutes",
    severity: "2 - High",
    fixNow: true,
    release: true,
  });
  assert.equal(bug.type, "bug");
  assert.equal(bug.parent_id, story.id);
  await waitFor(idle, "bug fix + patch release");
  const fixed = await api("GET", `/items/${bug.id}`);
  assert.equal(fixed.state, "Deployed (Done)");
  assert.ok(fixed.files.some((f: any) => /^test\/regressions\/bg-\d+\.test\.ts$/.test(f.path)));
  const releases = await api<any[]>("GET", "/projects/NFS/releases");
  assert.equal(releases[0].version, "1.1.0", "re-run story + bug → minor release");
});

test("chat with an agent answers from its real state", async () => {
  const story = (await items()).find((i) => i.rework_count > 0)!;
  const history = await api<any[]>("POST", "/agents/agt_qa/chat", { message: `What happened with ${story.code}?`, projectId: "NFS" });
  const reply = history.at(-1);
  assert.equal(reply.sender, "agent");
  assert.match(reply.content, new RegExp(story.code));
  assert.match(reply.content, /❌/);
  const k = await api<any[]>("POST", "/agents/agt_developer/chat", { message: "What do you know?" });
  assert.match(k.at(-1).content, /Engineering standards/);
});

test("exports: ZIP, backlog CSV and Azure DevOps CSV", async () => {
  const res = await fetch(`${base}/api/projects/NFS/export/workspace.zip`);
  assert.equal(res.status, 200);
  const files = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
  assert.ok(!files.some((f) => f.startsWith("NFS/.git/")), "no .git in the export");
  assert.ok(files.includes("NFS/backlog.csv"));
  assert.ok(files.some((f) => f.startsWith("NFS/src/")));
  assert.ok(!files.some((f) => f.includes("force-app")), "no Salesforce source");
  assert.ok(files.some((f) => /^NFS\/docs\/stories\/US-\d+\/task_doc\.md$/.test(f)));

  const raw = new Uint8Array(await (await fetch(`${base}/api/projects/NFS/export/backlog.csv`)).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM so Excel reads accents");
  const csv = await api<string>("GET", "/projects/NFS/export/backlog.csv");
  assert.match(csv.replace(/^\uFEFF/, ""), /^Code,Type,Parent,Title/);
  const ado = await api<string>("GET", "/projects/NFS/export/azure-devops.csv");
  const lines = ado.split("\r\n");
  assert.match(lines[0], /Work Item Type,Title 1,Title 2,Title 3/);
  assert.match(lines[1], /^,Epic,Work Order Management,/);
  assert.match(lines[2], /^,Feature,,Work order intake,/);
  assert.match(lines[3], /^,User Story,,,/);

  const zipDoc = strFromU8(unzipSync(new Uint8Array(await (await fetch(`${base}/api/projects/NFS/export/workspace.zip`)).arrayBuffer()))["NFS/README.md"]);
  assert.match(zipDoc, /simulation mode/);
});
