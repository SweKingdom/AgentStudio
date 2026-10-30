// In-memory task store. The agents extend this module (and its tests) with the stories in the demo requirements.

const tasks = new Map();
let nextId = 1;

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

export function createTask(input = {}) {
  const title = String(input.title ?? "").trim();
  if (!title) throw new ValidationError("title", "Title is required.");
  if (title.length > 120) throw new ValidationError("title", "Title can be at most 120 characters.");
  const task = { id: nextId++, title, status: "Open", createdAt: new Date().toISOString() };
  tasks.set(task.id, task);
  return task;
}

export function listTasks() {
  return [...tasks.values()];
}

export function resetTasks() {
  tasks.clear();
  nextId = 1;
}
