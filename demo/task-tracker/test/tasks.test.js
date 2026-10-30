import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createTask, listTasks, resetTasks, ValidationError } from "../src/tasks.js";

beforeEach(() => resetTasks());

test("creates a task with status Open", () => {
  const t = createTask({ title: "Write the report" });
  assert.equal(t.status, "Open");
  assert.equal(listTasks().length, 1);
});

test("rejects a task without a title", () => {
  assert.throws(() => createTask({ title: "  " }), ValidationError);
  assert.equal(listTasks().length, 0);
});

test("rejects a title over 120 characters", () => {
  assert.throws(() => createTask({ title: "x".repeat(121) }), ValidationError);
});
