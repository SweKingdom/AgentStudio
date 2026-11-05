/**
 * An Azure DevOps description, split into the story fields AgentStudio's agents read — so a long description with a
 * team template doesn't travel as one block in every agent run of the story (developer, QA, review, docs, each round).
 *
 * Deterministic, no model: sections are found by their headings (English and Swedish), the "As a …" sentence becomes
 * the user story, Given/When/Then lines join the acceptance criteria, the "Depends on" line is dropped (it is parsed
 * into the story's dependencies), and template leftovers — empty headings, TBD, [placeholders] — are removed.
 */

export interface DescriptionParts {
  userStory: string;
  background: string;
  businessRules: string;
  /** Given/When/Then scenarios and acceptance sections found in the description. */
  scenarios: string;
  dependencies: string;
  outOfScope: string;
}

type Part = keyof DescriptionParts;

/** Section headings and the field they go to. A heading is a short line, optionally with #, ** or a trailing colon. */
const HEADINGS: [RegExp, Part][] = [
  [/^(user story|story|användarberättelse)$/i, "userStory"],
  [/^(background|context|description|beskrivning|bakgrund|kontext|notes?|anteckningar|details|detaljer)$/i, "background"],
  [/^(business rules?|rules?|affärsregler|regler|constraints|begränsningar)$/i, "businessRules"],
  [/^(acceptance criteria|acceptance tests?|acceptanskriterier|acceptanstester|scenarios?|scenarier|given\s*\/\s*when\s*\/\s*then)$/i, "scenarios"],
  [/^(dependencies|depends on|beroenden|beror på)$/i, "dependencies"],
  [/^(out of scope|not included|utanför omfånget|ingår inte)$/i, "outOfScope"],
];

const headingText = (line: string) => line.trim().replace(/^#+\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").replace(/:$/, "").trim();

function headingOf(line: string): Part | null {
  const text = headingText(line);
  if (!text || text.length > 40) return null;
  return HEADINGS.find(([re]) => re.test(text))?.[1] ?? null;
}

/** Template leftovers: a line that says nothing (TBD, N/A, -, [placeholder], <placeholder>). */
const EMPTY_LINE = /^(-\s*)?(tbd|tba|n\/a|na|todo|\.\.\.|…|-|\[[^\]]*\]|<[^>]*>|\(none\)|none|ingen|inga)\.?$/i;
const STORY = /^(as an? |som (en|ett) )/i;
const GHERKIN = /^(-\s*)?(given|when|then|and|but|givet|när|så|och|men)\b/i;
const DEPENDS = /^(-\s*)?(depends on|beror på)[:\s]/i;

const clean = (lines: string[]) =>
  lines
    .filter((l) => !EMPTY_LINE.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Splits plain-text description (htmlToText output) into story fields. Unknown sections stay in the background. */
export function splitDescription(text: string): DescriptionParts {
  const parts: Record<Part, string[]> = { userStory: [], background: [], businessRules: [], scenarios: [], dependencies: [], outOfScope: [] };
  let current: Part | null = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    const heading = headingOf(line);
    if (heading) {
      current = heading;
      continue;
    }
    const t = line.trim();
    // "Depends on: #12140" is parsed into the story's dependencies; the line itself would only repeat it.
    if (DEPENDS.test(t)) continue;
    if (!current && STORY.test(t)) {
      parts.userStory.push(t);
      continue;
    }
    if (current !== "scenarios" && GHERKIN.test(t) && /^(-\s*)?(given|givet)\b/i.test(t)) current = "scenarios";
    parts[current ?? "background"].push(line);
  }
  return {
    userStory: clean(parts.userStory),
    background: clean(parts.background),
    businessRules: clean(parts.businessRules),
    scenarios: clean(parts.scenarios),
    dependencies: clean(parts.dependencies),
    outOfScope: clean(parts.outOfScope),
  };
}

/** The acceptance criteria field plus scenarios from the description, without repeating what the field already has. */
export function joinAcceptance(field: string, scenarios: string) {
  const a = field.trim();
  const s = scenarios.trim();
  if (!s || a.includes(s)) return a;
  return a ? `${a}\n\n${s}` : s;
}
