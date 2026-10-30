import fs from "node:fs";
import { all, insert, now, run } from "./db.js";
import { emit } from "./events.js";
import { agentEmail, listAgents, type Agent } from "./agents/store.js";
import { AbortedError, BudgetExceededError, LimitReachedError, PauseRequestedError, projectCost, runAgent } from "./agents/runner.js";
import type { LimitKind } from "./errors.js";
import { autoResumeAllowed, globalPause, pauseLabel, setGlobalPause, spendStatus, type JobSpec } from "./pause.js";
import { ROLES } from "./agents/roles.js";
import { appSettings, effectiveMode } from "./settings.js";
import { failedChecks } from "./agents/context.js";
import { fill, teamSettings } from "./team.js";
import { ensureItemBranch, finishMerge, mergeItemBranch, pushRefs } from "./git.js";
import { commentQaFindings, integrateViaPr, openDraftPr, prRepoFor } from "./pullrequests.js";
import { needsCodeReview, runCodeReview } from "./review.js";
import {
  createItem,
  endPhase,
  findDoc,
  getItem,
  getProject,
  listItems,
  logActivity,
  openQuestionCount,
  patchItem,
  patchProject,
  postMessage,
  startPhase,
  type Project,
  type StageState,
  type WorkItem,
} from "./store.js";

const controllers = new Map<string, AbortController>();

const DONE_STATES = ["Ready for UAT", "Release Ready", "Smoke Testing", "Deployed (Done)", "Cancelled", "Removed"];
const DELIVERED_STATES = ["Release Ready", "Smoke Testing", "Deployed (Done)", "Cancelled", "Removed"];

export function isRunning(projectId: string) {
  return controllers.has(projectId) || [...jobs.values()].some((j) => j.projectId === projectId);
}

export function pipelineRunning(projectId: string) {
  return controllers.has(projectId);
}

export function teamOf(project: Project): Agent[] {
  const agents = listAgents();
  return project.agent_ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => Boolean(a && a.enabled));
}

function agentsFor(project: Project, role: string) {
  return teamOf(project).filter((a) => a.role === role);
}

export function buildStages(project: Pick<Project, "agent_ids" | "settings">): StageState[] {
  const roles = new Set(listAgents().filter((a) => project.agent_ids.includes(a.id)).map((a) => a.role));
  const gates = project.settings.gates;
  const st = (key: string, role: string, label: string, present: boolean, gate = false): StageState => ({
    key,
    role,
    label,
    gate,
    status: present ? "pending" : "skipped",
  });
  return [
    st("requirements", "requirements", "Requirements & backlog", roles.has("requirements")),
    st("review_backlog", "human", "Backlog review & open questions", gates && roles.has("requirements"), true),
    st("architecture", "architect", "Technical refinement", roles.has("architect")),
    st("planning", "planner", "Prioritisation & delivery plan", roles.has("planner")),
    st("approve_plan", "human", "Approve delivery plan", gates && roles.has("planner"), true),
    st("delivery", "developer", "Build · Test · Document", roles.has("developer")),
    st("approve_release", "human", "Approve release", gates && roles.has("release"), true),
    st("release", "release", "Check · Smoke test · Release", roles.has("release")),
  ];
}

function setStage(projectId: string, key: string, status: StageState["status"]) {
  const p = getProject(projectId)!;
  const stages = p.stages.map((s) => (s.key === key ? { ...s, status } : s));
  patchProject(projectId, { stages, stage: status === "running" || status === "awaiting_approval" ? key : p.stage });
}

/** Projects asked to pause gracefully: in-flight agent steps finish, nothing new starts. */
const pauseRequested = new Set<string>();

/** Safe point between steps: stops here if a pause was requested (for this project or globally). */
function checkpoint(projectId: string) {
  if (pauseRequested.has(projectId) || globalPause()) throw new PauseRequestedError("Paused");
}

export function startProject(projectId: string) {
  if (controllers.has(projectId)) return;
  const gp = globalPause();
  if (gp) throw new Error(`All work is paused: ${gp.reason} Resume all first.`);
  pauseRequested.delete(projectId);
  if ([...jobs.values()].some((j) => j.projectId === projectId)) throw new Error("A re-run or release job is in progress — wait for it to finish.");
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  if (p.status === "completed") throw new Error("Project already completed");
  const ctrl = new AbortController();
  controllers.set(projectId, ctrl);
  patchProject(projectId, { status: "running", error: null, started_at: p.started_at ?? now() });
  logActivity({ projectId, agentId: "orchestrator", type: "pipeline", summary: p.started_at ? "Pipeline resumed" : "Pipeline started" });
  void loop(projectId, ctrl.signal)
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof LimitReachedError) {
        // Tokens / credits / spend limit: pause everything, remember what to resume.
        pauseAll({ mode: "now", kind: e.kind, reason: e.message, resumeAt: e.resumeAt, alsoResume: [projectId] });
        patchProject(projectId, { status: "paused", error: e.message });
        logActivity({ projectId, agentId: "orchestrator", type: "gate", summary: `⏸ ${e.message}` });
      } else if (e instanceof PauseRequestedError) {
        patchProject(projectId, { status: "paused", error: null });
        logActivity({ projectId, agentId: "orchestrator", type: "pipeline", summary: "⏸ Paused after finishing the current steps — press Resume to continue" });
      } else if (e instanceof AbortedError || ctrl.signal.aborted) {
        patchProject(projectId, { status: "paused", error: null });
        logActivity({ projectId, agentId: "orchestrator", type: "pipeline", summary: "⏹ Stopped — the interrupted steps will run again on Resume" });
      } else if (e instanceof BudgetExceededError) {
        patchProject(projectId, { status: "paused", error: msg });
        logActivity({ projectId, agentId: "orchestrator", type: "pipeline", summary: `⛔ ${msg} Raise the budget to continue.` });
      } else {
        patchProject(projectId, { status: "failed", error: msg });
        logActivity({ projectId, agentId: "orchestrator", type: "pipeline", summary: `Pipeline failed: ${msg}` });
      }
      closeOpenPhases(projectId, "interrupted");
      const cur = getProject(projectId);
      if (cur) patchProject(projectId, { stages: cur.stages.map((s) => (s.status === "running" ? { ...s, status: "pending" } : s)) });
    })
    .finally(() => {
      controllers.delete(projectId);
      pauseRequested.delete(projectId);
    });
}

/** "graceful" lets running agent steps finish; "now" cancels them (they run again on resume). */
export function pauseProject(projectId: string, mode: "graceful" | "now" = "graceful") {
  if (mode === "graceful") {
    if (controllers.has(projectId) || [...jobs.values()].some((j) => j.projectId === projectId)) {
      pauseRequested.add(projectId);
      logActivity({ projectId, agentId: "human", type: "pipeline", summary: "Pause requested — agents finish their current step, then stop" });
      emit({ type: "project", projectId });
    }
    return;
  }
  controllers.get(projectId)?.abort();
  for (const j of jobs.values()) if (j.projectId === projectId) j.ctrl.abort();
}

export function isPausing(projectId: string) {
  return pauseRequested.has(projectId) || Boolean(globalPause() && isRunning(projectId));
}

// ---------------------------------------------------------------------------------------------------------------------
// Global pause / resume

export function pauseAll(o: { mode: "graceful" | "now"; reason?: string; kind?: LimitKind | "user"; resumeAt?: string | null; alsoResume?: string[] }) {
  const current = globalPause();
  const running = [...new Set([...controllers.keys(), ...(o.alsoResume ?? [])])];
  const runningJobs = [...jobs.values()].map((j) => j.spec).filter((x): x is JobSpec => Boolean(x));
  setGlobalPause({
    reason: o.reason ?? current?.reason ?? "Paused by you.",
    kind: o.kind ?? current?.kind ?? "user",
    since: current?.since ?? now(),
    resumeAt: o.resumeAt !== undefined ? o.resumeAt : current?.resumeAt ?? null,
    projects: [...new Set([...(current?.projects ?? []), ...running])],
    jobs: [...(current?.jobs ?? []), ...runningJobs.filter((j) => !(current?.jobs ?? []).some((c) => JSON.stringify(c) === JSON.stringify(j)))],
  });
  logActivity({ projectId: null, agentId: "orchestrator", type: "gate", summary: `⏸ All work paused — ${o.reason ?? "by you"}` });
  if (o.mode === "now") {
    for (const c of controllers.values()) c.abort();
    for (const j of jobs.values()) j.ctrl.abort();
  }
}

export function resumeAll(force = false) {
  const gp = globalPause();
  if (!gp) return { resumed: [] as string[] };
  if (!force && (gp.kind === "daily_limit" || gp.kind === "monthly_limit")) {
    const st = spendStatus();
    const over = (st.dailyLimitUsd > 0 && st.today >= st.dailyLimitUsd) || (st.monthlyLimitUsd > 0 && st.month >= st.monthlyLimitUsd);
    if (over) throw new Error("The spend limit is still reached — raise it in Settings (or wait until it resets), then resume.");
  }
  setGlobalPause(null);
  const resumed: string[] = [];
  for (const id of gp.projects) {
    const p = getProject(id);
    if (!p || p.status === "completed" || p.status === "awaiting_approval" || controllers.has(id)) continue;
    try {
      startProject(id);
      resumed.push(p.key);
    } catch {
      /* project changed meanwhile */
    }
  }
  for (const spec of gp.jobs) {
    try {
      if (spec.type === "start") startItem(spec.itemId);
      else if (spec.type === "rerun") rerunItem(spec.itemId, spec.role as RerunRole, spec.feedback, true);
      else if (spec.type === "fix") fixBug(spec.itemId, spec.release);
      else if (spec.type === "release") releaseNow(spec.projectId, spec.itemIds);
      resumed.push(spec.type);
    } catch {
      /* the item moved on */
    }
  }
  logActivity({ projectId: null, agentId: "human", type: "approval", summary: `▶ All work resumed${resumed.length ? ` (${resumed.join(", ")})` : ""}` });
  return { resumed };
}

/** Resumes automatically when a rate limit / overload / spend-limit period has passed. */
export function autoResumeTick() {
  const gp = globalPause();
  if (!gp || !gp.resumeAt || !autoResumeAllowed(gp) || Date.now() < new Date(gp.resumeAt).getTime()) return;
  try {
    resumeAll();
  } catch {
    // Still over a spend limit: try again later.
    setGlobalPause({ ...gp, resumeAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  }
}

export { pauseLabel };

export function approveGate(projectId: string) {
  const p = getProject(projectId)!;
  const gate = p.stages.find((s) => s.status === "awaiting_approval");
  if (!gate) throw new Error("Nothing is waiting for approval");
  setStage(projectId, gate.key, "done");
  postMessage({ projectId, from: "human", to: "orchestrator", kind: "approval", content: `Approved: ${gate.label}` });
  logActivity({ projectId, agentId: "human", type: "approval", summary: `✅ Approved: ${gate.label}` });
  startProject(projectId);
}

function closeOpenPhases(projectId: string, outcome: string) {
  run("UPDATE item_phases SET ended_at = ?, outcome = ? WHERE project_id = ? AND ended_at IS NULL", now(), outcome, projectId);
}

async function loop(projectId: string, signal: AbortSignal) {
  for (;;) {
    checkpoint(projectId);
    const p = getProject(projectId)!;
    const next = p.stages.find((s) => s.status === "pending" || s.status === "running" || s.status === "awaiting_approval");
    if (!next) break;
    if (next.status === "awaiting_approval") {
      patchProject(projectId, { status: "awaiting_approval" });
      return;
    }
    if (next.gate) {
      setStage(projectId, next.key, "awaiting_approval");
      patchProject(projectId, { status: "awaiting_approval" });
      postMessage({ projectId, from: "orchestrator", to: "human", kind: "question", content: `Waiting for your approval: ${next.label}` });
      logActivity({ projectId, agentId: "orchestrator", type: "gate", summary: `⏸ Waiting for approval: ${next.label}` });
      return;
    }
    setStage(projectId, next.key, "running");
    await runStage(getProject(projectId)!, next.key, signal);
    setStage(projectId, next.key, "done");
  }
  await finishProject(projectId);
}

async function finishProject(projectId: string) {
  patchProject(projectId, { status: "completed", stage: null, finished_at: now() });
  const items = listItems(projectId).filter((i) => i.type === "story" || i.type === "task");
  const cost = projectCost(projectId);
  logActivity({ projectId, agentId: "orchestrator", type: "pipeline", summary: `🏁 Project completed — ${items.length} items, $${cost.toFixed(2)}` });
}

// ---------------------------------------------------------------------------------------------------------------------

async function runStage(p: Project, key: string, signal: AbortSignal) {
  switch (key) {
    case "requirements":
      return stageRequirements(p, signal);
    case "architecture":
      return stageArchitecture(p, signal);
    case "planning":
      return stagePlanning(p, signal);
    case "delivery":
      return stageDelivery(p, signal);
    case "release":
      return stageRelease(p, signal);
  }
}

function addPhase(projectId: string, itemId: string, phase: string, agentId: string, startedAt: string, endedAt: string) {
  insert("item_phases", { project_id: projectId, item_id: itemId, phase, agent_id: agentId, iteration: 1, started_at: startedAt, ended_at: endedAt, outcome: "done" });
}

async function stageRequirements(p: Project, signal: AbortSignal) {
  const agent = agentsFor(p, "requirements")[0];
  const started = now();
  // A restarted requirements stage starts from a clean backlog.
  run("DELETE FROM item_phases WHERE project_id = ?", p.id);
  run("DELETE FROM work_items WHERE project_id = ?", p.id);
  postMessage({ projectId: p.id, from: "orchestrator", to: agent.id, kind: "handoff", content: `New project ${p.key}: analyse "${p.pdf_name ?? "the description"}" and build the backlog.` });
  const pdfBase64 = p.pdf_file && fs.existsSync(p.pdf_file) ? fs.readFileSync(p.pdf_file).toString("base64") : null;
  await runAgent({
    project: p,
    agent,
    stage: "requirements",
    signal,
    pdfBase64,
    task: pdfBase64
      ? "The attached PDF is the customer's requirements document. Build the project brief and the complete backlog as described in your instructions."
      : "There is no PDF — use the product owner's description above as the requirements. Build the project brief and the complete backlog as described in your instructions.",
  });
  const ended = now();
  for (const it of listItems(p.id).filter((i) => i.type === "story" || i.type === "task")) {
    if (it.state === "New") patchItem(it.id, { state: "Ready for Refinement" });
    addPhase(p.id, it.id, "analysis", agent.id, it.created_at < started ? started : it.created_at, ended);
  }
}

async function pool<T>(projectId: string, items: T[], size: number, signal: AbortSignal, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  let pausing = false;
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length && !pausing) {
      if (signal.aborted) throw new AbortedError("Stopped by user");
      try {
        checkpoint(projectId);
      } catch (e) {
        // Graceful pause: this worker stops taking work; the others finish what they're doing.
        if (e instanceof PauseRequestedError) {
          pausing = true;
          break;
        }
        throw e;
      }
      await fn(queue.shift()!);
    }
  });
  await Promise.all(workers);
  if (pausing) throw new PauseRequestedError("Paused");
}

async function stageArchitecture(p: Project, signal: AbortSignal) {
  const architects = agentsFor(p, "architect");
  const items = listItems(p.id);
  const features = items.filter((i) => i.type === "feature" && items.some((s) => s.parent_id === i.id && (s.type === "story" || s.type === "task")));
  const groups: (WorkItem | undefined)[] = features.length ? features : [undefined];
  let n = 0;
  await pool(p.id, groups, p.settings.parallelism, signal, async (feature) => {
    const agent = architects[n++ % architects.length];
    const stories = listItems(p.id).filter((s) => (s.type === "story" || s.type === "task") && (!feature || s.parent_id === feature.id) && !waitingForAnswers(s));
    if (!stories.length) return;
    const phaseIds = stories.map((s) => startPhase(p.id, s.id, "architecture", agent.id));
    await runAgent({
      project: getProject(p.id)!,
      agent,
      stage: "architecture",
      item: feature,
      signal,
      task: feature
        ? `Refine every story/task of feature ${feature.code} "${feature.title}": ${stories.map((s) => s.code).join(", ")}. Update each one's technical specification and the solution design document.`
        : `Refine every story/task in the backlog: ${stories.map((s) => s.code).join(", ")}. Update each one's technical specification and the solution design document.`,
    });
    phaseIds.forEach((id) => endPhase(id));
  });
  for (const it of listItems(p.id).filter((i) => (i.type === "story" || i.type === "task") && i.state === "Ready for Refinement" && !waitingForAnswers(i))) {
    patchItem(it.id, { state: "Ready for Sprint" });
  }
}

async function stagePlanning(p: Project, signal: AbortSignal) {
  const agent = agentsFor(p, "planner")[0];
  const stories = listItems(p.id).filter((i) => (i.type === "story" || i.type === "task") && !waitingForAnswers(i));
  const phaseIds = stories.map((s) => startPhase(p.id, s.id, "planning", agent.id));
  const architect = agentsFor(p, "architect")[0];
  if (architect) postMessage({ projectId: p.id, from: architect.id, to: agent.id, kind: "handoff", content: `${stories.length} items refined and ready for planning.` });
  await runAgent({
    project: getProject(p.id)!,
    agent,
    stage: "planning",
    signal,
    task: `Estimate, prioritise, order and plan every story and task (${stories.map((s) => s.code).join(", ")}), then write the delivery plan.`,
  });
  phaseIds.forEach((id) => endPhase(id));
  normalisePlan(p.id);
}

/** Ensure every deliverable item has a rank, sprint, points and is in 'To Do' even if the planner skipped it. */
function normalisePlan(projectId: string) {
  const s = appSettings();
  const items = listItems(projectId).filter((i) => i.type === "story" || i.type === "task");
  let maxRank = Math.max(0, ...items.map((i) => i.rank ?? 0));
  for (const it of items) {
    const patch: Partial<WorkItem> = {};
    if (it.rank == null) patch.rank = ++maxRank;
    if (it.sprint == null) patch.sprint = 1;
    if (it.story_points == null) patch.story_points = 3;
    if (!["Cancelled", "Removed", ...DONE_STATES].includes(it.state) && !waitingForAnswers(it)) patch.state = "To Do";
    patch.human_hours = (patch.story_points ?? it.story_points ?? 3) * s.hoursPerStoryPoint;
    patchItem(it.id, patch);
  }
}

async function stageDelivery(p: Project, signal: AbortSignal) {
  if (!agentsFor(p, "planner").length) normalisePlan(p.id);
  const all = () => listItems(p.id).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const waiting = all().filter((i) => !DELIVERED_STATES.includes(i.state) && waitingForAnswers(i));
  for (const w of waiting) {
    logActivity({ projectId: p.id, agentId: "orchestrator", itemId: w.id, type: "gate", summary: `⏸ ${w.code} stays in “${w.state}” — ${openQuestionCount(w.id)} open question(s) must be answered first` });
  }
  const pending = all().filter((i) => !DELIVERED_STATES.includes(i.state) && !waitingForAnswers(i) && !["Blocked", "Cancelled"].includes(i.state));
  const started = new Set<string>();
  const busy = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  const parallelism = Math.max(1, getProject(p.id)!.settings.parallelism);

  const depsReady = (it: WorkItem) => {
    const items = all();
    return it.depends_on.every((code) => {
      const d = items.find((x) => x.code === code);
      return !d || DONE_STATES.includes(d.state) || d.state === "Blocked" || !pending.some((x) => x.id === d.id);
    });
  };

  for (;;) {
    if (signal.aborted) throw new AbortedError("Stopped by user");
    // Graceful pause: let the lanes in flight finish, start nothing new.
    if (pauseRequested.has(p.id) || globalPause()) {
      if (inFlight.size) {
        await Promise.allSettled([...inFlight]);
        continue;
      }
      throw new PauseRequestedError("Paused");
    }
    const fresh = pending.filter((i) => !started.has(i.id)).map((i) => getItem(i.id)!);
    let ready = fresh.filter(depsReady);
    if (!ready.length && !inFlight.size && fresh.length) ready = fresh.slice(0, 1); // break dependency cycles
    while (inFlight.size < parallelism && ready.length) {
      const it = ready.shift()!;
      started.add(it.id);
      const devs = agentsFor(getProject(p.id)!, "developer");
      const dev = devs.sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))[0];
      busy.set(dev.id, (busy.get(dev.id) ?? 0) + 1);
      // Resume where the item was left: after development, continue at peer testing.
      const startAt = it.state === "In Peer Testing" ? "qa" : "development";
      const job: Promise<void> = deliverItem(p.id, it.id, dev, signal, { startAt })
        .catch((e) => {
          // Graceful pause inside a lane: the lane stops at its checkpoint; the scheduler drains the other lanes.
          if (e instanceof PauseRequestedError) return;
          if (e instanceof AbortedError || e instanceof BudgetExceededError || e instanceof LimitReachedError || signal.aborted) throw e;
          patchItem(it.id, { state: "Blocked" });
          logActivity({ projectId: p.id, agentId: "orchestrator", itemId: it.id, type: "blocked", summary: `${it.code} blocked: ${e instanceof Error ? e.message : e}` });
        })
        .finally(() => {
          busy.set(dev.id, (busy.get(dev.id) ?? 1) - 1);
          inFlight.delete(job);
        });
      inFlight.add(job);
    }
    if (!inFlight.size) break;
    await Promise.race(inFlight);
  }
}

interface DeliverOptions {
  feedback?: string;
  kind?: string;
  /** Where to start: full build (default), straight to peer test, or documentation only. */
  startAt?: "development" | "qa" | "documentation";
}

function humanComments(itemId: string) {
  return all<{ content: string; created_at: string }>("SELECT content, created_at FROM comments WHERE item_id = ? AND author_id = 'human' ORDER BY id", itemId);
}

function commentsBlock(itemId: string) {
  const c = humanComments(itemId);
  return c.length ? `\n\n## Comments from the product owner (take them into account)\n${c.map((x) => `- ${x.content}`).join("\n")}` : "";
}

/** On rework the developer gets only the failed checks — the full test report (with screenshots) stays one tool call away. */
function testReportBlock(itemId: string) {
  const it = getItem(itemId);
  const doc = it ? findDoc(it.project_id, "test_report", itemId) : undefined;
  const failed = failedChecks(itemId);
  return failed || doc ? `\n\n## Failed checks${doc ? ` (full report: read_document kind test_report, item_code ${it!.code})` : ""}\n${failed || "(see the findings above)"}` : "";
}

function lastIteration(itemId: string, phase: string) {
  return all<{ n: number }>("SELECT COALESCE(MAX(iteration), 0) n FROM item_phases WHERE item_id = ? AND phase = ?", itemId, phase)[0]?.n ?? 0;
}

/** An item with unanswered questions doesn't advance until they're answered (or it was already past refinement). */
function waitingForAnswers(it: Pick<WorkItem, "id">) {
  return openQuestionCount(it.id) > 0;
}

const isSimulated = (p: Pick<Project, "mode">) => p.mode === "simulation" || effectiveMode() === "simulation";

/** The merge commit's description: the team's PR template filled from the story, the developer's summary and QA. */
function prDescription(it: WorkItem, summary: string) {
  const rows = all<{ result: string; n: number }>(
    "SELECT result, COUNT(*) n FROM test_results WHERE item_id = ? AND iteration = (SELECT MAX(iteration) FROM test_results WHERE item_id = ?) GROUP BY result",
    it.id,
    it.id,
  );
  const n = (r: string) => rows.find((x) => x.result === r)?.n ?? 0;
  const tests = rows.length ? `✅ ${n("pass")} passed · ❌ ${n("fail")} failed · ⛔ ${n("blocked")} blocked (peer test, iteration ${it.rework_count + 1})` : "No recorded checks.";
  return fill(teamSettings().conventions.prTemplate, {
    code: it.code,
    title: it.title,
    branch: it.branch,
    summary: summary.trim() || it.user_story || "",
    components: it.solution_components.trim() || "—",
    tests,
    how_to_test: it.how_to_test.trim() || "—",
  });
}

/** The task gets its own git branch and working copy before anyone works on it. */
async function startBranch(projectId: string, itemId: string) {
  const it = getItem(itemId)!;
  const { branch, created } = await ensureItemBranch(getProject(projectId)!, it);
  if (it.branch !== branch) patchItem(itemId, { branch });
  if (created) logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Created branch ${branch} for ${it.code} from ${getProject(projectId)!.settings.repo?.branch || "main"}` });
}

/** Integrate a finished task: base branch → task branch (conflicts resolved by the developer, or automatically in
 *  simulation), then task branch → base branch with a merge commit. Pushes both when the project pushes; a project
 *  that pushes to GitHub merges through the story's pull request instead (falling back to the local merge).
 *  Returns false when the task couldn't be integrated (it's then Blocked with a message to you). */
async function integrateItem(projectId: string, itemId: string, dev: Agent | undefined, signal: AbortSignal, summary = ""): Promise<boolean> {
  const project = () => getProject(projectId)!;
  const it = getItem(itemId)!;
  if (!it.branch) return true;
  const base = project().settings.repo?.branch || "main";
  const body = prDescription(it, summary);
  const via = prRepoFor(project()) ? "pr" : "local";
  try {
    let m = await mergeItemBranch(project(), { ...it, body, via });
    if (m.conflicts.length) {
      logActivity({ projectId, agentId: "orchestrator", itemId, type: "gate", summary: `⚠ ${it.code}: merge conflicts with ${base} in ${m.conflicts.join(", ")}` });
      if (isSimulated(project()) || !dev) {
        m = await finishMerge(project(), { ...it, body, via }, { author: "AgentStudio", email: "arm@agentstudio.local", keep: "task" });
        logActivity({ projectId, agentId: "orchestrator", itemId, type: "note", summary: `Conflicts on ${it.code} resolved automatically by keeping the task's version (simulation)` });
      } else {
        checkpoint(projectId);
        postMessage({ projectId, from: "orchestrator", to: dev.id, itemId, kind: "rework", content: `${it.code} conflicts with ${base} in: ${m.conflicts.join(", ")}. Resolve them on ${it.branch}.` });
        const phase = startPhase(projectId, itemId, "development", dev.id, lastIteration(itemId, "development") + 1);
        await runAgent({
          project: project(),
          agent: dev,
          stage: "development",
          item: getItem(itemId)!,
          signal,
          kind: "merge",
          task: `Merging ${base} into ${it.branch} for ${it.code} "${it.title}" produced conflicts in:\n${m.conflicts.map((f) => `- ${f}`).join("\n")}\n\nRead each file (it contains <<<<<<< / ======= / >>>>>>> markers), write the resolved version keeping both sides' intent, and remove every marker. Then call complete_development summarising the resolution.`,
        });
        endPhase(phase, "merge resolved");
        m = await finishMerge(project(), { ...getItem(itemId)!, body, via }, { author: `${dev.name} (${dev.title})`, email: agentEmail(dev.name) });
      }
      if (!m.merged && !m.ready) {
        patchItem(itemId, { state: "Blocked" });
        postMessage({ projectId, from: "orchestrator", to: "human", itemId, kind: "question", content: `${it.code} could not be merged into ${base}: conflicts remain in ${m.conflicts.join(", ")}.` });
        return false;
      }
    }
    // GitHub: the branch is up to date with the base branch — the merge happens through the story's pull request.
    if (m.ready) {
      await integrateViaPr(projectId, itemId, body);
      return true;
    }
    if (m.merged) {
      logActivity({ projectId, agentId: "orchestrator", itemId, type: "file", summary: `Merged ${it.branch} into ${base} (${m.commit})` });
      if (project().settings.repo?.push) {
        const r = await pushRefs(project(), [base, it.branch]);
        logActivity({ projectId, agentId: "orchestrator", itemId, type: r.pushed ? "file" : "tool_error", summary: r.pushed ? `Pushed ${base} and ${it.branch} to origin` : `Push failed: ${r.output.split("\n")[0]}`, detail: r.output });
      }
    }
    return true;
  } catch (e) {
    if (e instanceof AbortedError || e instanceof PauseRequestedError || e instanceof LimitReachedError || e instanceof BudgetExceededError) throw e;
    patchItem(itemId, { state: "Blocked" });
    postMessage({ projectId, from: "orchestrator", to: "human", itemId, kind: "question", content: `${it.code} could not be merged into ${base}: ${e instanceof Error ? e.message : e}` });
    return false;
  }
}

async function deliverItem(projectId: string, itemId: string, dev: Agent | undefined, signal: AbortSignal, opts: DeliverOptions = {}) {
  if (waitingForAnswers({ id: itemId })) {
    const it = getItem(itemId)!;
    patchItem(itemId, { state: "Requires additional information" });
    logActivity({ projectId, agentId: "orchestrator", itemId, type: "gate", summary: `⏸ ${it.code} has open questions — answer them before it can be built` });
    return;
  }
  const s = appSettings();
  const project = () => getProject(projectId)!;
  await startBranch(projectId, itemId);
  const qa = agentsFor(project(), "qa");
  const writer = agentsFor(project(), "writer")[0];
  const maxRework = project().settings.maxRework ?? s.maxRework;
  const startAt = opts.startAt ?? "development";
  let findings = "";
  /** Who asked for the last rework: QA, or the architect's code review. */
  let findingsFrom = "qa" as "qa" | "review"; // (a cast: it's also set inside reviewPasses, which TS can't follow)
  let lastDevSummary = "";
  let qaNotes = "";
  let approved = startAt === "documentation" || (startAt === "development" && !opts.feedback && getItem(itemId)!.state === "Ready for UAT"); // resumed after QA approval
  const base = lastIteration(itemId, "development");
  /** Optional architect code review once QA is happy (settings.codeReview). False = changes requested (rework). */
  const reviewPasses = async (iteration: number, n: number) => {
    const architect = agentsFor(project(), "architect")[0];
    if (!architect || !needsCodeReview(project(), getItem(itemId)!)) return true;
    checkpoint(projectId);
    const rv = await runCodeReview({ projectId, itemId, architect, iteration, attempt: n, signal, kind: opts.kind });
    if (rv.verdict === "approved") return true;
    findings = rv.findings;
    findingsFrom = "review";
    patchItem(itemId, { rework_count: (getItem(itemId)!.rework_count ?? 0) + 1 });
    return false;
  };

  for (let n = 1; !approved && n <= maxRework + 1; n++) {
    const iteration = base + n;
    checkpoint(projectId);
    let item = getItem(itemId)!;
    let devSummary = "";
    if (dev && !(n === 1 && startAt === "qa")) {
      item = patchItem(itemId, { state: "In Progress", assigned_agent_id: dev.id });
      const devPhase = startPhase(projectId, itemId, "development", dev.id, iteration);
      const isBug = item.type === "bug";
      const r = await runAgent({
        project: project(),
        agent: dev,
        stage: "development",
        item,
        iteration,
        attempt: n,
        signal,
        kind: opts.kind,
        feedback: n === 1 ? opts.feedback : undefined,
        task:
          n > 1 && findingsFrom === "review"
            ? `The architect's code review requested changes on ${item.code} "${item.title}" (iteration ${iteration}). Fix every finding below, then call complete_development explaining each fix.\n\n## Code review findings\n${findings}`
            : n > 1
            ? `QA requested changes on ${item.code} "${item.title}" (iteration ${iteration}). Fix every finding below, then call complete_development explaining each fix.\n\n## QA findings\n${findings}${testReportBlock(itemId)}`
            : opts.feedback
              ? `The product owner asked you to rework ${item.code} "${item.title}". Apply this feedback, keep everything else working, then call complete_development explaining the change.\n\n## Feedback\n${opts.feedback}${commentsBlock(itemId)}`
              : isBug
                ? `Fix bug ${item.code} "${item.title}". Read it with get_item (steps to reproduce, expected and actual behaviour) and the parent story's files, fix the cause, add a regression test, then call complete_development.${commentsBlock(itemId)}`
                : `Implement ${item.code} "${item.title}". Read it with get_item first. Finish with complete_development.${commentsBlock(itemId)}`,
      });
      endPhase(devPhase);
      devSummary = r.outcome.devCompleted ?? r.summary;
      lastDevSummary = devSummary;
    }
    item = patchItem(itemId, { state: "In Peer Testing" });
    if (!qa.length) {
      if (await reviewPasses(iteration, n)) {
        approved = true;
        break;
      }
      if (!dev) break;
      continue;
    }
    checkpoint(projectId);
    const tester = qa[(iteration - 1) % qa.length];
    if (dev && devSummary) postMessage({ projectId, from: dev.id, to: tester.id, itemId, kind: "handoff", content: `${item.code} ready for peer testing. ${devSummary}`.slice(0, 1200) });
    // GitHub projects: the story's PR exists (as a draft) while QA tests it. Best-effort — failures are only logged.
    if (dev && devSummary && prRepoFor(project())) await openDraftPr(projectId, itemId, prDescription(getItem(itemId)!, devSummary));
    const qaPhase = startPhase(projectId, itemId, "qa", tester.id, iteration);
    const q = await runAgent({
      project: project(),
      agent: tester,
      stage: "qa",
      item: getItem(itemId)!,
      iteration,
      attempt: n,
      signal,
      kind: opts.kind,
      feedback: n === 1 ? opts.feedback : undefined,
      task: `Peer-test ${item.code} "${item.title}" (iteration ${iteration}) with the Rudolf method and submit your verdict with submit_review.${devSummary ? `\n\n## Developer's hand-over\n${devSummary.slice(0, 2000)}` : ""}${n > 1 && findings ? (findingsFrom === "review" ? `\n\n## Code review findings the developer fixed (re-test the checks they touch)\n${findings.slice(0, 3000)}` : `\n\n## Your findings from the previous iteration (check each one is fixed)\n${findings.slice(0, 3000)}`) : ""}${opts.feedback && n === 1 ? `\n\nAlso verify the product owner's feedback was applied: ${opts.feedback}` : ""}`,
    });
    const verdict = q.outcome.review?.verdict ?? "approved";
    qaNotes = q.outcome.review?.findings ?? "";
    endPhase(qaPhase, verdict);
    if (verdict === "approved") {
      if (await reviewPasses(iteration, n)) {
        approved = true;
        patchItem(itemId, { state: "Ready for UAT" });
        break;
      }
      if (!dev) break;
      continue;
    }
    findings = q.outcome.review?.findings || q.summary;
    findingsFrom = "qa";
    patchItem(itemId, { rework_count: (getItem(itemId)!.rework_count ?? 0) + 1 });
    insert("comments", { project_id: projectId, item_id: itemId, author_id: tester.id, content: `QA findings (iteration ${iteration}):\n${findings}`, created_at: now() });
    await commentQaFindings(projectId, itemId, { iteration, findings, tester: tester.name });
    const report = findDoc(projectId, "test_report", itemId);
    postMessage({ projectId, from: tester.id, to: dev?.id ?? "human", itemId, kind: "rework", content: `${findings}${report ? `\n\nTest report v${report.version} with screenshots is attached to ${getItem(itemId)!.code}.` : ""}` });
    if (!dev) break;
  }

  if (!approved) {
    patchItem(itemId, { state: "Blocked" });
    postMessage({ projectId, from: "orchestrator", to: "human", itemId, kind: "question", content: `${getItem(itemId)!.code} still fails ${findingsFrom === "review" ? "the code review" : "QA"} after ${maxRework} rework loop(s). Please review.` });
    return;
  }

  if (writer) {
    checkpoint(projectId);
    const from = qa[0]?.id ?? dev?.id ?? "orchestrator";
    postMessage({ projectId, from, to: writer.id, itemId, kind: "handoff", content: `${getItem(itemId)!.code} approved — please document it.` });
    const docPhase = startPhase(projectId, itemId, "documentation", writer.id, lastIteration(itemId, "documentation") + 1);
    await runAgent({
      project: project(),
      agent: writer,
      stage: "documentation",
      item: getItem(itemId)!,
      signal,
      kind: opts.kind,
      feedback: startAt === "documentation" ? opts.feedback : undefined,
      task: `Document ${getItem(itemId)!.code}: write its task document (write_document kind task_doc), then update the user manual, technical overview and changelog with update_document_section — only the sections this story adds or changes; never resend whole documents.${lastDevSummary ? `\n\n## What was built (developer)\n${lastDevSummary.slice(0, 2000)}` : ""}${qaNotes ? `\n\n## QA verdict notes\n${qaNotes.slice(0, 1200)}` : ""}${startAt === "documentation" && opts.feedback ? `\n\n## Feedback from the product owner\n${opts.feedback}` : ""}`,
    });
    endPhase(docPhase);
  }
  if (!(await integrateItem(projectId, itemId, dev, signal, lastDevSummary))) return;
  patchItem(itemId, { state: "Release Ready" });
  const rel = agentsFor(project(), "release")[0];
  if (rel) postMessage({ projectId, from: writer?.id ?? dev?.id ?? "orchestrator", to: rel.id, itemId, kind: "handoff", content: `${getItem(itemId)!.code} is Release Ready.` });
}

async function stageRelease(p: Project, signal: AbortSignal, onlyIds?: string[]) {
  const agent = agentsFor(p, "release")[0];
  const scope = listItems(p.id).filter((i) => i.state === "Release Ready" && (!onlyIds?.length || onlyIds.includes(i.id)));
  if (!scope.length) {
    logActivity({ projectId: p.id, agentId: agent.id, type: "note", summary: "Nothing is Release Ready — release skipped." });
    return;
  }
  const phaseIds = scope.map((i) => {
    patchItem(i.id, { state: "Smoke Testing" });
    return startPhase(p.id, i.id, "release", agent.id);
  });
  postMessage({ projectId: p.id, from: "orchestrator", to: agent.id, kind: "handoff", content: `Release ${scope.length} item(s).` });
  const r = await runAgent({
    project: getProject(p.id)!,
    agent,
    stage: "release",
    signal,
    task: `Release the ${scope.length} item(s) in state "Smoke Testing"/"Release Ready": ${scope.map((i) => i.code).join(", ")}. Run the project's checks on the base branch with run_checks, smoke test each item and publish the release. Put the check results in the release notes.`,
  });
  phaseIds.forEach((id) => endPhase(id, r.outcome.released ? "released" : "not released"));
  if (r.outcome.released) {
    for (const i of scope) patchItem(i.id, { state: "Deployed (Done)" });
    const cur = getProject(p.id)!;
    if (cur.settings.repo?.push) {
      const base = cur.settings.repo.branch || "main";
      const pushed = await pushRefs(cur, [base], true);
      logActivity({ projectId: p.id, agentId: agent.id, type: pushed.pushed ? "file" : "tool_error", summary: pushed.pushed ? `Pushed ${base} and release tag v${r.outcome.released.version} to origin` : `Push failed: ${pushed.output.split("\n")[0]}`, detail: pushed.output });
    }
  } else {
    for (const i of scope) patchItem(i.id, { state: "Release Ready" });
    logActivity({ projectId: p.id, agentId: agent.id, type: "note", summary: "Release was not published — items stay Release Ready." });
  }
}

/** On server start, projects that were running are marked paused (their runs were interrupted). */
export function recoverInterrupted() {
  const gp = globalPause();
  for (const p of all<{ id: string }>("SELECT id FROM projects WHERE status = 'running'")) {
    if (gp && !gp.projects.includes(p.id)) setGlobalPause({ ...gp, projects: [...gp.projects, p.id] });
    closeOpenPhases(p.id, "interrupted");
    run("UPDATE runs SET status = 'stopped', ended_at = ? WHERE project_id = ? AND status = 'running'", now(), p.id);
    const proj = getProject(p.id)!;
    patchProject(p.id, {
      status: "paused",
      error: "Server restarted — press Resume to continue.",
      stages: proj.stages.map((s) => (s.status === "running" ? { ...s, status: "pending" } : s)),
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// On-demand jobs: re-run one item with feedback, fix a bug, release now. They run outside the main pipeline loop.

interface Job { projectId: string; label: string; ctrl: AbortController; itemId?: string; spec?: JobSpec }
const jobs = new Map<string, Job>();

export function listJobs(projectId: string) {
  return [...jobs.entries()].filter(([, j]) => j.projectId === projectId).map(([key, j]) => ({ key, label: j.label, itemId: j.itemId ?? null }));
}

function startJob(projectId: string, key: string, label: string, itemId: string | undefined, fn: (signal: AbortSignal) => Promise<void>, spec?: JobSpec) {
  const gp = globalPause();
  if (gp) throw new Error(`All work is paused: ${gp.reason} Resume all first.`);
  if (controllers.has(projectId)) throw new Error("The pipeline is running — pause it or wait until it reaches a gate first.");
  pauseRequested.delete(projectId);
  if (jobs.has(key)) throw new Error("That job is already running.");
  if (itemId && all("SELECT 1 FROM runs WHERE item_id = ? AND status = 'running'", itemId).length) throw new Error("An agent is already working on this item.");
  const ctrl = new AbortController();
  jobs.set(key, { projectId, label, ctrl, itemId, spec });
  emit({ type: "project", projectId });
  logActivity({ projectId, agentId: "orchestrator", itemId, type: "pipeline", summary: `Started: ${label}` });
  void fn(ctrl.signal)
    .then(() => logActivity({ projectId, agentId: "orchestrator", itemId, type: "pipeline", summary: `Finished: ${label}` }))
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      closeOpenPhases(projectId, "interrupted");
      if (e instanceof LimitReachedError) pauseAll({ mode: "now", kind: e.kind, reason: e.message, resumeAt: e.resumeAt });
      if (e instanceof LimitReachedError && spec) {
        const gp = globalPause();
        if (gp && !gp.jobs.some((j) => JSON.stringify(j) === JSON.stringify(spec))) setGlobalPause({ ...gp, jobs: [...gp.jobs, spec] });
      }
      if (e instanceof PauseRequestedError) {
        logActivity({ projectId, agentId: "orchestrator", itemId, type: "pipeline", summary: `⏸ Paused: ${label} — resume to continue` });
        return;
      }
      if (e instanceof BudgetExceededError) patchProject(projectId, { error: msg });
      logActivity({ projectId, agentId: "orchestrator", itemId, type: ctrl.signal.aborted ? "pipeline" : "blocked", summary: ctrl.signal.aborted ? `Stopped: ${label}` : `${label} failed: ${msg}` });
    })
    .finally(() => {
      jobs.delete(key);
      emit({ type: "project", projectId });
    });
}

export type RerunRole = "requirements" | "architect" | "developer" | "qa" | "writer";

export function rerunItem(itemId: string, role: RerunRole, feedback: string, resuming = false) {
  const it = getItem(itemId);
  if (!it) throw new Error("Item not found");
  const p = getProject(it.project_id)!;
  const agent = agentsFor(p, role)[0];
  if (!agent) throw new Error(`This project has no ${ROLES[role].title} on its team.`);
  if ((role === "developer" || role === "qa" || role === "writer") && !["story", "task", "bug"].includes(it.type)) throw new Error("Only stories, tasks and bugs can be rebuilt, retested or redocumented.");
  if ((role === "developer" || role === "qa" || role === "writer") && waitingForAnswers(it)) {
    throw new Error(`${it.code} has ${openQuestionCount(it.id)} unanswered question(s) — answer them first. The analyst or architect can still revise it.`);
  }
  const text = feedback.trim();
  if (!resuming) {
    if (text) insert("comments", { project_id: p.id, item_id: it.id, author_id: "human", content: `Feedback for ${agent.name}: ${text}`, created_at: now() });
    postMessage({ projectId: p.id, from: "human", to: agent.id, itemId: it.id, kind: "rework", content: text || `Please redo your part of ${it.code}.` });
  }
  const label = `${agent.name} re-runs ${it.code}`;
  startJob(p.id, `item:${it.id}`, label, it.id, async (signal) => {
    if (role === "requirements" || role === "architect") {
      const phase = role === "requirements" ? "analysis" : "architecture";
      const ph = startPhase(p.id, it.id, phase, agent.id, lastIteration(it.id, phase) + 1);
      await runAgent({
        project: getProject(p.id)!,
        agent,
        stage: role === "requirements" ? "requirements" : "architecture",
        item: getItem(it.id)!,
        signal,
        kind: "rerun",
        feedback: text,
        task: `Revise ${it.code} "${it.title}" only, applying the product owner's feedback below. Update the item with update_work_item and tell the developer what changed.\n\n## Feedback\n${text}${commentsBlock(it.id)}`,
      });
      endPhase(ph);
      return;
    }
    const dev = agentsFor(getProject(p.id)!, "developer")[0];
    await deliverItem(p.id, it.id, dev, signal, { feedback: text, kind: "rerun", startAt: role === "developer" ? "development" : role === "qa" ? "qa" : "documentation" });
  }, { type: "rerun", itemId: it.id, role, feedback: text });
  return { label };
}

// ---------------------------------------------------------------------------------------------------------------------
// Start work on one item: run every missing step in pipeline order, calling the agents that own each step.

const PRE_REFINED = ["New", "Requires additional information", "Ready for Refinement"];
const STARTED = ["In Progress", "In Peer Testing", "Ready for UAT", "Release Ready", "Smoke Testing", "Deployed (Done)"];

/** The steps "Start work" will run for an item, in order — shown to the user before confirming. */
export function startPlan(itemId: string) {
  const it = getItem(itemId);
  if (!it) throw new Error("Item not found");
  const p = getProject(it.project_id)!;
  const team = (role: string) => agentsFor(p, role)[0];
  const steps: { role: string; agent: string | null; what: string }[] = [];
  if (PRE_REFINED.includes(it.state)) steps.push({ role: "architect", agent: team("architect")?.name ?? null, what: "Technical refinement" });
  if (PRE_REFINED.includes(it.state) || it.state === "Ready for Sprint" || it.story_points == null) steps.push({ role: "planner", agent: team("planner")?.name ?? null, what: "Estimate & plan" });
  steps.push({ role: "developer", agent: team("developer")?.name ?? null, what: "Build" });
  steps.push({ role: "qa", agent: team("qa")?.name ?? null, what: "Peer test (rework loop)" });
  steps.push({ role: "writer", agent: team("writer")?.name ?? null, what: "Documentation" });
  const open = all<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE item_id = ? AND (answer IS NULL OR answer = '')", it.id)[0].n;
  const reasons: string[] = [];
  if (!["story", "task", "bug"].includes(it.type)) reasons.push("Only stories, tasks and bugs can be started.");
  if (STARTED.includes(it.state)) reasons.push(`${it.code} is already past this point (${it.state}).`);
  if (it.state === "Cancelled") reasons.push(`${it.code} is cancelled — reopen it first.`);
  if (open) reasons.push(`${it.code} has ${open} unanswered question(s) — answer them first.`);
  if (!team("developer")) reasons.push("This project has no developer on its team.");
  return { steps: steps.filter((s) => s.agent), skipped: steps.filter((s) => !s.agent).map((s) => s.what), blockedBy: reasons };
}

function normaliseItem(itemId: string) {
  const it = getItem(itemId)!;
  const items = listItems(it.project_id).filter((i) => i.type === "story" || i.type === "task" || i.type === "bug");
  const patch: Partial<WorkItem> = {};
  if (it.story_points == null) patch.story_points = 3;
  if (it.rank == null) patch.rank = Math.max(0, ...items.map((i) => i.rank ?? 0)) + 1;
  if (it.sprint == null) patch.sprint = Math.min(...items.filter((i) => !DELIVERED_STATES.includes(i.state) && i.sprint).map((i) => i.sprint!), 99) % 99 || 1;
  patch.human_hours = (patch.story_points ?? it.story_points ?? 3) * appSettings().hoursPerStoryPoint;
  patch.state = "To Do";
  patchItem(itemId, patch);
}

export function startItem(itemId: string) {
  const plan = startPlan(itemId);
  if (plan.blockedBy.length) throw new Error(plan.blockedBy.join(" "));
  const it = getItem(itemId)!;
  const p = getProject(it.project_id)!;
  postMessage({ projectId: p.id, from: "human", to: "orchestrator", itemId, kind: "handoff", content: `Start work on ${it.code}: ${plan.steps.map((s) => `${s.agent} (${s.what})`).join(" → ")}` });
  startJob(p.id, `item:${it.id}`, `Start work on ${it.code}`, it.id, async (signal) => {
    let cur = getItem(itemId)!;
    if (PRE_REFINED.includes(cur.state)) {
      const arch = agentsFor(getProject(p.id)!, "architect")[0];
      if (arch) {
        postMessage({ projectId: p.id, from: "orchestrator", to: arch.id, itemId, kind: "handoff", content: `Refine ${cur.code} before development starts.` });
        const ph = startPhase(p.id, itemId, "architecture", arch.id, lastIteration(itemId, "architecture") + 1);
        await runAgent({ project: getProject(p.id)!, agent: arch, stage: "architecture", item: cur, signal, kind: "start", task: `Refine ${cur.code} "${cur.title}" only: complete its technical specification and update the solution design.${commentsBlock(itemId)}` });
        endPhase(ph);
      }
      if (PRE_REFINED.includes(getItem(itemId)!.state)) patchItem(itemId, { state: "Ready for Sprint" });
    }
    cur = getItem(itemId)!;
    if (cur.state === "Ready for Sprint" || cur.story_points == null) {
      const planner = agentsFor(getProject(p.id)!, "planner")[0];
      if (planner) {
        const arch = agentsFor(getProject(p.id)!, "architect")[0];
        postMessage({ projectId: p.id, from: arch?.id ?? "orchestrator", to: planner.id, itemId, kind: "handoff", content: `${cur.code} is refined — please estimate and plan it.` });
        const ph = startPhase(p.id, itemId, "planning", planner.id, lastIteration(itemId, "planning") + 1);
        await runAgent({ project: getProject(p.id)!, agent: planner, stage: "planning", item: cur, signal, kind: "start", task: `Estimate, prioritise and plan ${cur.code} "${cur.title}" only, with plan_item. Keep the rest of the plan unchanged.` });
        endPhase(ph);
      }
      normaliseItem(itemId);
    }
    const dev = agentsFor(getProject(p.id)!, "developer")[0];
    const planner = agentsFor(getProject(p.id)!, "planner")[0];
    postMessage({ projectId: p.id, from: planner?.id ?? "orchestrator", to: dev.id, itemId, kind: "handoff", content: `${getItem(itemId)!.code} is ready to build.` });
    await deliverItem(p.id, itemId, dev, signal, { kind: "start" });
  }, { type: "start", itemId: it.id });
}

/** State changes a person may make by hand. Everything else moves only through the agents. */
export function humanTransition(from: string, to: string): string | null {
  if (to === from) return null;
  if (to === "Cancelled") return from === "Deployed (Done)" ? "A deployed item can't be cancelled — report a bug instead." : null;
  if (to === "Blocked") return STARTED.slice(3).includes(from) ? "Released items can't be put on hold." : null;
  if (to === "New" && (from === "Cancelled" || from === "Blocked")) return null;
  return `State changes follow the pipeline: ${from} → ${to} would skip steps. Use "Start work" and the agents move the item forward.`;
}

export interface BugReport { title: string; steps: string; expected: string; actual: string; severity: "1 - Critical" | "2 - High" | "3 - Medium" | "4 - Low" }

export function reportBug(storyId: string, b: BugReport) {
  const story = getItem(storyId);
  if (!story) throw new Error("Item not found");
  const sev = Number(b.severity[0]) || 3;
  const sprint = Math.max(1, ...listItems(story.project_id).map((i) => i.sprint ?? 1));
  const bug = createItem(story.project_id, {
    type: "bug",
    title: b.title,
    parent_id: story.id,
    category: story.category,
    state: "To Do",
    user_story: `**Actual:** ${b.actual}\n\n**Expected:** ${b.expected}`,
    background: b.steps,
    acceptance_criteria: `### AC 1: Expected behaviour\n${b.expected}\n\n### AC 2: No regression\nThe acceptance criteria of ${story.code} still pass.`,
    tags: [`Severity ${b.severity}`, `Found in ${story.code}`],
    priority: Math.min(4, sev),
    story_points: sev <= 2 ? 2 : 1,
    sprint,
    rank: 0,
    human_hours: (sev <= 2 ? 2 : 1) * appSettings().hoursPerStoryPoint,
    created_by: "human",
  });
  postMessage({ projectId: story.project_id, from: "human", to: "orchestrator", itemId: bug.id, kind: "info", content: `Bug ${bug.code} reported on ${story.code}: ${b.title}` });
  logActivity({ projectId: story.project_id, agentId: "human", itemId: bug.id, type: "item_created", summary: `You reported bug ${bug.code} on ${story.code} — ${b.title}` });
  return bug;
}

export function fixBug(bugId: string, releaseAfter: boolean) {
  const bug = getItem(bugId);
  if (!bug || bug.type !== "bug") throw new Error("Bug not found");
  const p = getProject(bug.project_id)!;
  const dev = agentsFor(p, "developer")[0];
  if (!dev) throw new Error("This project has no developer on its team.");
  if (waitingForAnswers(bug)) throw new Error(`${bug.code} has unanswered questions — answer them first.`);
  startJob(p.id, `item:${bug.id}`, `Fix ${bug.code}${releaseAfter ? " and release a patch" : ""}`, bug.id, async (signal) => {
    postMessage({ projectId: p.id, from: "orchestrator", to: dev.id, itemId: bug.id, kind: "handoff", content: `Please fix ${bug.code}: ${bug.title}` });
    await deliverItem(p.id, bug.id, dev, signal, { kind: "bugfix" });
    if (releaseAfter && agentsFor(getProject(p.id)!, "release").length && getItem(bug.id)!.state === "Release Ready") {
      await stageRelease(getProject(p.id)!, signal);
    }
  }, { type: "fix", itemId: bug.id, release: releaseAfter });
}

export function releaseNow(projectId: string, itemIds?: string[]) {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  if (!agentsFor(p, "release").length) throw new Error("This project has no release manager on its team.");
  const ready = listItems(p.id).filter((i) => i.state === "Release Ready" && (!itemIds?.length || itemIds.includes(i.id)));
  if (!ready.length) throw new Error("Nothing selected is Release Ready.");
  startJob(p.id, `release:${p.id}`, `Release ${ready.length} item(s)`, undefined, async (signal) => {
    await stageRelease(getProject(p.id)!, signal, ready.map((i) => i.id));
  }, { type: "release", projectId: p.id, itemIds: ready.map((i) => i.id) });
}

export { ROLES };
