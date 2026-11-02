/**
 * Fewer questions to the product owner: before an agent asks, AgentStudio looks for the same question already asked in
 * the project. An answered one is reused (the agent gets the answer), an open one is shared (the new story waits for
 * the same answer) — compared by the words they share, locally, without calling Claude.
 */
import { all, run } from "./db.js";
import { addQuestion, answerText } from "./store.js";

/** Words that say nothing about what is asked (English and Swedish). */
const STOP = new Set(
  "a an and are as at be by can could do does for from has have how i if in is it its may might must of on or our shall should so than that the their them then there these they this to us was we were what when where which who whom why will with would you your about any all also into only other such each else please ok yes no och att det som en ett är för på med av till den de om eller inte ska skall kan vi ni hur vad när var vilken vilka vilket".split(
    " ",
  ),
);

/** The content words of a text, lower-cased and roughly stemmed, so plurals and tenses match. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Bookings → booking → book, times → time: suffixes come off until none is left (never below 3 letters). */
function stem(word: string) {
  let w = word;
  for (;;) {
    const next = w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.replace(/(ing|ed|s)$/, "");
    if (next === w || next.length < 3 || next.endsWith("s") && w.endsWith("ss")) return w;
    w = next;
  }
}

/** How alike two questions are, 0–1: the share of the shorter question's words the other one also has, weighed with
 *  how much they share overall (so a short question inside a long one counts, but two long ones need real overlap). */
export function similarity(a: string, b: string) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size < 2 || B.size < 2) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const overlap = shared / Math.min(A.size, B.size);
  const jaccard = shared / (A.size + B.size - shared);
  return (overlap + jaccard) / 2;
}

export const SIMILAR = 0.6;

interface QuestionRow {
  id: number;
  question: string;
  answer: string | null;
  reasoning: string | null;
  item_id: string | null;
  also_items: string;
}

export type Asked =
  | { kind: "new"; id: number }
  | { kind: "answered"; id: number; question: string; answer: string; score: number }
  | { kind: "open"; id: number; question: string; score: number };

/** Ask the product owner — unless the same question was already asked in this project. */
export function askOnce(projectId: string, question: string, itemId: string | null, askedBy: string): Asked {
  const rows = all<QuestionRow>("SELECT id, question, answer, reasoning, item_id, also_items FROM questions WHERE project_id = ? ORDER BY id DESC", projectId);
  let best: { row: QuestionRow; score: number } | null = null;
  for (const row of rows) {
    const score = similarity(question, row.question);
    if (score >= SIMILAR && (!best || score > best.score)) best = { row, score };
  }
  if (best?.row.answer?.trim()) {
    return { kind: "answered", id: best.row.id, question: best.row.question, answer: answerText({ answer: best.row.answer, reasoning: best.row.reasoning }), score: best.score };
  }
  if (best) {
    // Merged into the open question: the new story waits for the same answer.
    const also = JSON.parse(best.row.also_items || "[]") as string[];
    if (itemId && itemId !== best.row.item_id && !also.includes(itemId)) run("UPDATE questions SET also_items = ? WHERE id = ?", JSON.stringify([...also, itemId]), best.row.id);
    return { kind: "open", id: best.row.id, question: best.row.question, score: best.score };
  }
  return { kind: "new", id: addQuestion(projectId, question, itemId, askedBy) };
}
