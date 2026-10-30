import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceSection } from "../src/agents/tools.ts";
import { sections, toc } from "../src/agents/context.ts";

test("update_document_section replaces only its section, or appends it", () => {
  const doc = "# Manual\n\nIntro.\n\n## Cases\n\nOld text.\n\n### Detail\n\nKept? no.\n\n## Routing\n\nRouting text.\n";
  const out = replaceSection(doc, "Cases", "New text.");
  assert.match(out, /## Cases\n\nNew text\./);
  assert.doesNotMatch(out, /Old text/);
  assert.match(out, /## Routing\n\nRouting text\./, "other sections untouched");
  assert.match(out, /^# Manual\n\nIntro\./);
  const appended = replaceSection(out, "Reports", "Weekly report.");
  assert.match(appended, /## Routing[\s\S]*## Reports\n\nWeekly report\.\n$/);
  assert.equal(replaceSection(appended, "reports", "Changed."), replaceSection(appended, "Reports", "Changed."), "heading match ignores case");
});

test("documents expose a table of contents and sections", () => {
  const md = "# T\n\nSummary text here.\n\n## A\n\none\n\n### A.1\n\ntwo\n\n## B\n\nthree";
  assert.equal(toc(md), "- A\n  - A.1\n- B");
  assert.deepEqual(sections(md).map((s) => s.heading), ["", "A", "A.1", "B"]);
});
