import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, KNOWLEDGE_DIR } from "./db.js";

export interface KnowledgePack {
  id: string;
  title: string;
  summary: string;
  content: string;
  tokens: number;
  custom: boolean;
}

const CUSTOM_DIR = path.join(DATA_DIR, "knowledge");
fs.mkdirSync(CUSTOM_DIR, { recursive: true });

function parse(file: string, custom: boolean): KnowledgePack {
  // A Windows checkout can turn the files into CRLF; the front matter must still be found.
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let content = raw;
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2];
    }
    content = m[2].trim();
  }
  const id = path.basename(file, ".md");
  return { id, title: meta.title ?? id, summary: meta.summary ?? "", content, tokens: Math.round(content.length / 3.6), custom };
}

export function listKnowledge(): KnowledgePack[] {
  const read = (dir: string, custom: boolean) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => parse(path.join(dir, f), custom))
      : [];
  return [...read(KNOWLEDGE_DIR, false), ...read(CUSTOM_DIR, true)].sort((a, b) => a.title.localeCompare(b.title));
}

export function knowledgeById(ids: string[]): KnowledgePack[] {
  const all = listKnowledge();
  return ids.map((id) => all.find((k) => k.id === id)).filter((k): k is KnowledgePack => Boolean(k));
}

export function saveCustomKnowledge(input: { id?: string; title: string; summary: string; content: string }) {
  const id =
    input.id ||
    input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) ||
    `pack-${Date.now()}`;
  if (fs.existsSync(path.join(KNOWLEDGE_DIR, `${id}.md`))) throw new Error("Built-in knowledge packs cannot be overwritten");
  const body = `---\ntitle: ${input.title.replace(/\n/g, " ")}\nsummary: ${input.summary.replace(/\n/g, " ")}\n---\n${input.content}\n`;
  fs.writeFileSync(path.join(CUSTOM_DIR, `${id}.md`), body);
  return id;
}

export function deleteCustomKnowledge(id: string) {
  const file = path.join(CUSTOM_DIR, `${path.basename(id)}.md`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
