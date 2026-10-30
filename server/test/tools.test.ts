import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateProject } from "../src/estimate.ts";
import { defaultAgentFor } from "../src/agents/store.ts";
import { PIPELINE_ROLES } from "../src/agents/roles.ts";

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
