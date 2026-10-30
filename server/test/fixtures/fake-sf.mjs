#!/usr/bin/env node
// Stand-in for the Salesforce CLI used by tests: answers like `sf … --json` and logs every call. Never touches an org.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.ARM_FAKE_SF_LOG) fs.appendFileSync(process.env.ARM_FAKE_SF_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\n");
const flag = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const out = (o, code = 0) => {
  process.stdout.write(JSON.stringify(o));
  process.exit(code);
};
if (args[0] === "--version") {
  process.stdout.write("@salesforce/cli/2.0.0-fake test\n");
  process.exit(0);
}
const cmd = args.slice(0, 3).join(" ");

if (cmd.startsWith("data query")) {
  const q = flag("--query")[0] ?? "";
  if (/FROM Organization/i.test(q)) out({ status: 0, result: { totalSize: 1, done: true, records: [{ attributes: { type: "Organization" }, Id: "00D000000000001", Name: "Demo Playground", OrganizationType: "Developer Edition", IsSandbox: false, InstanceName: "EU45", TrialExpirationDate: null }] } });
  out({ status: 0, result: { totalSize: 2, done: true, records: [{ attributes: { type: "Case" }, Id: "5001", Subject: "A" }, { attributes: { type: "Case" }, Id: "5002", Subject: "B" }] } });
}
if (cmd.startsWith("sobject describe")) {
  out({ status: 0, result: { name: flag("--sobject")[0], label: "Case", custom: false, recordTypeInfos: [{ master: true, name: "Master" }], fields: [{ name: "Id", label: "Case ID", type: "id", nillable: false, createable: false }, { name: "Subject", label: "Subject", type: "string", length: 255, nillable: true, createable: true }, { name: "Priority", label: "Priority", type: "picklist", nillable: true, createable: true, picklistValues: [{ value: "High", active: true }, { value: "Low", active: true }] }] } });
}
if (cmd === "project deploy start" || cmd === "project deploy validate") {
  const dirs = flag("--source-dir");
  const files = dirs.flatMap((d) => {
    const abs = path.resolve(process.cwd(), d);
    if (!fs.existsSync(abs)) return [];
    return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).map((f) => path.join(abs, f)) : [abs];
  });
  const text = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const tests = flag("--tests");
  if (text.includes("COMPILE_ERROR")) {
    const bad = files.find((f) => fs.readFileSync(f, "utf8").includes("COMPILE_ERROR"));
    out({ status: 1, name: "FailedDeployError", message: "Deploy failed.", result: { status: "Failed", success: false, numberComponentsDeployed: 0, details: { componentFailures: [{ fileName: path.relative(process.cwd(), bad), lineNumber: 3, columnNumber: 9, componentType: "ApexClass", problem: "Variable does not exist: COMPILE_ERROR" }], runTestResult: { numTestsRun: 0 } } } }, 1);
  }
  if (text.includes("FAIL_TEST")) {
    out({ status: 1, message: "Deploy failed.", result: { status: "Failed", success: false, numberComponentsDeployed: files.length, details: { componentFailures: [], runTestResult: { numTestsRun: tests.length, failures: [{ name: tests[0], methodName: "testIt", message: "System.AssertException: Assertion Failed" }] } } } }, 1);
  }
  out({ status: 0, result: { id: "0Af000000000001", status: "Succeeded", success: true, numberComponentsDeployed: Math.max(files.length, 1), numberTestsCompleted: tests.length, details: { componentFailures: [], runTestResult: { numTestsRun: Math.max(tests.length, args.includes("--manifest") ? 4 : 0), failures: [], codeCoverage: tests.map((t) => ({ name: t.replace(/_?Test$/, ""), numLocations: 20, numLocationsNotCovered: 2 })) } } } });
}
// Quick deploy of a release validated before (production after the approval).
if (cmd === "project deploy quick") out({ status: 0, result: { id: flag("--job-id")[0], status: "Succeeded", success: true, numberComponentsDeployed: 3, details: { componentFailures: [], runTestResult: { numTestsRun: 0 } } } });
if (cmd === "apex run --file") out({ status: 0, result: { compiled: true, success: true, logs: "USER_DEBUG|[1]|DEBUG|smoke ok" } });
if (cmd.startsWith("org open")) {
  // A one-time "login" URL: tests point it at a local page; the path asked for is appended like the real CLI does.
  const base = process.env.ARM_FAKE_SF_OPEN_URL;
  if (!base) out({ status: 1, message: "fake sf: ARM_FAKE_SF_OPEN_URL is not set" }, 1);
  out({ status: 0, result: { orgId: "00D000000000001", username: "demo@example.com", url: `${base}${base.includes("?") ? "&" : "?"}retURL=${encodeURIComponent(flag("--path")[0] ?? "/")}` } });
}
if (cmd === "org login web") out({ status: 0, result: { username: "demo@example.com" } });
out({ status: 1, message: `fake sf: unsupported ${cmd}` }, 1);
