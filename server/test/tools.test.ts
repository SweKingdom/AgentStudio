import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPackageXml } from "../src/agents/tools.ts";
import { estimateProject } from "../src/estimate.ts";
import { defaultAgentFor } from "../src/agents/store.ts";
import { PIPELINE_ROLES } from "../src/agents/roles.ts";

test("package.xml groups members by metadata type", () => {
  const xml = buildPackageXml([
    "force-app/main/default/classes/CaseService.cls",
    "force-app/main/default/classes/CaseService.cls-meta.xml",
    "force-app/main/default/objects/Case/fields/Level__c.field-meta.xml",
    "force-app/main/default/lwc/orderStatus/orderStatus.js",
    "force-app/main/default/lwc/orderStatus/orderStatus.html",
    "force-app/main/default/reports/Service_Reports/Open_Cases.report-meta.xml",
    "force-app/main/default/flows/Case_AfterSave_X.flow-meta.xml",
    "scripts/data/load.sh",
  ]);
  assert.match(xml, /<members>CaseService<\/members>\s*<name>ApexClass<\/name>/);
  assert.match(xml, /<members>Case\.Level__c<\/members>/);
  assert.match(xml, /<members>orderStatus<\/members>\s*<name>LightningComponentBundle<\/name>/);
  assert.match(xml, /<members>Service_Reports\/Open_Cases<\/members>/);
  assert.equal((xml.match(/<members>orderStatus<\/members>/g) ?? []).length, 1);
  assert.doesNotMatch(xml, /load\.sh/);
});

test("estimate grows with scope and team, and compares with a human team", () => {
  const team = PIPELINE_ROLES.map((r) => defaultAgentFor(r));
  const small = estimateProject({ agents: team, pdfPages: 2, pdfTokens: null, descriptionChars: 0, parallelism: 2, maxRework: 2 });
  const big = estimateProject({ agents: team, pdfPages: 10, pdfTokens: null, descriptionChars: 0, parallelism: 2, maxRework: 2 });
  const noDocs = estimateProject({ agents: team.filter((a) => a.role !== "writer"), pdfPages: 2, pdfTokens: null, descriptionChars: 0, parallelism: 2, maxRework: 2 });
  assert.ok(big.totalUsd > small.totalUsd);
  assert.ok(noDocs.totalUsd < small.totalUsd);
  assert.ok(small.lowUsd < small.totalUsd && small.totalUsd < small.highUsd);
  assert.ok(small.human.hours > 0 && small.speedup > 1);
  assert.equal(small.agents.length, PIPELINE_ROLES.length);
});
