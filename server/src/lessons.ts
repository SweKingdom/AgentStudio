/**
 * Lessons learned, per project: what QA, code review and the checks sent earlier stories back for, as short rules the
 * developer, QA and architect read on every later story — so a mistake that cost a rework round once isn't made again.
 *
 * Stored as an ordinary document (kind `project_lessons`), one Markdown bullet per lesson, newest last, each ending with
 * where it came from: `(US-121, qa)` or `(product owner)`.
 */
import type { Project } from "./store.js";

export const LESSONS_KIND = "project_lessons";
export const LESSONS_TITLE = "Lessons learned";
export const MAX_LESSONS = 20;
export const MAX_LESSON_CHARS = 200;
export const MAX_LESSONS_CHARS = 2500;

export interface Lesson {
  text: string;
  /** `US-121, qa`, `product owner`, or "" for a hand-written line without a tag. */
  source: string;
  /** Written by the product owner (or by hand without a tag): never dropped automatically. */
  manual: boolean;
}

/** Unset = on. */
export const lessonsEnabled = (project: Pick<Project, "settings">) => project.settings.lessons !== false;

const AUTO_TAG = /\s*\(([A-Z][A-Z0-9]*-\d+), (qa|review|checks)\)\s*$/;
const OWNER_TAG = /\s*\(product owner\)\s*$/i;

/** One lesson per non-empty line. Lines that don't parse are kept as manual lessons, so a hand edit is never lost. */
export function parseLessons(md: string): Lesson[] {
  const out: Lesson[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line) continue;
    const auto = line.match(AUTO_TAG);
    if (auto) out.push({ text: line.slice(0, auto.index).trim(), source: `${auto[1]}, ${auto[2]}`, manual: false });
    else if (OWNER_TAG.test(line)) out.push({ text: line.replace(OWNER_TAG, "").trim(), source: "product owner", manual: true });
    else out.push({ text: line, source: "", manual: true });
  }
  return out.filter((l) => l.text);
}

export function renderLessons(lessons: Lesson[]) {
  return lessons.map((l) => `- ${l.text}${l.source ? ` (${l.source})` : ""}`).join("\n");
}

/** At most MAX_LESSONS and about MAX_LESSONS_CHARS: the oldest automatic lessons go first; manual ones always stay. */
export function capLessons(lessons: Lesson[]): Lesson[] {
  const out = [...lessons];
  while (out.length > MAX_LESSONS || renderLessons(out).length > MAX_LESSONS_CHARS) {
    const oldest = out.findIndex((l) => !l.manual);
    if (oldest < 0) break;
    out.splice(oldest, 1);
  }
  return out;
}

/** Why a hand edit can't be saved (null = fine). Rejected rather than truncated, so nothing is lost silently. */
export function lessonsProblem(lessons: Lesson[]): string | null {
  if (lessons.length > MAX_LESSONS) return `At most ${MAX_LESSONS} lessons (this has ${lessons.length}). Remove the ones that matter least.`;
  const long = lessons.find((l) => l.text.length > MAX_LESSON_CHARS);
  if (long) return `Each lesson must be at most ${MAX_LESSON_CHARS} characters: "${long.text.slice(0, 60)}…" has ${long.text.length}.`;
  return null;
}
