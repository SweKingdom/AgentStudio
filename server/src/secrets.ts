/**
 * What a secret looks like: well-known token formats and private keys, plus "password = '…'"-style assignments with a
 * real-looking value. Used by the security scan (a secret in a story's code blocks its merge) and by redaction (no
 * secret is stored in the activity log, messages or documents).
 */

/** Token formats with a recognisable prefix; low risk of false positives. */
const TOKENS: { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Stripe secret key", re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "Azure DevOps / SAS signature", re: /\bsig=[A-Za-z0-9%+/=]{30,}/g },
];

/** `password = "…"`, `apiKey: '…'`, `SECRET=…` with a value that isn't a placeholder or a variable. */
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\b(\s*[:=]\s*)(["'`]?)([^"'`\s,;)}]{8,})\3/gi;
const PLACEHOLDER = /^(?:x+|\*+|\.{3,}|<.*>|\$\{.*|\$[A-Z_]+|process\.env.*|env\.|import\.meta.*|os\.environ.*|your[_-].*|change[_-]?me.*|example.*|placeholder.*|dummy.*|test.*|fake.*|redacted.*|null|undefined|true|false|none|string|number|required|optional)$/i;

export interface SecretHit {
  name: string;
  /** The matched text, shortened, for a finding: never the whole secret. */
  preview: string;
}

const preview = (s: string) => `${s.slice(0, 6)}…`;

/** The secrets in a text. */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const t of TOKENS) for (const m of text.matchAll(t.re)) hits.push({ name: t.name, preview: preview(m[0]) });
  for (const m of text.matchAll(ASSIGNMENT)) {
    if (!PLACEHOLDER.test(m[4]) && !/^[a-z_]+\(|\.\w+$/.test(m[4])) hits.push({ name: `hard-coded ${m[1]}`, preview: preview(m[4]) });
  }
  return hits;
}

/** The text with every secret replaced by [redacted: kind] — what is stored and shown instead. */
export function redact(text: string): string {
  let out = text;
  for (const t of TOKENS) out = out.replace(t.re, `[redacted: ${t.name}]`);
  out = out.replace(ASSIGNMENT, (whole, key: string, sep: string, q: string, value: string) => (PLACEHOLDER.test(value) || /^[a-z_]+\(|\.\w+$/.test(value) ? whole : `${key}${sep}${q}[redacted]${q}`));
  return out;
}
