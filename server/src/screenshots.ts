/**
 * Real screenshots of the project's Salesforce org, used by QA as test evidence in live mode.
 *
 * How: the Salesforce CLI mints a one-time login URL for a page in the org (`sf org open --url-only`), a headless
 * Google Chrome opens it in a fresh, throw-away browser context and a PNG is taken once the Lightning page settles.
 *
 * Safety: that login URL carries a session. It lives only in this function's memory — it is never logged, stored,
 * returned or included in an error message (every error is redacted). Only paths inside the org are accepted, so the
 * session can't be sent to another site. The browser uses the locally installed Chrome (`playwright-core` downloads
 * no browsers); `ARM_CHROME_PATH` points at a specific Chrome/Chromium binary.
 */
import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { sf } from "./sf.js";

export interface ScreenshotOptions {
  /** CLI alias of the org (the CLI keeps the login). */
  alias: string;
  /** A page inside the org, e.g. `/lightning/r/Case/500.../view`. */
  path: string;
  /** Wait until this text is visible before taking the screenshot. */
  waitForText?: string;
  fullPage?: boolean;
  viewport?: { width: number; height: number };
  /** Overall budget for loading the page (default 45 s). */
  timeoutMs?: number;
}

export interface Screenshot {
  png: Buffer;
  /** false when `waitForText` never appeared (the screenshot is still taken — it shows what was there instead). */
  textFound: boolean | null;
}

/** Chrome isn't available on this computer: the caller falls back to drawn evidence. */
export class ScreenshotUnavailable extends Error {}

const DEFAULT_TIMEOUT = 45_000;

/** Accepts only a path inside the org: `/…`, no scheme, no protocol-relative `//host`, no backslashes or whitespace. */
export function orgPath(raw: string) {
  const p = String(raw ?? "").trim();
  if (!p.startsWith("/") || p.startsWith("//") || /[\\\s]/.test(p) || /^\/*[a-z][a-z0-9+.-]*:/i.test(p) || p.includes("://")) {
    throw new Error(`Only pages inside the org are allowed (a path starting with /lightning/ or /), not: ${p.slice(0, 120)}`);
  }
  return p;
}

/** Removes anything that could carry the session from a message: the login URL itself and session-like parameters. */
export function redact(message: string, secret?: string | null) {
  let m = String(message ?? "");
  if (secret) m = m.split(secret).join("[login URL]");
  return m
    .replace(/https?:\/\/[^\s"'<>]*(frontdoor|secur\/|otp=|sid=|token)[^\s"'<>]*/gi, "[login URL]")
    .replace(/\b(sid|otp|access_token|token)=[^&\s"'<>]+/gi, "$1=[redacted]");
}

function launchOptions(): LaunchOptions {
  const exe = process.env.ARM_CHROME_PATH;
  return exe ? { executablePath: exe, headless: true } : { channel: "chrome", headless: true };
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch(launchOptions());
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split("\n").find((l) => l.trim()) ?? "";
    throw new ScreenshotUnavailable(
      `Google Chrome is not available on this computer, so no real screenshot can be taken (install Chrome or set ARM_CHROME_PATH). Use capture_evidence instead. (${redact(first).slice(0, 200)})`,
    );
  }
}

/** Whether a real screenshot can be taken here (launches and closes Chrome once). */
export async function chromeAvailable() {
  try {
    await (await launch()).close();
    return true;
  } catch {
    return false;
  }
}

/** One-time login URL for `path` in the org. Kept in memory only by the caller. */
async function loginUrl(alias: string, path: string) {
  const r = await sf(["org", "open", "--url-only", "--path", path, "--target-org", alias], undefined, 60_000);
  const url = r.status === 0 ? r.result?.url : null;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error(`The Salesforce CLI could not open ${alias}: ${redact(r.message ?? "no URL returned").slice(0, 200)}`);
  }
  return url;
}

export async function captureOrgScreenshot(o: ScreenshotOptions): Promise<Screenshot> {
  const path = orgPath(o.path);
  const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT;
  // Launch first: no session is minted when Chrome is missing.
  const browser = await launch();
  let url: string | null = null;
  try {
    url = await loginUrl(o.alias, path);
    const deadline = Date.now() + timeout;
    const left = () => Math.max(1_000, deadline - Date.now());
    // A fresh context: no cookies from (or to) anything else, discarded with the browser.
    const context = await browser.newContext({ viewport: o.viewport ?? { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: left() });
    // Lightning keeps background connections open, so "network idle" may never come: it is a best effort.
    await page.waitForLoadState("networkidle", { timeout: Math.min(left(), 20_000) }).catch(() => {});
    let textFound: boolean | null = null;
    if (o.waitForText) {
      textFound = await page
        .getByText(o.waitForText, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: left() })
        .then(() => true, () => false);
    }
    const png = await page.screenshot({ type: "png", fullPage: !!o.fullPage, timeout: left() });
    return { png, textFound };
  } catch (e) {
    throw new Error(`Screenshot failed: ${redact(e instanceof Error ? e.message : String(e), url).split("\n")[0].slice(0, 300)}`);
  } finally {
    url = null;
    await browser.close().catch(() => {});
  }
}
