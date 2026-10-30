#!/usr/bin/env node
// Prepares the demo: a local "remote" git repository with the task-tracker app (demo/task-tracker), ready to use as a
// project's repository in AgentStudio. Nothing leaves this computer.
//
//   npm run demo           create it (or say where it already is)
//   npm run demo -- --reset   start again from a clean copy
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "demo", "task-tracker");
const dataDir = process.env.ARM_DATA_DIR ? path.resolve(process.env.ARM_DATA_DIR) : path.join(root, "data");
const remote = path.join(dataDir, "demo", "task-tracker.git");
const reset = process.argv.includes("--reset");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

if (fs.existsSync(remote) && !reset) {
  console.log(`The demo repository already exists. Start again with: npm run demo -- --reset\n`);
} else {
  fs.rmSync(remote, { recursive: true, force: true });
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  // Commit a copy of the app in a scratch folder and push it, so the remote has a real history.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-demo-"));
  fs.cpSync(source, work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "-c", "user.name=AgentStudio demo", "-c", "user.email=demo@agentstudio.local", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Task tracker: create and list tasks");
  git(work, "push", "-q", pathToFileURL(remote).href, "main");
  fs.rmSync(work, { recursive: true, force: true });
  console.log("Demo repository created.\n");
}

console.log(`Repository URL (paste into New project → Git repository):\n  ${pathToFileURL(remote).href}\n`);
console.log(`Requirements (upload or paste into "Context for the team"):\n  ${path.join(root, "demo", "requirements.md")}\n`);
console.log("Checks the agents must pass: npm run lint, npm test, npm run build (detected from package.json).");
