// What reaches the agents for an imported story: only the story fields they need, split out of Azure DevOps'
// description, without template leftovers or repeated text, under a size budget per role — and the shared (cached)
// part identical across stories. If a change makes a prompt bigger than this, this test says so.
import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { splitDescription, joinAcceptance } = await import("../src/adotext.ts");
const { mapAdoItem } = await import("../src/adoimport.ts");
const { contextFor, itemCard } = await import("../src/agents/context.ts");
const { defaultAgentFor } = await import("../src/agents/store.ts");
const { createItem, getProject, patchItem } = await import("../src/store.ts");
const { insert, now } = await import("../src/db.ts");

const SWEDISH = [
  "Som en säljare vill jag att formulär byggs från fältmetadata, så att varje fält valideras likadant.",
  "",
  "Bakgrund:",
  "Formulär och validering ska läsa samma metadata.",
  "TBD",
  "",
  "Affärsregler:",
  "- Obligatoriska fält markeras med en asterisk",
  "- [fyll i]",
  "",
  "Scenarier:",
  "Givet ett konto med obligatoriska fält",
  "När formuläret visas",
  "Så är de obligatoriska fälten markerade",
  "",
  "Depends on: #12140",
  "",
  "Utanför omfånget:",
  "- Redigering av metadata i gränssnittet",
].join("\n");

test("a Swedish template description splits into story fields, without leftovers or the Depends on line", () => {
  const p = splitDescription(SWEDISH);
  assert.equal(p.userStory, "Som en säljare vill jag att formulär byggs från fältmetadata, så att varje fält valideras likadant.");
  assert.equal(p.background, "Formulär och validering ska läsa samma metadata.", "TBD is dropped");
  assert.equal(p.businessRules, "- Obligatoriska fält markeras med en asterisk", "the [fyll i] placeholder is dropped");
  assert.equal(p.scenarios, "Givet ett konto med obligatoriska fält\nNär formuläret visas\nSå är de obligatoriska fälten markerade");
  assert.equal(p.dependencies, "");
  assert.equal(p.outOfScope, "- Redigering av metadata i gränssnittet");
});

test("an English description: headings with # or **, Given/When/Then without a heading, unknown sections kept", () => {
  const p = splitDescription("As a manager I want a weekly report.\n\n## Notes\nUses the ISO week.\n\n**Constraints:**\n- Read only\n\nGiven a team with open cases\nWhen the report runs\nThen it lists them per agent\n\nRollout\nBehind a feature flag.");
  assert.equal(p.userStory, "As a manager I want a weekly report.");
  assert.equal(p.businessRules, "- Read only");
  assert.match(p.scenarios, /^Given a team with open cases\nWhen the report runs\nThen it lists them per agent/);
  assert.match(p.background, /Uses the ISO week\./);
  assert.equal(splitDescription("Just one paragraph of text.").background, "Just one paragraph of text.", "no headings: it all stays as background");
  assert.equal(joinAcceptance("1. Shows the list", "Given x\nThen y"), "1. Shows the list\n\nGiven x\nThen y");
  assert.equal(joinAcceptance("Given x\nThen y", "Given x\nThen y"), "Given x\nThen y", "not repeated");
});

function project(key: string) {
  const ts = now();
  insert("projects", { id: `prj_${key}`, key, name: key, status: "ready", mode: "simulation", created_at: ts, updated_at: ts, settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1 } });
  return getProject(`prj_${key}`)!;
}

/** An imported story, through the real mapping: HTML description with a template, plus the acceptance criteria field. */
function importedStory(projectId: string, adoId: number, title: string) {
  const html = SWEDISH.split("\n").map((l) => (l ? `<p>${l}</p>` : "")).join("");
  const a = mapAdoItem({ id: adoId, rev: 1, fields: { "System.WorkItemType": "User Story", "System.Title": title, "System.State": "Backlog", "System.Description": html, "Microsoft.VSTS.Common.AcceptanceCriteria": "<ol><li>Forms read the metadata</li><li>Validation uses it</li></ol>", "System.AssignedTo": { displayName: "Philip Oxelius" }, "System.IterationPath": "Sirocco SAFe\\2026-23", "System.Tags": "Zephyr" }, dependsOnLinks: [] })!;
  return createItem(projectId, { type: "story", title: a.title, code: `US-${adoId}`, ado_id: adoId, user_story: a.userStory, background: a.background, business_rules: a.businessRules, acceptance_criteria: a.acceptance, dependencies: a.dependenciesText, out_of_scope: a.outOfScope, assignee: a.assignee, iteration: a.iteration, tags: a.tags });
}

test("the story card has each part once, no template leftovers, no Azure DevOps markup, and stays small", () => {
  const p = project("BUD");
  const dep = createItem(p.id, { type: "story", title: "Account data model", code: "US-12140" });
  const s = importedStory(p.id, 12146, "Field metadata layer");
  patchItem(s.id, { depends_on: [dep.code] });
  const card = itemCard({ ...s, depends_on: [dep.code] });
  for (const leftover of ["TBD", "[fyll i]", "<p>", "System.", "Microsoft.VSTS", "#12140"]) assert.ok(!card.includes(leftover), `no ${leftover}`);
  assert.equal(card.match(/Depends on/g)?.length, 1, "dependencies once, as story codes");
  assert.match(card, /### User story\nSom en säljare/);
  assert.match(card, /### Acceptance criteria\n- Forms read the metadata\n- Validation uses it\n\nGivet ett konto/);
  assert.match(card, /### Business rules\n- Obligatoriska fält/);
  assert.ok(card.length < 750, `the story card is ${card.length} characters (measured about 650)`);
});

test("each role gets what it needs within its budget, and the shared (cached) part is the same for every story", () => {
  const p = project("BDG");
  const a = importedStory(p.id, 13001, "Field metadata layer");
  const b = importedStory(p.id, 13002, "Account search");
  // Characters, per role: the run-specific part (story, review checklist, files) and the shared part. Measured sizes
  // plus about 15 %: a change that makes them clearly bigger has to update this on purpose.
  const budget: Record<string, { specific: number; shared: number }> = {
    developer: { specific: 1400, shared: 300 },
    qa: { specific: 1300, shared: 300 },
    writer: { specific: 850, shared: 300 },
    architect: { specific: 700, shared: 300 },
  };
  for (const [role, max] of Object.entries(budget)) {
    const agent = defaultAgentFor(role as "developer");
    const ca = contextFor(getProject(p.id)!, agent, a);
    const cb = contextFor(getProject(p.id)!, agent, b);
    assert.equal(ca.shared, cb.shared, `${role}: the shared part doesn't depend on the story, so it's read from cache`);
    assert.ok(!ca.shared.includes("Som en säljare"), `${role}: no story text in the shared part`);
    assert.ok(ca.specific.length <= max.specific, `${role}: run-specific context is ${ca.specific.length} characters (budget ${max.specific})`);
    assert.ok(ca.shared.length <= max.shared, `${role}: shared context is ${ca.shared.length} characters (budget ${max.shared})`);
  }
  // Roles that don't work on one story get one line per story, not the story text.
  for (const role of ["planner", "release"] as const) {
    const c = contextFor(getProject(p.id)!, defaultAgentFor(role));
    assert.ok(!`${c.shared}${c.specific}`.includes("Formulär och validering"), `${role}: no story bodies`);
  }
});
