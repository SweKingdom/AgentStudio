/**
 * Simulation planning from the real requirements document (no API calls).
 * The PDF text is extracted locally and parsed into sections and requirements; a deterministic set of rules turns
 * it into epics → features → stories with personas, categories, acceptance criteria, open questions and a tech spec.
 */
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { projectDir, type Project } from "../store.js";

export interface SimStory {
  title: string;
  type: "story" | "task";
  category: string;
  points: number;
  /** Why it got those points: base by type, then each modifier (shown in the estimate). */
  pointsWhy?: string[];
  moscow: "Must" | "Should" | "Could";
  user_story: string;
  background: string;
  rules: string[];
  acs: [string, string][];
  spec: string;
  object?: string;
  dependsOn?: string[];
  question?: string;
  failsQaOnce?: string;
  source?: string;
}

export interface SimFeature {
  title: string;
  category: string;
  stories: SimStory[];
}

export interface SimEpic {
  title: string;
  background: string;
  features: SimFeature[];
}

export interface SimPlan {
  source: "document" | "sample";
  docTitle: string;
  intro: string;
  personas: string[];
  objects: string[];
  systems: string[];
  nfrs: string[];
  epics: SimEpic[];
}

// ---------------------------------------------------------------- text extraction

export async function extractPdfText(file: string): Promise<string> {
  return (await readPdf(file)).text;
}

/** Text and real page count of a PDF (works on compressed, modern PDFs). */
export async function readPdf(file: string): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}

// ---------------------------------------------------------------- document structure

export interface Section {
  num: string;
  title: string;
  paragraphs: string[];
  requirements: string[];
  children: Section[];
}

const HEADING = /^(\d+(?:\.\d+)*)\.?\s+([A-Z][^.!?]{2,80})$/;
const BULLET = /^\s*(?:[-•*–▪◦]|\(?[a-z]\)|\d+\))\s+(.*)$/;
const REQ = /\b(must|shall|should|needs? to|need|has to|have to|may only|must not|will need|is required|are required|cannot|can't)\b/i;
/** Sentences that record a pending decision or a limit of scope, not work to do — kept as context, not as stories. */
const NOT_WORK = /\b(to be (decided|defined|confirmed|agreed)|not (yet |fully )?(defined|decided|fixed|confirmed|agreed)|must be confirmed|(does|do) not need|is not needed|are not needed|not needed|could be enough|is enough|out of scope|will come later|not in scope)\b/i;

export function parseDocument(text: string): { title: string; sections: Section[]; preamble: string[] } {
  const raw = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  // Re-join wrapped lines: a line that is not a heading or bullet continues the previous one.
  const lines: string[] = [];
  for (const l of raw) {
    if (!l) {
      lines.push("");
      continue;
    }
    const prev = lines[lines.length - 1];
    const isNew = HEADING.test(l) || BULLET.test(l) || !prev || HEADING.test(prev) || /[.:!?]$/.test(prev);
    if (isNew) lines.push(l);
    else lines[lines.length - 1] = `${prev} ${l}`;
  }

  // The first short, non-requirement line is the document title (a one-paragraph description has none).
  const first = lines.find((l) => l && !HEADING.test(l));
  const title = first && first.length <= 120 && !REQ.test(first) ? first : "Requirements";
  const root: Section = { num: "", title: "root", paragraphs: [], requirements: [], children: [] };
  const stack: Section[] = [root];
  const preamble: string[] = [];
  for (const l of lines) {
    if (!l) continue;
    const h = l.match(HEADING);
    if (h) {
      const depth = h[1].split(".").length;
      const s: Section = { num: h[1], title: h[2].trim(), paragraphs: [], requirements: [], children: [] };
      while (stack.length > depth) stack.pop();
      stack[stack.length - 1].children.push(s);
      stack.push(s);
      continue;
    }
    const cur = stack[stack.length - 1];
    const b = l.match(BULLET);
    const body = b ? b[1] : l;
    if (cur === root) {
      if (l !== title) preamble.push(body);
      continue;
    }
    if (b || REQ.test(body)) {
      // Paragraphs can hold several requirement sentences.
      const sentences = b ? [body] : body.split(/(?<=[.!?])\s+(?=[A-Z])/);
      for (const sentence of sentences) {
        if (REQ.test(sentence) && sentence.length > 20 && !NOT_WORK.test(sentence)) cur.requirements.push(sentence.replace(/\s*\.$/, ""));
        else cur.paragraphs.push(sentence);
      }
    } else cur.paragraphs.push(body);
  }
  // Plain text without numbered headings (e.g. a project description): treat it as one requirements section.
  if (!root.children.length) {
    const sentences = preamble.flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z])/));
    const reqs = sentences.filter((x) => REQ.test(x) && x.length > 20).map((x) => x.replace(/\s*\.$/, ""));
    if (reqs.length) {
      root.children.push({ num: "1", title: "Requirements", paragraphs: sentences.filter((x) => !reqs.includes(x.replace(/\s*\.$/, ""))), requirements: reqs, children: [] });
      return { title, sections: root.children, preamble: [] };
    }
  }
  return { title, sections: root.children, preamble };
}

// ---------------------------------------------------------------- classification helpers

const CONTEXT_SECTIONS = /^(background|introduction|overview|purpose|scope|context|glossary|definitions|document|revision|appendix|assumptions|about)/i;

const CATEGORY_RULES: [string, RegExp][] = [
  ["data_migration", /\b(migrat\w*|legacy|import\w*|duplicates?|de-?dup\w*|historic(al)? data|service history|cut-?over)\b/i],
  ["integration", /\b(integrat\w*|api|sap|erp|webhook|middleware|sync\w*|sent to|send to \w+ system|external system|real[- ]time against|callout)\b/i],
  ["reporting", /\b(dashboards?|reports?|kpis?|metrics?|analytics)\b/i],
  ["security", /\b(permission\w*|access|security|only see|profiles?|sharing|visibility rules?|must not access|roles?)\b/i],
  ["script", /\b(one-off|batch job|clean-?up|bulk update|scheduled job|script)\b/i],
  ["development", /\b(offline|mobile|signature|photos?|custom (screen|component|ui)|lwc|gantt|calculate\w*|algorithm)\b/i],
  ["configuration", /\b(sms|email|notif\w*|flag\w*|priority|picklist|fields?|layout|automatic\w*|derived|validation|status|queue|assign\w*|create\w* .* from)\b/i],
];

/** Starting points per story type (before modifiers). */
export const BASE_POINTS: Record<string, number> = { integration: 8, data_migration: 5, development: 5, configuration: 3, reporting: 2, security: 2, script: 2 };

export function classify(text: string) {
  return classifyWhy(text).category;
}

/** The type and the word that decided it (shown in the estimate). */
export function classifyWhy(text: string): { category: string; match: string | null } {
  for (const [cat, re] of CATEGORY_RULES) {
    const m = text.match(re);
    if (m) return { category: cat, match: m[0] };
  }
  return { category: "development", match: null };
}

const PERSONAS = [
  "customer service agent", "service agent", "dispatcher", "technician", "service manager", "team lead", "manager", "administrator",
  "admin", "customer", "sales rep", "sales manager", "account manager", "finance team", "quality team", "partner", "support team",
  "agent", "user", "data owner",
];

function findPersona(text: string): string | null {
  const t = text.toLowerCase();
  for (const p of PERSONAS) if (new RegExp(`\\b${p}s?\\b`).test(t)) return p;
  return null;
}

const OBJECT_RULES: [string, RegExp][] = [
  ["ServiceAppointment", /\b(appointments?|dispatch\w*|arrival window|gantt|schedul\w*)\b/i],
  ["WorkOrder", /\bwork orders?|jobs?\b/i],
  ["Case", /\bcases?|tickets?\b/i],
  ["Asset", /\bappliances?|assets?|equipment|devices?\b/i],
  ["ProductItem", /\b(spare )?parts?|stock|inventory\b/i],
  ["ServiceResource", /\btechnicians?|resources?|crews?\b/i],
  ["ServiceTerritory", /\bterritor(y|ies)|regions?\b/i],
  ["Opportunity", /\bopportunit(y|ies)|deals?\b/i],
  ["Lead", /\bleads?\b/i],
  ["Quote", /\bquotes?\b/i],
  ["Order", /\borders?\b/i],
  ["Contract", /\bcontracts?|warrant(y|ies)\b/i],
  ["Account", /\bcustomers?|accounts?|companies\b/i],
  ["Contact", /\bcontacts?\b/i],
];

export function detectObject(text: string, fallback = "Account") {
  for (const [obj, re] of OBJECT_RULES) if (re.test(text)) return obj;
  return fallback;
}

function detectSystems(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]{1,15}|[A-Z]{2,6})\b(?=[^.]{0,40}\b(api|system|warehouse|erp|integration|platform|crm)\b)/gi)) {
    const w = m[1];
    if (/^(The|This|All|If|When|Every|A|An|Salesforce|Customer|System|Data|Spare|Completed|Open)$/i.test(w)) continue;
    if (w === w.toUpperCase() || /Max|SAP|ERP|Oracle|Dynamics|NetSuite|Fortnox|Workday/.test(w)) out.add(w);
  }
  return [...out].slice(0, 6);
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const STOP_END = /\s+(to|the|a|an|of|for|with|and|or|on|in|by|when|before|after|if|from|at|is|are)$/i;

function trimTitle(s: string, max = 84) {
  let t = s.split(/(?<=[a-z0-9)])\.\s+|;\s*/)[0].replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const comma = t.indexOf(", ", 24);
  if (t.length > max && comma > 0 && comma < max) t = t.slice(0, comma);
  if (t.length > max) {
    let cut = -1;
    for (const b of [" when ", " before ", " after ", " so that ", " with ", " by ", " and ", " in the "]) {
      const i = t.lastIndexOf(b, max);
      if (i >= 24 && i > cut) cut = i;
    }
    t = cut > 0 ? t.slice(0, cut) : t.slice(0, t.lastIndexOf(" ", max));
  }
  while (STOP_END.test(t)) t = t.replace(STOP_END, "");
  return cap(t.replace(/[,;:]$/, "").replace(/^(a|an|the)\s+/i, ""));
}

const STRONG_MODAL = /^(.*?)\b(must not|shall not|should not|may only|must|shall|should|needs? to|need|needs|has to|have to|is required to|are required to|will need to)\b\s*(?:be able to\s+)?(.*)$/i;
const WEAK_MODAL = /^(.*?)\b(cannot|can't|can)\b\s*(.*)$/i;

/** "Dispatchers must see all X" → { actor: "Dispatchers", action: "see all X" }. Leading "When/If …" clauses become the condition. */
function splitRequirement(req: string) {
  const m = req.match(STRONG_MODAL) ?? req.match(WEAK_MODAL);
  if (!m) return { actor: "", modal: "", action: req, negative: false, condition: "", passive: false };
  let actor = m[1].trim().replace(/,$/, "");
  let condition = "";
  const cond = actor.match(/^(when|if|once|after|before|whenever)\s+(.+?)\s+((?:the|a|an|each|every|all)\s+[\w\s-]+|[A-Z][\w-]*(?:\s[\w-]+)?)$/i);
  if (cond) {
    condition = `${cond[1].toLowerCase()} ${cond[2]}`;
    actor = cond[3];
  }
  const action = m[3].trim();
  const modal = m[2].toLowerCase();
  return { actor, modal, action, negative: /not|cannot|only/.test(modal), condition, passive: /^(be|have been|have)\s/i.test(action) };
}

function conjugate(verb: string, plural: boolean) {
  if (plural) return verb === "be" ? "are" : verb;
  if (verb === "be") return "is";
  if (verb === "have") return "has";
  return /(s|sh|ch|x|z)$/.test(verb) ? `${verb}es` : /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`;
}

function toPresent(subject: string, modal: string, action: string) {
  const subj = subject.replace(/\s*\(.*?\)\s*/g, " ").replace(/^(the|every|each|all|any)\s+/i, "").trim();
  // The head noun decides: "New leads from the website" is plural because of "leads", not "website".
  const head = subj.split(/\s+(?:from|of|in|with|for|on|at|by|that|which|who)\s+/i)[0];
  const plural = (/s$/i.test(head.split(" ").pop() ?? "") && !/\b(status|process|business|address|access)$/i.test(head)) || /\band\b/.test(head) || /^(they|we|you)$/i.test(head);
  const words = action.split(" ");
  const first = words[0] ?? "";
  // "… and <verb>" gets conjugated; nouns in a list ("customers, supply points and contracts") are left alone.
  const rest = words.slice(1).join(" ").replace(/(,?[^,]*?)\band (\w+)\b(?=\s+(?:the|a|an|it|them|their|its|to|all|each|every|this|that)\b|$)/g, (m, before: string, v: string) =>
    /^(the|a|an|their|its|all|any|other)$/.test(v) || plural || /s$/.test(v) || /,/.test(before) ? m : `${before}and ${conjugate(v, false)}`,
  );
  let verb = conjugate(first, plural);
  if (/not|cannot/.test(modal)) verb = first === "be" ? `${plural ? "are" : "is"} never` : `never ${first}`;
  else if (/only/.test(modal)) verb = `only ${verb}`;
  return `${subj} ${verb} ${rest}`.trim();
}

function storyTitle(req: string) {
  const { actor, modal, action, condition, passive } = splitRequirement(req);
  let t: string;
  if (!modal) t = req;
  else if (/^needs?$/.test(modal) && !/^to\s/.test(action)) {
    const persona = findPersona(actor);
    const noun = action.split(/;|,| with /)[0];
    t = persona && noun.length < 40 ? `${noun} for ${actor.toLowerCase()}` : action;
  } else if ((findPersona(actor) && !passive) || /^(we|users?)$/i.test(actor)) t = action.split(/ and the system | and then /)[0];
  else if (/^the system$|^system$/i.test(actor) || !actor) t = toPresent("System", modal, action);
  else t = toPresent(actor, modal, action);
  if (condition) t = `${trimTitle(t, 56)} ${condition}`;
  return trimTitle(t);
}

const BENEFIT: Record<string, string> = {
  data_migration: "no customer history is lost when we switch systems",
  integration: "nobody has to re-enter data between systems",
  reporting: "I can act on facts instead of spreadsheets",
  security: "people only see and change what they should",
  script: "the change is repeatable and verifiable",
  development: "the work gets done faster and with fewer mistakes",
  configuration: "the process runs with fewer manual steps",
};

const PERSONA_BY_CATEGORY: Record<string, string> = {
  data_migration: "migration lead",
  integration: "service manager",
  reporting: "service manager",
  security: "administrator",
  script: "administrator",
};

function asPersona(p: string) {
  return /team$/.test(p) ? `As the ${p}` : /^[aeiou]/i.test(p) ? `As an ${p}` : `As a ${p}`;
}

function wantPhrase(req: string) {
  const { actor, action, negative, modal, condition, passive } = splitRequirement(req);
  const cond = condition ? `, ${condition}` : "";
  if (!modal) return `${req.charAt(0).toLowerCase()}${req.slice(1)}`;
  if (/^needs?$/.test(modal) && !/^to\s/.test(action)) return `${action.charAt(0).toLowerCase()}${action.slice(1)}`;
  if (findPersona(actor) && !passive) return negative ? `to be sure that ${actor.toLowerCase()} ${modal.includes("only") ? "only" : "never"} ${action}${cond}` : `to ${action}${cond}`;
  const subj = actor ? actor.replace(/^([A-Z])([a-z])/, (_m, a: string, b: string) => a.toLowerCase() + b) : "the system";
  return `${subj} to ${negative && !modal.includes("only") ? "never " : modal.includes("only") ? "only " : ""}${action}${cond}`;
}

function acceptanceCriteria(req: string, category: string, object: string): [string, string][] {
  const { negative } = splitRequirement(req);
  const main: [string, string] = [trimTitle(storyTitle(req), 52), `${cap(req)}.`];
  const acs: [string, string][] = [main];
  const lower = req.toLowerCase();
  const values = req.match(/\(([^)]+,[^)]+)\)/)?.[1];
  if (values) acs.push(["Allowed values", `Only these values are possible: ${values.split(",").map((v) => `\`${v.trim()}\``).join(", ")}. Any other value is rejected.`]);
  const within = lower.match(/within (\d+ \w+)/);
  if (within) acs.push(["Timing", `The outcome happens within ${within[1]} in 95 % of cases; slower cases are logged.`]);
  if (/unavailable|fails?|error|retry/.test(lower) || category === "integration") {
    acs.push(["Failure handling", "When the external system does not answer, the request is retried with back-off, the user sees a clear message and the support team is alerted after the last attempt."]);
  }
  if (negative && !/only/.test(lower)) acs.push(["Negative path", `A user or process that tries to break the rule is stopped with a clear error message and nothing is saved.`]);
  if (/only/.test(lower)) acs.push(["Access is restricted", "A user outside the allowed group cannot see or open the records (checked with a test user)."]);
  switch (category) {
    case "data_migration":
      acs.push(["Re-runnable load", `Loading the same file twice creates no duplicates: ${object} records are upserted on \`Legacy_Id__c\`.`]);
      acs.push(["Counts reconcile", "Record counts per object match the source extract minus the documented rejects."]);
      break;
    case "reporting":
      acs.push(["Per-team view", "Each manager sees the figures for their own territory/team by default and can filter by period."]);
      break;
    case "security":
      acs.push(["Granted by permission set", "Access comes only from the documented permission set — no profile changes."]);
      break;
    case "development":
    case "configuration":
      if (acs.length < 3) acs.push(["Bulk safe", `Creating or updating 200 ${object} records in one transaction works without hitting limits.`]);
      break;
  }
  return acs.slice(0, 4);
}

function techSpec(category: string, object: string, title: string, systems: string[]) {
  const name = title.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 3).map(cap).join("");
  const sys = systems[0] ?? "External";
  const rows: Record<string, string[]> = {
    configuration: [`| \`${object}_AfterSave_${name}\` | Record-triggered flow | Entry condition on the changed fields of ${object} |`, `| \`${object}.${name}_Status__c\` | Field (Text 80) | Result of the automation |`],
    development: [`| \`${name}Service\` | Apex service | Bulk-safe logic for ${object} |`, `| \`${object}Trigger\` / \`${object}TriggerHandler\` | Apex trigger + handler | Delegates to the service |`, `| \`${name}ServiceTest\` | Apex test | Positive, negative and 200-record bulk |`],
    integration: [`| \`${sys}_API\` | Named Credential | Endpoint and auth managed by admins |`, `| \`${sys}${name}Client\` | Apex callout | Timeout 10 s, retries with back-off |`, `| \`Integration_Outbox__c\` | Custom object | Transactional outbox for retries and error write-back |`],
    data_migration: [`| \`${object}.Legacy_Id__c\` | Field (Text 40, External Id, unique) | Upsert key |`, "| `scripts/data/*-upsert.sh` | Load scripts | Bulk API 2.0, parent-before-child |", "| `Bypass_Automation` | Custom permission | Bypasses triggers/flows for the migration user |"],
    reporting: [`| \`${name}_Report\` | Report | Summary report on ${object} |`, `| \`${name}_Dashboard\` | Dynamic dashboard | Runs as the logged-in user |`],
    security: [`| \`${name}_Access\` | Permission set | Object, field and tab access |`, `| Sharing rule on ${object} | Sharing | Restricts visibility by territory/team |`],
    script: [`| \`scripts/apex/${name}.apex\` | Anonymous Apex | Idempotent, logs what it changed |`],
  };
  return `| Component | Type | Notes |\n|---|---|---|\n${(rows[category] ?? rows.development).join("\n")}`;
}

function questionFor(req: string): string | null {
  const l = req.toLowerCase();
  if (/\btbd\b|to be (confirmed|decided|defined)|tbc/.test(l)) return `The document says "${trimTitle(req, 90)}" — what exactly is the rule, and who decides it?`;
  if (/approx\.?|around|roughly/.test(l)) return `"${trimTitle(req, 90)}" gives an approximate figure — what is the exact scope and volume we should plan for?`;
  if (/\betc\b|and so on/.test(l)) return `"${trimTitle(req, 90)}" ends with "etc." — can you list every case that must be covered?`;
  return null;
}

// ---------------------------------------------------------------- plan

export function buildPlanFromText(text: string, projectName: string): SimPlan | null {
  const doc = parseDocument(text);
  const work = doc.sections.filter((s) => !CONTEXT_SECTIONS.test(s.title));
  const intro = [
    ...doc.preamble.filter((p) => !/^version|^prepared|^page \d/i.test(p)),
    ...doc.sections.filter((s) => CONTEXT_SECTIONS.test(s.title)).flatMap((s) => s.paragraphs),
  ].join(" ").trim();
  const allReqs = work.flatMap((s) => [...s.requirements, ...s.children.flatMap((c) => c.requirements)]);
  if (allReqs.length < 3) return null;

  const fullText = text;
  const personas = [...new Set(PERSONAS.filter((p) => new RegExp(`\\b${p}s?\\b`, "i").test(fullText)))].filter(
    (p, _i, arr) => !arr.some((o) => o !== p && o.includes(p)),
  );
  const systems = detectSystems(fullText);
  const objects = [...new Set(OBJECT_RULES.filter(([, re]) => re.test(fullText)).map(([o]) => o))];
  const nfrs = allReqs.filter((r) => /\bwithin\b|\boffline\b|\b\d+(,\d{3})*\b|\bretry\b|\bavailable\b/i.test(r)).slice(0, 6);

  const maxStories = 24;
  const perReqBudget = Math.max(1, Math.ceil(allReqs.length / maxStories));
  const epics: SimEpic[] = [];
  let questions = 0;

  for (const sec of work) {
    const groups: { title: string; reqs: string[]; paras: string[]; num: string }[] = sec.children.length
      ? sec.children.filter((c) => c.requirements.length).map((c) => ({ title: c.title, reqs: c.requirements, paras: c.paragraphs, num: c.num }))
      : [];
    if (sec.requirements.length) groups.unshift({ title: sec.title, reqs: sec.requirements, paras: sec.paragraphs, num: sec.num });
    if (!groups.length) continue;
    const epic: SimEpic = { title: sec.title, background: sec.paragraphs.join(" ") || `Requirements from §${sec.num} of the source document.`, features: [] };
    for (const g of groups) {
      // Merge requirements when the document is very long so the simulated backlog stays readable.
      const chunks: string[][] = [];
      for (let i = 0; i < g.reqs.length; i += perReqBudget) chunks.push(g.reqs.slice(i, i + perReqBudget));
      const stories: SimStory[] = chunks.map((reqs) => {
        const req = reqs[0];
        const textAll = reqs.join(". ");
        const { category, match } = classifyWhy(`${g.title} ${textAll}`);
        const object = detectObject(textAll, detectObject(`${g.title} ${sec.title}`, objects[0] ?? "Account"));
        const parts = splitRequirement(req);
        const persona = (!parts.passive ? findPersona(parts.actor) : null) ?? PERSONA_BY_CATEGORY[category] ?? findPersona(textAll) ?? personas[0] ?? "business user";
        const title = storyTitle(req);
        const q = questions < 4 ? reqs.map(questionFor).find(Boolean) ?? null : null;
        if (q) questions++;
        const acs = reqs.length > 1
          ? reqs.flatMap((r) => acceptanceCriteria(r, category, object).slice(0, 2)).slice(0, 4)
          : acceptanceCriteria(req, category, object);
        const base = BASE_POINTS[category] ?? 3;
        let points = base;
        const pointsWhy = [`${category.replace(/_/g, " ")}${match ? ` (found "${match.toLowerCase()}")` : " (no specific keyword — default)"}: base ${base}`];
        const hard = textAll.match(/offline|real[- ]time|signature/i)?.[0];
        if (hard) {
          points += 3;
          pointsWhy.push(`+3 mentions "${hard.toLowerCase()}"`);
        }
        if (reqs.length > 1) {
          points += 2;
          pointsWhy.push(`+2 combines ${reqs.length} requirements`);
        }
        if (points > 8) {
          pointsWhy.push(`capped at 8 (was ${points})`);
          points = 8;
        }
        return {
          title,
          type: category === "script" ? "task" : "story",
          category,
          points,
          pointsWhy,
          moscow: /\bmust|shall\b/i.test(textAll) ? "Must" : /\bshould\b/i.test(textAll) ? "Should" : "Could",
          user_story: `${asPersona(persona)}, I want ${wantPhrase(req)}, so that ${BENEFIT[category] ?? BENEFIT.development}.`,
          background: `${g.paras.join(" ") || epic.background} Source: ${projectName} requirements §${g.num}.`.trim(),
          rules: reqs.map((r) => `${cap(r)}.`),
          acs,
          spec: techSpec(category, object, title, systems),
          object,
          question: q ?? undefined,
          source: `§${g.num}`,
        } satisfies SimStory;
      });
      epic.features.push({ title: g.title, category: stories[0]?.category ?? "development", stories });
    }
    epics.push(epic);
  }

  // Dependencies & one deliberate QA failure so the rework loop is exercised.
  const flat = epics.flatMap((e) => e.features.flatMap((f) => f.stories));
  const foundation = flat.find((s) => s.category === "configuration" || s.category === "development") ?? flat[0];
  for (const s of flat) {
    if (s === foundation) continue;
    if (["data_migration", "integration", "reporting"].includes(s.category)) s.dependsOn = [foundation.title];
  }
  const victim = flat.find((s) => s.category === "integration") ?? flat.find((s) => s.category === "development");
  if (victim) {
    const failingAc = victim.acs.findIndex(([t]) => t === "Failure handling");
    const n = failingAc >= 0 ? failingAc + 1 : Math.min(2, victim.acs.length);
    victim.failsQaOnce =
      victim.category === "integration"
        ? `AC ${n} — the callout sets no timeout and never retries; when ${systems[0] ?? "the external system"} is slow the user waits for the default 120 s and nothing is queued for retry.`
        : `AC ${n} — not bulk-safe: the service queries inside the loop and fails above 100 ${victim.object} records.`;
  }

  return { source: "document", docTitle: doc.title, intro, personas, objects, systems, nfrs, epics };
}

// ---------------------------------------------------------------- persistence

const cache = new Map<string, SimPlan>();

function planFile(p: Pick<Project, "key">) {
  return path.join(projectDir(p), "sim-plan.json");
}

export function savePlan(p: Pick<Project, "key">, plan: SimPlan) {
  cache.set(p.key, plan);
  fs.mkdirSync(projectDir(p), { recursive: true });
  fs.writeFileSync(planFile(p), JSON.stringify(plan, null, 2));
}

export function loadPlan(p: Pick<Project, "key">): SimPlan | null {
  if (cache.has(p.key)) return cache.get(p.key)!;
  const f = planFile(p);
  if (!fs.existsSync(f)) return null;
  const plan = JSON.parse(fs.readFileSync(f, "utf8")) as SimPlan;
  cache.set(p.key, plan);
  return plan;
}

export function planStories(plan: SimPlan | null) {
  return plan ? plan.epics.flatMap((e) => e.features.flatMap((f) => f.stories)) : [];
}
