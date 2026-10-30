import { Field } from "./Hint";

export type CodeReviewMode = "off" | "complex" | "all";

const HELP =
  "After QA approves a story, the architect reviews its code (the branch's diff) against the team's review checklist and the solution design. " +
  "Off: no review. Complex stories: integration, development and data migration stories only. All stories: every story, task and bug. " +
  "Requested changes go back to the developer, then QA re-tests and the architect reviews again (it counts toward the rework limit). " +
  "Costs one extra architect run per reviewed story (plus re-reviews).";

/** Project setting: optional architect code review on each story (settings.codeReview). */
export function CodeReviewField({ value, onChange }: { value: CodeReviewMode | undefined; onChange: (v: CodeReviewMode) => void }) {
  return (
    <Field label="Architect code review" help={HELP}>
      <select className="select" value={value ?? "off"} onChange={(e) => onChange(e.target.value as CodeReviewMode)}>
        <option value="off">Off</option>
        <option value="complex">Complex stories</option>
        <option value="all">All stories</option>
      </select>
    </Field>
  );
}
