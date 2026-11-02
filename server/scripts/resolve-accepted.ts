// `npm run resolve-accepted -w server [-- --dry-run]` — one-off: answers open deviation / reinterpretation questions
// the product owner already accepted for the same story and AC in an earlier answer. Before the fix, every re-run asked
// them again; those copies stay open until answered, so this answers them, citing the earlier question.
import { all, now, run } from "../src/db.js";
import { getItem, openQuestionCount, patchItem } from "../src/store.js";
import { acOfQuestion, priorAcDecision } from "../src/questions.js";

const dryRun = process.argv.includes("--dry-run");
const open = all<{ id: number; project_id: string; item_id: string; question: string; code: string }>(
  "SELECT q.id, q.project_id, q.item_id, q.question, w.code FROM questions q JOIN work_items w ON w.id = q.item_id WHERE q.answer IS NULL OR q.answer = '' ORDER BY q.id",
);
let answered = 0;
for (const q of open) {
  const ac = acOfQuestion(q.question, q.code);
  if (ac === null) continue;
  const prior = priorAcDecision(q.project_id, q.item_id, q.code, ac);
  if (!prior?.accepted) {
    console.log(`  #${q.id} ${q.code} ${ac}: ${prior ? `newest answer (#${prior.id}) doesn't accept it` : "never answered"} — left open`);
    continue;
  }
  console.log(`✅ #${q.id} ${q.code} ${ac}: already accepted in question #${prior.id} ("${prior.answer.slice(0, 80)}")${dryRun ? " — dry run, not saved" : ""}`);
  answered++;
  if (dryRun) continue;
  run("UPDATE questions SET answer = ?, reasoning = ?, answered_at = ? WHERE id = ?", `Accepted — already accepted by the product owner in question #${prior.id}.`, `Earlier answer: ${prior.answer}`, now(), q.id);
  // As when the product owner answers in the app: a story that only waited for its answers can be refined again.
  const it = getItem(q.item_id);
  if (it?.state === "Requires additional information" && openQuestionCount(it.id) === 0) patchItem(it.id, { state: "Ready for Refinement" });
}
console.log(`\n${answered} question(s) ${dryRun ? "would be answered" : "answered"}, ${open.length - answered} other open question(s) left as they are.`);
