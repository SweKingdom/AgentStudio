import { getSetting } from "./db.js";

export interface ModelPrice {
  id: string;
  label: string;
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
  cacheRead: number; // USD per 1M cache-read tokens
  cacheWrite: number; // USD per 1M cache-write tokens (5-minute TTL = 1.25x input)
  tokensPerSecond: number; // rough output speed, used only for time estimates
  /** A second rate card for long prompts (input + cache read + cache write tokens above `above`), e.g. Haiku 5.5. */
  longPrompt?: { above: number; input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** First-party Claude API list prices (USD / 1M tokens), 5-minute cache writes. Editable from Settings.
 *  Opus 5.5 reads cache at 0.05× input and Fable 5.1 at 0.025× — not the usual 0.1× — by Anthropic's price list. */
export const DEFAULT_MODELS: ModelPrice[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, tokensPerSecond: 70 },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tokensPerSecond: 95 },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tokensPerSecond: 180,
    longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, tokensPerSecond: 50 },
];

export function models(): ModelPrice[] {
  return getSetting<ModelPrice[]>("models", DEFAULT_MODELS);
}

export function priceFor(model: string): ModelPrice {
  return models().find((m) => m.id === model) ?? models()[0];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Real cost of one call from the usage Claude reports (thinking tokens are billed as output and included in it). */
export function costOf(model: string, u: Usage): number {
  const base = priceFor(model);
  const prompt = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens;
  const p = base.longPrompt && prompt > base.longPrompt.above ? { ...base, ...base.longPrompt } : base;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_tokens * p.cacheRead +
      u.cache_write_tokens * p.cacheWrite) /
    1_000_000
  );
}
