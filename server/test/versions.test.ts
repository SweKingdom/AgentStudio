import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent, defaultAgentFor, getAgent, listVersions, restoreVersion, updateAgent } from "../src/agents/store.ts";

test("agent changes create versions; non-behavioural changes don't; restore creates a new version", () => {
  const a = createAgent(defaultAgentFor("developer", { id: "agt_test_dev" }));
  assert.equal(a.version, 1);
  const v2 = updateAgent(a.id, { custom_knowledge: "Always use the Selector pattern." })!;
  assert.equal(v2.version, 2);
  const same = updateAgent(a.id, { enabled: false, color: "#000000" })!;
  assert.equal(same.version, 2, "enabled/colour are not versioned");
  updateAgent(a.id, { model: "claude-sonnet-5-5", effort: "medium" });
  const versions = listVersions(a.id);
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  assert.deepEqual(versions[0].changed.sort(), ["effort", "model"]);
  const restored = restoreVersion(a.id, 1)!;
  assert.equal(restored.version, 4);
  assert.equal(restored.model, "claude-opus-5-5");
  assert.equal(restored.custom_knowledge, "");
  assert.equal(listVersions(a.id)[0].note, "Restored from v1");
  assert.equal(getAgent(a.id)!.enabled, false);
});
