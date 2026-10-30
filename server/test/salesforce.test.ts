import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addManualOrg, listOrgs, removeManualOrg, resolveTargetOrg } from "../src/salesforce.ts";
import { validateWorkspace } from "../src/agents/tools.ts";
import { defaultAgentFor } from "../src/agents/store.ts";
import type { Project } from "../src/store.ts";

const project = (targetOrg: string | null = null) =>
  ({ key: "TSF", mode: "simulation", agent_ids: [], settings: { gates: false, parallelism: 1, budgetUsd: 0, maxRework: 1, targetOrg } }) as unknown as Project;

test("the org registry starts empty and holds no credentials", () => {
  assert.deepEqual(listOrgs().orgs, []);
  addManualOrg({ alias: "CLIENT-DEV", type: "sandbox", instanceUrl: "https://client--dev.sandbox.my.salesforce.com" });
  addManualOrg({ alias: "CLIENT-PROD", type: "production" });
  const orgs = listOrgs().orgs;
  assert.deepEqual(orgs.map((o) => [o.alias, o.selectable]), [["CLIENT-DEV", true], ["CLIENT-PROD", false]]);
  for (const o of orgs) assert.deepEqual(Object.keys(o).sort(), ["alias", "allowProduction", "instanceUrl", "manual", "selectable", "status", "type", "username"]);
  // A production org (a Trailhead Playground, for example) becomes a target only when explicitly allowed.
  addManualOrg({ alias: "TRAILHEAD", type: "production", allowProduction: true });
  assert.equal(listOrgs().orgs.find((o) => o.alias === "TRAILHEAD")?.selectable, true);
  addManualOrg({ alias: "SANDBOX-FLAG", type: "sandbox", allowProduction: true });
  assert.equal(listOrgs().orgs.find((o) => o.alias === "SANDBOX-FLAG")?.allowProduction, false, "the flag only applies to production");
  removeManualOrg("TRAILHEAD");
  removeManualOrg("SANDBOX-FLAG");
});

test("project override wins over the release agent's default", () => {
  const helm = defaultAgentFor("release", { config: { targetOrg: "CLIENT-DEV" } });
  assert.equal(resolveTargetOrg(project(), helm)?.alias, "CLIENT-DEV");
  assert.equal(resolveTargetOrg(project(), helm)?.source, "agent");
  addManualOrg({ alias: "OTHER-UAT", type: "sandbox" });
  assert.equal(resolveTargetOrg(project("OTHER-UAT"), helm)?.source, "project");
  assert.equal(resolveTargetOrg(project(), defaultAgentFor("release")), null);
});

test("simulated release targets the org without contacting Salesforce; production is refused", async () => {
  const helm = defaultAgentFor("release", { config: { targetOrg: "CLIENT-DEV", deployMode: "validate", testLevel: "RunLocalTests" } });
  const ok = await validateWorkspace(project(), helm);
  assert.match(ok.mode, /^simulated check-only → CLIENT-DEV$/);
  assert.match(ok.output, /nothing was sent to Salesforce/);
  const prod = await validateWorkspace(project("CLIENT-PROD"), helm);
  assert.equal(prod.ok, false);
  assert.match(prod.output, /production org/);
  removeManualOrg("CLIENT-PROD");
  const unknown = await validateWorkspace(project("CLIENT-PROD"), helm);
  assert.match(unknown.output, /not a registered org/);
});
