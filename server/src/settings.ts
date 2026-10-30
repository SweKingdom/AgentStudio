import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, getSetting, setSetting } from "./db.js";

// Minimal .env loader (no dependency). Values already in process.env win.
const envPath = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envPath) && !process.env.ARM_DISABLE_DOTENV) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]] && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export type Mode = "live" | "simulation";

export interface AppSettings {
  /** Simulation (free, nothing leaves the machine) or Live (real Claude calls, billed). There is no automatic mode. */
  mode: Mode;
  currency: "USD" | "EUR";
  usdToEur: number;
  humanHourlyRateUsd: number;
  hoursPerStoryPoint: number;
  defaultParallelism: number;
  defaultBudgetUsd: number;
  defaultGates: boolean;
  maxRework: number;
  refusalFallback: boolean;
  simulationSpeed: number; // multiplier for simulated delays (1 = realistic-ish, 0.2 = fast)
  /** Spend caps across all projects (USD, 0 = none). Reaching one pauses all work. */
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  /** Resume automatically when the day/month rolls over. */
  autoResumeLimits: boolean;
  /** How live agents reach Claude: the API key in .env, or your own Claude plan via `claude /login` (Agent SDK). Auto picks the API when a key is set. */
  backend: Backend | "auto";
}

export type Backend = "api" | "subscription";

export const DEFAULT_SETTINGS: AppSettings = {
  mode: "simulation",
  currency: "USD",
  usdToEur: 0.92,
  humanHourlyRateUsd: 65,
  hoursPerStoryPoint: 6,
  defaultParallelism: 2,
  defaultBudgetUsd: 50,
  defaultGates: true,
  maxRework: 2,
  refusalFallback: true,
  simulationSpeed: 1,
  dailyLimitUsd: 0,
  monthlyLimitUsd: 0,
  autoResumeLimits: true,
  backend: "auto",
};

export function appSettings(): AppSettings {
  const s = { ...DEFAULT_SETTINGS, ...getSetting<Partial<AppSettings>>("app", {}) };
  // The old "auto" mode no longer exists: anything that isn't explicitly Live is Simulation.
  if (s.mode !== "live") s.mode = "simulation";
  return s;
}

export function saveAppSettings(patch: Partial<AppSettings>) {
  setSetting("app", { ...appSettings(), ...patch });
}

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function claudeBackend(): Backend {
  const b = appSettings().backend;
  if (b === "api" || b === "subscription") return b;
  return hasApiKey() ? "api" : "subscription";
}

/** The subscription backend relies on the machine's `claude /login`, which the doctor checks; the API backend needs a key. */
export function canRunLive() {
  if (claudeBackend() === "subscription") return !process.env.ARM_DISABLE_SUBSCRIPTION;
  return hasApiKey();
}

export function effectiveMode(): Mode {
  const s = appSettings();
  if (s.mode === "live" && !canRunLive()) return "simulation";
  return s.mode;
}
