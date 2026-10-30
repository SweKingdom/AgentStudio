/**
 * Test evidence "screenshots": an SVG mock of the Salesforce Lightning record page the tester checked, with the
 * verified fields, the outcome, and — for failures — a red box around what is wrong (Rudolf-style marked screenshot).
 * All text is escaped; the output never contains scripts.
 */
import type { WorkItem } from "./store.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function wrap(text: string, width: number, maxLines: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length === maxLines) break;
    } else cur += " " + w;
  }
  if (lines.length < maxLines && cur.trim()) lines.push(cur.trim());
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = clip(lines[maxLines - 1], width - 1) + "…";
  return lines;
}

/** Field API names mentioned in the technical specification, e.g. `Priority__c`. */
export function specFields(it: Pick<WorkItem, "tech_spec" | "acceptance_criteria">) {
  const found = new Set<string>();
  for (const m of `${it.tech_spec}\n${it.acceptance_criteria}`.matchAll(/`([A-Za-z][A-Za-z0-9_.]*__c|[A-Z][A-Za-z]+(?:Id|Status|Date|Number|Name|Type))`/g)) {
    found.add(m[1].split(".").pop()!);
  }
  const defaults = ["Status", "Owner", "Priority", "Last Modified By"];
  return [...found, ...defaults.filter((d) => !found.has(d))].slice(0, 6);
}

function label(api: string) {
  return api.replace(/__c$/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function renderEvidenceSvg(o: {
  item: Pick<WorkItem, "code" | "title" | "tech_spec" | "acceptance_criteria">;
  object: string;
  acRef: string;
  result: "pass" | "fail" | "blocked";
  notes: string;
  iteration: number;
  simulated: boolean;
}) {
  const W = 1280;
  const H = 760;
  const fields = specFields(o.item);
  const failIdx = o.result === "fail" ? Math.min(fields.length - 1, 1) : -1;
  const value = (f: string, i: number) =>
    i === failIdx ? "— (empty)" : /status/i.test(f) ? "In Progress" : /priority/i.test(f) ? "High" : /owner|by/i.test(f) ? "QA tester (AI)" : /date/i.test(f) ? "15/10/2026 10:24" : /id$/i.test(f) ? "a0X5g00000AbCdE" : "Verified value";
  const colour = { pass: "#2e844a", fail: "#ba0517", blocked: "#8c4b02" }[o.result];
  const verdict = { pass: "✓ Works", fail: "✗ Broken", blocked: "⛔ Couldn't test" }[o.result];
  const noteLines = wrap(o.notes || "", 70, 4);

  const fieldRows = fields
    .map((f, i) => {
      const x = 56 + (i % 2) * 560;
      const y = 300 + Math.floor(i / 2) * 74;
      return `
    <text x="${x}" y="${y}" font-size="13" fill="#444">${esc(label(f))}</text>
    <text x="${x}" y="${y + 24}" font-size="16" fill="${i === failIdx ? "#ba0517" : "#181818"}">${esc(value(f, i))}</text>
    <line x1="${x}" y1="${y + 36}" x2="${x + 500}" y2="${y + 36}" stroke="#e5e5e5"/>
    ${i === failIdx ? `<rect x="${x - 12}" y="${y - 22}" width="526" height="66" fill="none" stroke="#ea001e" stroke-width="4" rx="6"/>` : ""}`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Salesforce Sans, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#f3f3f3"/>
  <!-- global header -->
  <rect width="${W}" height="48" fill="#ffffff"/>
  <rect x="16" y="12" width="24" height="24" rx="12" fill="#00a1e0"/>
  <rect x="380" y="10" width="520" height="28" rx="14" fill="#f3f3f3" stroke="#c9c9c9"/>
  <text x="400" y="29" font-size="13" fill="#747474">Search…</text>
  <circle cx="1240" cy="24" r="14" fill="#d8dde6"/>
  <!-- app nav -->
  <rect y="48" width="${W}" height="40" fill="#ffffff" stroke="#e5e5e5"/>
  <text x="24" y="74" font-size="15" font-weight="600" fill="#181818">Service Console</text>
  <text x="200" y="74" font-size="13" fill="#0b5cab">${esc(o.object)}s</text>
  <rect x="200" y="84" width="${Math.max(60, o.object.length * 8 + 10)}" height="3" fill="#0b5cab"/>
  <!-- record header -->
  <rect x="24" y="104" width="${W - 48}" height="96" rx="8" fill="#ffffff" stroke="#e5e5e5"/>
  <rect x="44" y="124" width="48" height="48" rx="6" fill="#7f8de1"/>
  <text x="108" y="140" font-size="13" fill="#444">${esc(o.object)}</text>
  <text x="108" y="166" font-size="22" font-weight="700" fill="#181818">AI-TEST ${esc(o.item.code)} · ${esc(clip(o.item.title, 60))}</text>
  <rect x="${W - 260}" y="132" width="90" height="32" rx="4" fill="#ffffff" stroke="#c9c9c9"/>
  <text x="${W - 236}" y="153" font-size="13" fill="#0b5cab">Edit</text>
  <rect x="${W - 160}" y="132" width="110" height="32" rx="4" fill="#ffffff" stroke="#c9c9c9"/>
  <text x="${W - 144}" y="153" font-size="13" fill="#0b5cab">Change Owner</text>
  <!-- details -->
  <rect x="24" y="216" width="${W - 48}" height="${H - 300}" rx="8" fill="#ffffff" stroke="#e5e5e5"/>
  <text x="44" y="250" font-size="15" font-weight="700" fill="#181818">Details</text>
  ${fieldRows}
  ${o.result === "pass" ? `<rect x="${W / 2 - 170}" y="58" width="340" height="44" rx="6" fill="#2e844a"/><text x="${W / 2}" y="86" font-size="15" fill="#fff" text-anchor="middle">✓ ${esc(clip(o.acRef, 32))} verified</text>` : ""}
  ${o.result === "blocked" ? `<rect x="24" y="216" width="${W - 48}" height="${H - 300}" rx="8" fill="#000" opacity="0.35"/><text x="${W / 2}" y="${H / 2 + 40}" font-size="22" fill="#fff" text-anchor="middle" font-weight="700">Couldn't test — see notes</text>` : ""}
  <!-- tester callout -->
  <rect x="${W - 520}" y="${H - 240}" width="480" height="${44 + noteLines.length * 20}" rx="8" fill="#ffffff" stroke="${colour}" stroke-width="2"/>
  <text x="${W - 500}" y="${H - 212}" font-size="14" font-weight="700" fill="${colour}">${esc(verdict)} · ${esc(clip(o.acRef, 40))}</text>
  ${noteLines.map((l, i) => `<text x="${W - 500}" y="${H - 188 + i * 20}" font-size="13" fill="#3e3e3c">${esc(l)}</text>`).join("")}
  <!-- caption -->
  <rect y="${H - 36}" width="${W}" height="36" fill="#282b34"/>
  <text x="20" y="${H - 13}" font-size="13" fill="#dacbb4">🦌 ${esc(o.item.code)} · ${esc(clip(o.acRef, 60))} · iteration ${o.iteration}${o.simulated ? " · simulated evidence" : ""}</text>
</svg>
`;
}
