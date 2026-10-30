/**
 * Global pause: one switch that stops all work across projects and remembers what to resume.
 * Triggered by the user ("Pause all"), or automatically when the API runs out of capacity / credits or a spend limit
 * is reached — in which case it can resume on its own when the limit resets.
 */
import { get, getSetting, setSetting, now } from "./db.js";
import { emit } from "./events.js";
import { appSettings } from "./settings.js";
import { LimitReachedError, type LimitKind } from "./errors.js";

export type JobSpec =
  | { type: "start"; itemId: string }
  | { type: "rerun"; itemId: string; role: string; feedback: string }
  | { type: "fix"; itemId: string; release: boolean }
  | { type: "release"; projectId: string; itemIds?: string[] };

export interface GlobalPause {
  reason: string;
  kind: LimitKind | "user";
  since: string;
  /** When it may resume on its own (rate limits, overload, spend limits after the period resets). */
  resumeAt: string | null;
  /** What was running when the pause started — resumed by "Resume all". */
  projects: string[];
  jobs: JobSpec[];
}

export function globalPause(): GlobalPause | null {
  return getSetting<GlobalPause | null>("globalPause", null);
}

export function setGlobalPause(p: GlobalPause | null) {
  setSetting("globalPause", p);
  emit({ type: "project" });
}

function spendSince(iso: string) {
  return get<{ c: number }>("SELECT COALESCE(SUM(cost_usd), 0) c FROM llm_calls WHERE created_at >= ?", iso)!.c;
}

function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function spendStatus() {
  const s = appSettings();
  const today = spendSince(startOfDay().toISOString());
  const month = spendSince(startOfMonth().toISOString());
  return { today, month, dailyLimitUsd: s.dailyLimitUsd, monthlyLimitUsd: s.monthlyLimitUsd };
}

/** Throws when a daily or monthly spend limit is reached. Called before every model call (live and simulated). */
export function checkSpendLimits() {
  const st = spendStatus();
  if (st.dailyLimitUsd > 0 && st.today >= st.dailyLimitUsd) {
    const d = startOfDay();
    d.setDate(d.getDate() + 1);
    throw new LimitReachedError(`Daily spend limit of $${st.dailyLimitUsd.toFixed(2)} reached ($${st.today.toFixed(2)} today).`, "daily_limit", d.toISOString());
  }
  if (st.monthlyLimitUsd > 0 && st.month >= st.monthlyLimitUsd) {
    const d = startOfMonth();
    d.setMonth(d.getMonth() + 1);
    throw new LimitReachedError(`Monthly spend limit of $${st.monthlyLimitUsd.toFixed(2)} reached ($${st.month.toFixed(2)} this month).`, "monthly_limit", d.toISOString());
  }
}

/** Maps Claude API errors to a pause reason. Returns null for errors that are real failures. */
export function limitFromApiError(e: unknown): LimitReachedError | null {
  const err = e as { status?: number; message?: string; headers?: { get?: (k: string) => string | null } | Record<string, string>; name?: string };
  const status = err?.status;
  const msg = String(err?.message ?? "");
  const header = (k: string) => {
    const h = err?.headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
    if (!h) return null;
    return typeof (h as { get?: unknown }).get === "function" ? (h as { get: (k: string) => string | null }).get(k) : (h as Record<string, string>)[k] ?? null;
  };
  const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  if (status === 429) {
    const retry = Number(header("retry-after")) || 60;
    return new LimitReachedError(`Claude API rate limit reached — resuming in about ${Math.ceil(retry / 60)} min.`, "rate_limit", inSeconds(Math.max(30, retry)));
  }
  if (status === 529 || /overloaded/i.test(msg)) return new LimitReachedError("Claude API is overloaded — retrying in 3 min.", "overloaded", inSeconds(180));
  if (status === 401 || status === 403) return new LimitReachedError("The Claude API key was rejected — check ANTHROPIC_API_KEY, then resume.", "auth", null);
  if (status === 400 && /credit balance|billing|quota/i.test(msg)) return new LimitReachedError("Out of Claude API credits — add credits, then resume.", "credits", null);
  if (!status && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(`${msg} ${err?.name ?? ""}`)) {
    return new LimitReachedError("Can't reach the Claude API (network) — retrying in 2 min.", "network", inSeconds(120));
  }
  return null;
}

export function autoResumeAllowed(p: GlobalPause) {
  if (!p.resumeAt || p.kind === "user") return false;
  if (p.kind === "daily_limit" || p.kind === "monthly_limit") return appSettings().autoResumeLimits;
  return true;
}

export function pauseLabel(p: GlobalPause) {
  return `${p.reason}${p.resumeAt && autoResumeAllowed(p) ? ` Auto-resumes ${new Date(p.resumeAt).toLocaleString("en-GB")}.` : ""} (since ${now() > p.since ? new Date(p.since).toLocaleTimeString("en-GB") : "now"})`;
}
