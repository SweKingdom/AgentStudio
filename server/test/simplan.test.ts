import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_PDF } from "./setup.ts";
import { buildPlanFromText, classify, detectObject, extractPdfText, parseDocument, planStories } from "../src/agents/simplan.ts";

test("extracts text from the requirements PDF", async () => {
  const text = await extractPdfText(FIXTURE_PDF);
  assert.match(text, /Work Order Management/);
  assert.match(text, /SAP warehouse API/);
});

test("parses numbered sections, subsections and requirement bullets", async () => {
  const doc = parseDocument(await extractPdfText(FIXTURE_PDF));
  const titles = doc.sections.map((s) => s.title);
  assert.ok(titles.includes("Background"));
  assert.ok(titles.includes("Work Order Management"));
  const wom = doc.sections.find((s) => s.title === "Work Order Management")!;
  assert.deepEqual(wom.children.map((c) => c.title), ["Work order intake", "Scheduling and dispatch"]);
  assert.equal(wom.children[0].requirements.length, 3);
});

test("builds epics, features and stories from the document", async () => {
  const plan = buildPlanFromText(await extractPdfText(FIXTURE_PDF), "Nordic")!;
  assert.equal(plan.source, "document");
  assert.deepEqual(plan.epics.map((e) => e.title), ["Work Order Management", "Mobile Technician Experience", "Data Migration", "Integrations", "Reporting", "Security and Access"]);
  const stories = planStories(plan);
  assert.equal(stories.length, 19);
  const cats = new Set(stories.map((s) => s.category));
  for (const c of ["configuration", "development", "data_migration", "integration", "reporting", "security"]) assert.ok(cats.has(c), `missing ${c}`);
  assert.ok(plan.systems.includes("SAP"));
  assert.ok(plan.personas.includes("dispatcher"));
});

test("story wording is clean: no dangling words, one-sentence user story, testable ACs", async () => {
  const stories = planStories(buildPlanFromText(await extractPdfText(FIXTURE_PDF), "Nordic"));
  for (const s of stories) {
    assert.doesNotMatch(s.title, /\s(to|the|a|of|and|with|when|for)$/i, s.title);
    assert.ok(s.title.length <= 90, s.title);
    assert.match(s.user_story, /^As (a|an|the) .+, I want .+, so that .+\.$/);
    assert.ok(s.acs.length >= 1 && s.acs.length <= 4);
  }
  const titles = stories.map((s) => s.title);
  assert.ok(titles.includes("Select a reason when a job cannot be completed"));
  assert.ok(titles.includes("Appointments are never scheduled outside the technician’s working hours"));
});

test("flags ambiguities as questions and plants exactly one QA failure", async () => {
  const stories = planStories(buildPlanFromText(await extractPdfText(FIXTURE_PDF), "Nordic"));
  assert.ok(stories.filter((s) => s.question).length >= 2);
  assert.equal(stories.filter((s) => s.failsQaOnce).length, 1);
  assert.equal(stories.find((s) => s.failsQaOnce)!.category, "integration");
});

test("plain descriptions without headings still produce a plan; empty text does not", () => {
  const plan = buildPlanFromText("Sales reps must log calls from the mobile app. Managers need a weekly pipeline report. Leads must be assigned by region automatically.", "Sales");
  assert.ok(plan);
  assert.equal(planStories(plan).length, 3);
  assert.equal(buildPlanFromText("A scanned page with no text", "X"), null);
});

test("classifies categories and the main entity", () => {
  assert.equal(classify("Migrate customers from the legacy system"), "data_migration");
  assert.equal(classify("Send invoices to SAP via the API"), "integration");
  assert.equal(classify("Managers need a dashboard"), "reporting");
  assert.equal(classify("Users can create and delete todos"), "development");
  assert.equal(detectObject("schedule the appointment"), "Booking");
  assert.equal(detectObject("users can complete their todos"), "Todo");
  assert.equal(detectObject("unrelated words", "Thing"), "Thing");
});

test("a short description with 'can' sentences becomes a plan about its own domain", () => {
  const plan = buildPlanFromText("A small REST API for a todo list. Users can create, list, complete and delete todos. Completed todos can be filtered out.", "Todo");
  assert.ok(plan);
  const stories = planStories(plan);
  assert.equal(stories.length, 2);
  assert.ok(stories.every((s) => s.object === "Todo"));
  assert.ok(!JSON.stringify(plan).match(/Apex|Salesforce|__c|permission set/i), "nothing Salesforce-specific");
});
