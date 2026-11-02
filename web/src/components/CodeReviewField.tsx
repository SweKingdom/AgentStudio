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

/** Build plan step 5: what the design critique does, for the switch in New project and Project settings. */
export const DESIGN_CRITIQUE_HELP =
  "Before planning, a critic (QA when it's on the team, not the architect who wrote it) reviews the solution design from three perspectives — architecture; security and data; delivery and testability — and can send it back to the architect once. A few calls per project, not per story. The plan is then checked against the design without a model call.";

export const LESSONS_HELP = "After a story needs rework, write down what later stories should do differently.";
