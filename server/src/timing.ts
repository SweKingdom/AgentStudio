/**
 * Measured time and spend for a project, instead of estimates.
 *
 * Time: the project's elapsed time, split into what actually happened. Every moment counts once, under the first of:
 * agents working (a run in progress) → paused for a limit (Claude plan, spend or budget) → waiting for the product owner
 * (an approval gate or an open question) → paused by hand → other (checks, merges, idle, and waits from before they
 * were recorded).
 *
 * Spend: what the model calls cost, split by what became of the work — delivered, still in progress, stopped, or
 * project-wide (analysis, planning, release) — and how much of it went on rework rounds.
 */
import { all, get } from "./db.js";

export interface ProjectTime {
  elapsedSeconds: number;
  /** Wall clock with at least one agent run in progress (parallel lanes count once). */
  workingSeconds: number;
  /** All run durations added up: the agents' combined working time across lanes. */
  agentSeconds: number;
  waitingForYouSeconds: number;
  limitSeconds: number;
  pausedSeconds: number;
  otherSeconds: number;
  /** How many times the project paused for a limit. */
  limitPauses: number;
}

type Interval = [number, number];
const CATEGORIES = ["working", "limit", "you", "paused"] as const;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function projectTime(projectId: string, nowMs = Date.now()): ProjectTime {
  const p = get<{ started_at: string | null; finished_at: string | null; status: string }>("SELECT started_at, finished_at, status FROM projects WHERE id = ?", projectId);
  const zero: ProjectTime = { elapsedSeconds: 0, workingSeconds: 0, agentSeconds: 0, waitingForYouSeconds: 0, limitSeconds: 0, pausedSeconds: 0, otherSeconds: 0, limitPauses: 0 };
  if (!p?.started_at) return zero;
  const start = ms(p.started_at);
  const end = Math.max(start, p.finished_at ? ms(p.finished_at) : nowMs);
  const clip = (a: number, b: number): Interval | null => {
    const s = Math.max(a, start);
    const e = Math.min(Number.isNaN(b) ? end : b, end);
    return Number.isNaN(s) || e <= s ? null : [s, e];
  };
  const runs = all<{ started_at: string; ended_at: string | null }>("SELECT started_at, ended_at FROM runs WHERE project_id = ?", projectId);
  const waits = all<{ kind: string; started_at: string; ended_at: string | null }>("SELECT kind, started_at, ended_at FROM project_waits WHERE project_id = ?", projectId);
  const questions = all<{ created_at: string; answered_at: string | null }>("SELECT created_at, answered_at FROM questions WHERE project_id = ?", projectId);
  const sets: Record<(typeof CATEGORIES)[number], Interval[]> = { working: [], limit: [], you: [], paused: [] };
  let agentMs = 0;
  for (const r of runs) {
    const i = clip(ms(r.started_at), r.ended_at ? ms(r.ended_at) : NaN);
    if (i) {
      sets.working.push(i);
      agentMs += i[1] - i[0];
    }
  }
  for (const w of waits) {
    const i = clip(ms(w.started_at), w.ended_at ? ms(w.ended_at) : NaN);
    if (i && (w.kind === "you" || w.kind === "limit" || w.kind === "paused")) sets[w.kind].push(i);
  }
  for (const q of questions) {
    const i = clip(ms(q.created_at), q.answered_at ? ms(q.answered_at) : NaN);
    if (i) sets.you.push(i);
  }
  // Every stretch between two boundaries belongs to the first category that covers it.
  const points = [...new Set([start, end, ...CATEGORIES.flatMap((c) => sets[c].flat())])].sort((a, b) => a - b);
  const total: Record<(typeof CATEGORIES)[number] | "other", number> = { working: 0, limit: 0, you: 0, paused: 0, other: 0 };
  for (let k = 0; k + 1 < points.length; k++) {
    const [a, b] = [points[k], points[k + 1]];
    const mid = (a + b) / 2;
    const cat = CATEGORIES.find((c) => sets[c].some(([s, e]) => s <= mid && mid < e)) ?? "other";
    total[cat] += b - a;
  }
  const s = (x: number) => Math.round(x / 1000);
  return {
    elapsedSeconds: s(end - start),
    workingSeconds: s(total.working),
    agentSeconds: s(agentMs),
    waitingForYouSeconds: s(total.you),
    limitSeconds: s(total.limit),
    pausedSeconds: s(total.paused),
    otherSeconds: s(total.other),
    limitPauses: waits.filter((w) => w.kind === "limit").length,
  };
}

export interface Spend {
  totalUsd: number;
  /** Stories, tasks and bugs that are Release Ready or deployed. */
  deliveredUsd: number;
  inProgressUsd: number;
  /** Blocked, cancelled or removed: spend that didn't ship. */
  stoppedUsd: number;
  /** Not tied to one item: analysis, design, planning, release. */
  projectWideUsd: number;
  /** Development, QA and code review after the first round: what it cost to fix what was sent back. Part of the above. */
  reworkUsd: number;
  /** Items QA tested, and those it approved without sending them back. */
  firstTry: { tested: number; passed: number };
}

const DELIVERED = ["Release Ready", "Smoke Testing", "Deployed (Done)"];
const STOPPED = ["Blocked", "Cancelled", "Removed"];

/** Rework: a round after QA, code review or the checks sent the story back. Runs record their attempt within the
 *  delivery (1 = first build; resuming after an answer starts again at 1). Runs from before that was recorded count
 *  when the item was sent back at least once and the round wasn't its first. Merge fixes and conflicts are other kinds. */
const LEGACY_ROUND = `(SELECT MAX(ph.iteration) FROM item_phases ph WHERE ph.item_id = r.item_id AND ph.phase = r.stage AND ph.started_at <= r.started_at)`;
const REWORK = `r.kind = 'pipeline' AND r.stage IN ('development', 'qa', 'review') AND CASE WHEN r.attempt IS NOT NULL THEN r.attempt > 1 ELSE w.rework_count > 0 AND COALESCE(${LEGACY_ROUND}, 1) > 1 END`;

export function projectSpend(projectId: string): Spend {
  const rows = all<{ state: string | null; item: string | null; cost: number; rework: number }>(
    `SELECT w.state state, c.item_id item, SUM(c.cost_usd) cost, SUM(CASE WHEN r.id IS NOT NULL AND ${REWORK} THEN c.cost_usd ELSE 0 END) rework
     FROM llm_calls c LEFT JOIN runs r ON r.id = c.run_id LEFT JOIN work_items w ON w.id = c.item_id
     WHERE c.project_id = ? GROUP BY c.item_id`,
    projectId,
  );
  const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r.cost, 0);
  const tested = get<{ tested: number; passed: number }>(
    `SELECT COUNT(*) tested, COALESCE(SUM(CASE WHEN w.rework_count = 0 THEN 1 ELSE 0 END), 0) passed FROM work_items w
     WHERE w.project_id = ? AND w.type IN ('story', 'task', 'bug') AND EXISTS (SELECT 1 FROM item_phases ph WHERE ph.item_id = w.id AND ph.phase = 'qa')`,
    projectId,
  )!;
  return {
    totalUsd: sum(() => true),
    deliveredUsd: sum((r) => !!r.item && DELIVERED.includes(r.state ?? "")),
    inProgressUsd: sum((r) => !!r.item && !DELIVERED.includes(r.state ?? "") && !STOPPED.includes(r.state ?? "")),
    stoppedUsd: sum((r) => !!r.item && STOPPED.includes(r.state ?? "")),
    projectWideUsd: sum((r) => !r.item),
    reworkUsd: rows.reduce((n, r) => n + r.rework, 0),
    firstTry: { tested: tested.tested, passed: tested.passed },
  };
}

/** One item's direct spend and the part of it that went on rework rounds. */
export function itemSpend(itemId: string) {
  const r = get<{ totalUsd: number; reworkUsd: number }>(
    `SELECT COALESCE(SUM(c.cost_usd), 0) totalUsd, COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND ${REWORK} THEN c.cost_usd ELSE 0 END), 0) reworkUsd
     FROM llm_calls c LEFT JOIN runs r ON r.id = c.run_id LEFT JOIN work_items w ON w.id = c.item_id WHERE c.item_id = ?`,
    itemId,
  )!;
  return { totalUsd: r.totalUsd, reworkUsd: r.reworkUsd };
}
