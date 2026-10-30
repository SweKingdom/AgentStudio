import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { all } from "./db.js";
import { listItems, listWorkspaceFiles, workspaceDir, type Project, type WorkItem } from "./store.js";
import { sfdxProjectJson, teamSettings } from "./team.js";

function csvCell(v: unknown) {
  const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: unknown[][]) {
  // UTF-8 BOM so Excel opens accents and emoji correctly.
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Full backlog with every template section — for Excel / Sheets. */
export function backlogCsv(p: Project) {
  const items = listItems(p.id);
  const code = new Map(items.map((i) => [i.id, i.code]));
  const cost = new Map(all<{ item_id: string; c: number }>("SELECT item_id, SUM(cost_usd) c FROM llm_calls WHERE project_id = ? AND item_id IS NOT NULL GROUP BY item_id", p.id).map((r) => [r.item_id, r.c]));
  const header = [
    "Code", "Type", "Parent", "Title", "Category", "State", "Story Points", "Priority", "MoSCoW", "WSJF", "Sprint", "Rank", "Depends On", "Tags",
    "User Story", "Background", "Business Rules", "Dependencies", "Out of Scope", "Acceptance Criteria", "Technical Specification", "How to Test",
    "Manual Steps", "Solution Components", "Rework Loops", "Human Estimate (h)", "AI Cost (USD)",
  ];
  const rows = items.map((i) => [
    i.code, i.type, i.parent_id ? code.get(i.parent_id) : "", i.title, i.category, i.state, i.story_points, i.priority, i.moscow, i.wsjf, i.sprint, i.rank,
    i.depends_on, i.tags, i.user_story, i.background, i.business_rules, i.dependencies, i.out_of_scope, i.acceptance_criteria, i.tech_spec,
    i.how_to_test, i.manual_steps, i.solution_components, i.rework_count, i.human_hours, (cost.get(i.id) ?? 0).toFixed(4),
  ]);
  return toCsv([header, ...rows]);
}

const ADO_TYPE: Record<WorkItem["type"], string> = { epic: "Epic", feature: "Feature", story: "User Story", task: "Task", bug: "Bug" };

/**
 * Azure DevOps "Import Work Items" CSV: hierarchy through Title 1/2/3 columns, standard fields only, all items New.
 * Boards → Work items → Import Work Items.
 */
export function adoImportCsv(p: Project) {
  const items = listItems(p.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = (i: WorkItem): number => (i.parent_id && byId.get(i.parent_id) ? depth(byId.get(i.parent_id)!) + 1 : 0);
  const ordered: WorkItem[] = [];
  const typeOrder: Record<WorkItem["type"], number> = { epic: 0, feature: 1, story: 2, task: 3, bug: 4 };
  const walk = (pid: string | null) => {
    const kids = items.filter((i) => (pid === null ? !i.parent_id || !byId.has(i.parent_id) : i.parent_id === pid));
    // Epics first at the top level (orphan stories after them), then build order.
    kids.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    for (const c of kids) {
      ordered.push(c);
      walk(c.id);
    }
  };
  walk(null);
  const description = (i: WorkItem) =>
    [
      i.user_story && `User Story\n${i.user_story}`,
      i.background && `Background & Context\n${i.background}`,
      i.business_rules && `Business Rules\n${i.business_rules}`,
      i.dependencies && `Dependencies\n${i.dependencies}`,
      i.out_of_scope && `Out of Scope\n${i.out_of_scope}`,
      i.tech_spec && `Technical Specification\n${i.tech_spec}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  // Area / iteration paths and extra tags come from the team conventions (Settings → Team conventions).
  const ado = teamSettings().conventions.ado;
  const area = ado.areaPath.trim();
  const root = area.split("\\")[0];
  const header = ["ID", "Work Item Type", "Title 1", "Title 2", "Title 3", "Title 4", "State", "Description", "Acceptance Criteria", "Story Points", "Priority", "Tags", ...(area ? ["Area Path", "Iteration Path"] : [])];
  const extraTags = ado.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
  const rows = ordered.map((i) => {
    const d = Math.min(3, depth(i));
    const titles = ["", "", "", ""];
    titles[d] = `${i.title}`;
    const row: (string | number)[] = ["", ADO_TYPE[i.type], ...titles, "New", description(i), i.acceptance_criteria, i.story_points ?? "", i.priority ?? "", [...i.tags, ...extraTags, `ARM ${i.code}`, i.category].join("; ")];
    if (area) row.push(area, i.sprint ? `${root}\\${ado.iterationPrefix}${i.sprint}` : root);
    return row;
  });
  return toCsv([header, ...rows]);
}

/** Everything the team produced: SFDX workspace, documents, both CSVs and a README. */
export function workspaceZip(p: Project) {
  const root = workspaceDir(p);
  const entries: Record<string, Uint8Array> = {};
  for (const rel of listWorkspaceFiles(p)) entries[`${p.key}/${rel}`] = new Uint8Array(fs.readFileSync(path.join(root, rel)));
  entries[`${p.key}/backlog.csv`] = strToU8(backlogCsv(p));
  entries[`${p.key}/azure-devops-import.csv`] = strToU8(adoImportCsv(p));
  if (!entries[`${p.key}/sfdx-project.json`]) {
    entries[`${p.key}/sfdx-project.json`] = strToU8(sfdxProjectJson(p));
  }
  entries[`${p.key}/README.md`] = strToU8(
    `# ${p.name} (${p.key})\n\nExported from SiroccoARM on ${new Date().toISOString().slice(0, 10)}${p.mode === "simulation" ? " — produced in simulation mode" : ""}.\n\n| Path | Content |\n|---|---|\n| \`force-app/\` | SFDX source |\n| \`manifest/package.xml\` | Release manifest |\n| \`scripts/\` | Data and Apex scripts |\n| \`docs/\` | Project documents and per-story folders |\n| \`backlog.csv\` | Full backlog (Excel) |\n| \`azure-devops-import.csv\` | Azure DevOps work item import |\n`,
  );
  return Buffer.from(zipSync(entries, { level: 6 }));
}
