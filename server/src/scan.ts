/**
 * The security scan every story passes before it is merged. Deterministic and not waivable: no setting turns it off.
 * It looks at what the story's branch changes against the base branch:
 * - secrets in added lines (keys, tokens, hard-coded passwords);
 * - protected paths (environment files, keys and certificates, credential files, and the project's own list);
 * - dependency sources other than the package registries (git, URLs, local paths, other indexes);
 * - symbolic links that point outside the repository.
 */
import path from "node:path";
import { branchChanges } from "./git.js";
import { findSecrets } from "./secrets.js";
import type { Project } from "./store.js";

export interface ScanFinding {
  kind: "secret" | "protected path" | "dependency source" | "symlink";
  path: string;
  detail: string;
}

/** Never written by an agent: environment files with real values, keys, certificates, credential stores. */
const PROTECTED = [
  /(^|\/)\.env(\.[\w-]+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.docker\/config\.json$/,
];
/** Templates for environment files are fine. */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|defaults|dist)$/i;

/** A project's own protected paths: simple globs (`*` within a folder, `**` across folders). */
function globRe(glob: string) {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`);
}

const REGISTRY = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//;
/** npm/yarn/pnpm version specs that pull code from somewhere other than the registry. */
const NON_REGISTRY_SPEC = /^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|portal:)|^[\w.-]+\/[\w.-]+(#.*)?$/;

function dependencyFindings(file: string, added: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  const name = path.posix.basename(file);
  if (name === "package.json") {
    for (const line of added) {
      const m = line.match(/^\s*"([^"]+)"\s*:\s*"([^"]+)"/);
      if (m && NON_REGISTRY_SPEC.test(m[2]) && !/^(scripts|name|version|main|module|types|description|license|repository|homepage|author|type|engines|private|workspaces|bin)$/.test(m[1]) && !/^(node|npm)$/.test(m[1])) {
        out.push({ kind: "dependency source", path: file, detail: `"${m[1]}" comes from ${m[2]}, not the npm registry` });
      }
    }
  } else if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
    for (const line of added) {
      const m = line.match(/"resolved"\s*:\s*"([^"]+)"/);
      if (m && !REGISTRY.test(m[1])) out.push({ kind: "dependency source", path: file, detail: `a package is resolved from ${m[1].slice(0, 120)}` });
    }
  } else if (/^requirements.*\.txt$|^constraints.*\.txt$/.test(name)) {
    for (const line of added) {
      if (/^\s*(-e\s+)?(git\+|https?:|file:)|--(extra-)?index-url|--find-links|--trusted-host/.test(line)) out.push({ kind: "dependency source", path: file, detail: line.trim().slice(0, 160) });
    }
  } else if (name === "pyproject.toml" || name === "Pipfile") {
    for (const line of added) if (/\b(git|url|path)\s*=\s*["']/.test(line)) out.push({ kind: "dependency source", path: file, detail: line.trim().slice(0, 160) });
  } else if (name === "go.mod") {
    for (const line of added) if (/^\s*replace\b.*=>\s*(\.|\/)/.test(line)) out.push({ kind: "dependency source", path: file, detail: line.trim().slice(0, 160) });
  }
  return out;
}

/** Scan what a story's branch changes. An empty list means it may be merged as far as security goes. */
export async function scanBranch(project: Pick<Project, "key" | "settings">, code: string): Promise<ScanFinding[]> {
  const { files, added, symlinks } = await branchChanges(project, code);
  const own = (project.settings.protectedPaths ?? []).filter(Boolean).map(globRe);
  const findings: ScanFinding[] = [];
  for (const f of files) {
    if (f.status === "D") continue;
    if ((PROTECTED.some((re) => re.test(f.path)) && !ENV_TEMPLATE.test(f.path)) || own.some((re) => re.test(f.path))) {
      findings.push({ kind: "protected path", path: f.path, detail: "a protected file is added or changed" });
    }
  }
  for (const [file, lines] of added) {
    // Lockfiles are full of hashes that look like tokens; their sources are checked below instead.
    if (!/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/.test(file)) {
      for (const hit of findSecrets(lines.join("\n"))) findings.push({ kind: "secret", path: file, detail: `${hit.name} (${hit.preview})` });
    }
    findings.push(...dependencyFindings(file, lines));
  }
  for (const s of symlinks) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(s.path), s.target.replace(/\\/g, "/")));
    if (path.isAbsolute(s.target) || /^[A-Za-z]:/.test(s.target) || resolved.startsWith("../") || resolved === "..") {
      findings.push({ kind: "symlink", path: s.path, detail: `points outside the repository (${s.target})` });
    }
  }
  return findings;
}

export const formatFindings = (f: ScanFinding[]) => f.map((x) => `- ${x.kind}: ${x.path} — ${x.detail}`).join("\n");
