/**
 * Golden Kog: two sided structure debate for token risk analysis.
 *
 * Two advocates argue from the measured facts (one that the structure is
 * sound, one that it is fragile), then a reviewer weighs both cases.
 * This is a risk instrument only. It never returns a level, a points score,
 * a trading view, a price target or any advice.
 *
 * Pattern adapted from TradingAgents (TauricResearch, Apache 2.0) without its
 * trader and portfolio manager stages.
 */

export type DebateMode = "off" | "shadow" | "on";

export type DebateRole = "sound" | "fragile" | "reviewer";

export interface DebateInput {
  /** Block of measured facts, one per line, every number already computed. */
  facts_text: string;
  /** Risk level produced upstream. Passed through untouched, never changed. */
  level: string;
  /** Risk points produced upstream. Passed through untouched, never changed. */
  points: number;
  /** Ids of the risk rules that fired. */
  flag_ids: string[];
  /** Facts the upstream measurement could not establish. */
  unknown: string[];
}

export interface RouteArgs {
  task_type: "risk_debate";
  tier_class: "text";
  complexity: "exec" | "apex";
  context_tokens: number;
  constitutional_flag: false;
  agent_id: "golden-kog";
  payload: {
    role: DebateRole;
    system: string;
    prompt: string;
    max_tokens: number;
  };
}

export interface RouteResult {
  content: string;
  model?: string;
  cost_usd?: number;
}

export interface DebateDeps {
  route: (args: RouteArgs) => Promise<RouteResult>;
  /** Caller's own guard. Empty array means the text is fine. */
  check?: (text: string) => string[];
  /** Default "shadow". */
  mode?: DebateMode;
  log?: (row: object) => void;
  /** Default 45000. A call over this budget yields status "timeout". */
  timeoutMs?: number;
}

export interface Debate {
  status: "ok" | "rejected" | "timeout" | "off";
  shown: boolean;
  sound: string;
  fragile: string;
  reviewer: string;
  weight: string[];
  unknown: string[];
  tension?: string;
  models: { sound?: string; fragile?: string; reviewer?: string };
  usd: number;
  rejected: string[];
}

export const ADVOCATE_PLACEHOLDER =
  "No case could be written from the measured facts.";

export const DEFAULT_TIMEOUT_MS = 45000;
export const MAX_ADVOCATE_WORDS = 180;
export const MAX_REVIEWER_WORDS = 150;

/** Words and phrases that turn a risk note into a trading call. */
const REFUSED_PHRASES: readonly string[] = [
  "bull",
  "bear",
  "bullish",
  "bearish",
  "upside",
  "downside target",
  "undervalued",
  "overvalued",
  "accumulate",
  "moon",
  "buy now",
  "sell now",
  "price target",
  "entry",
  "exit",
  "take profit",
  "not financial advice",
];

const DASH_RE = /[-\u2010\u2011\u2012\u2013\u2014\u2015\u2043\u2212\uFE58\uFE63\uFF0D]/;
const NON_LATIN_DIGIT_RE = /(?![0-9])\p{Nd}/u;
const NUMBER_RE = /[0-9]+(?:[.,][0-9]+)*/g;
const WORD_SPLIT_RE = /\s+/;

const ADVOCATE_SYSTEM = [
  "You are a structure advocate inside a token risk tool.",
  "Argue one side of the measured structure only, using the facts supplied.",
  "Every number you write must appear in the facts, written exactly the same way.",
  "Use Latin digits only and no dash characters.",
  "Write plain prose, at most 180 words.",
  "Never give a trading view, a price target, an entry or an exit, or any advice.",
].join(" ");

const REVIEWER_SYSTEM = [
  "You are the reviewer inside a token risk tool.",
  "Weigh the two cases against the measured facts and state which facts carry more weight.",
  "Every number you write must appear in the facts, written exactly the same way.",
  "Use Latin digits only and no dash characters.",
  "Answer with JSON only: {\"text\": string, \"weight\": string[], \"unknown\": string[], \"tension\": string}.",
  "weight holds only ids from the given flag ids. text is at most 150 words.",
  "Never give a trading view, a price target, an entry or an exit, or any advice.",
].join(" ");

class TimeoutError extends Error {
  constructor() {
    super("route call exceeded timeoutMs");
    this.name = "TimeoutError";
  }
}

function numberTokens(text: string): string[] {
  return text.match(NUMBER_RE) ?? [];
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(WORD_SPLIT_RE).length;
}

function refusedPhrase(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const phrase of REFUSED_PHRASES) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
    if (re.test(lower)) return phrase;
  }
  return undefined;
}

/** Check a candidate part against the shared rules. Returns the problems found. */
export function reviewPart(
  text: string,
  factsText: string,
  limitWords: number,
  check?: (text: string) => string[],
): string[] {
  const problems: string[] = [];
  const value = text.trim();
  if (value.length === 0) {
    return ["empty_text"];
  }
  if (DASH_RE.test(value)) {
    problems.push("dash_character");
  }
  if (NON_LATIN_DIGIT_RE.test(value)) {
    problems.push("non_latin_digit");
  }
  const phrase = refusedPhrase(value);
  if (phrase !== undefined) {
    problems.push("refused_phrase");
  }
  if (wordCount(value) > limitWords) {
    problems.push("too_many_words");
  }
  const factNumbers = new Set(numberTokens(factsText));
  for (const token of numberTokens(value)) {
    if (!factNumbers.has(token)) {
      problems.push(`number_not_in_facts:${token}`);
      break;
    }
  }
  if (check) {
    let extra: string[] = [];
    try {
      extra = check(value);
    } catch {
      extra = ["check_failed"];
    }
    if (!Array.isArray(extra)) extra = ["check_failed"];
    for (const item of extra) problems.push(`check:${String(item)}`);
  }
  return problems;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), Math.max(1, ms));
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

function estimateContextTokens(text: string): number {
  const approx = Math.ceil(text.length / 4);
  return approx > 0 ? approx : 1;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeUnknown(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
  }
  return out.length > 0 ? out : [...fallback];
}

function parseReviewer(
  content: string,
): { text: string; weight: unknown; unknown: unknown; tension?: unknown } | undefined {
  const cleaned = content
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as { text: string; weight: unknown; unknown: unknown; tension?: unknown };
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function emptyDebate(status: Debate["status"], rejected: string[] = []): Debate {
  return {
    status,
    shown: false,
    sound: "",
    fragile: "",
    reviewer: "",
    weight: [],
    unknown: [],
    models: {},
    usd: 0,
    rejected,
  };
}

function advocatePrompt(role: "sound" | "fragile", input: DebateInput): string {
  const stance =
    role === "sound"
      ? "Argue that the measured structure is sound: which measured facts support resilience, and why the fired flags are contained."
      : "Argue that the measured structure is fragile: which measured facts show exposure, and why the fired flags matter.";
  const flags = input.flag_ids.length > 0 ? input.flag_ids.join(", ") : "none";
  const unknown = input.unknown.length > 0 ? input.unknown.join(", ") : "none";
  return [
    `Stance: ${stance}`,
    `Flag ids that fired: ${flags}.`,
    `Not established by the measurement: ${unknown}.`,
    "Measured facts:",
    input.facts_text.trim(),
    "Write the case, at most 180 words, numbers exactly as written above.",
  ].join("\n");
}

function reviewerPrompt(
  input: DebateInput,
  sound: string,
  fragile: string,
): string {
  const flags = input.flag_ids.length > 0 ? input.flag_ids.join(", ") : "none";
  return [
    "Case for a sound structure:",
    sound,
    "Case for a fragile structure:",
    fragile,
    "Measured facts:",
    input.facts_text.trim(),
    `Flag ids that fired: ${flags}.`,
    "Weigh the two cases. Return JSON with text, weight, unknown and tension.",
    "weight may hold only the flag ids listed above. text is at most 150 words.",
  ].join("\n");
}

/**
 * Run the two sided structure debate. Risk only: the returned debate carries
 * no level, no points, no trading view and no advice.
 */
export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate> {
  const mode: DebateMode = deps.mode ?? "shadow";
  if (mode === "off") {
    return emptyDebate("off");
  }

  const factsText = typeof input.facts_text === "string" ? input.facts_text : "";
  const factIds = Array.isArray(input.flag_ids) ? input.flag_ids : [];
  const unknownIn = Array.isArray(input.unknown) ? input.unknown : [];
  const timeoutMs =
    typeof deps.timeoutMs === "number" && deps.timeoutMs > 0
      ? deps.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  if (factsText.trim().length === 0) {
    const debateOut = emptyDebate("rejected", ["empty_facts"]);
    if (deps.log) {
      try {
        deps.log(debateOut);
      } catch {
        // a broken logger never breaks the debate
      }
    }
    return debateOut;
  }

  const contextTokens = estimateContextTokens(factsText + reviewerPrompt(input, "", ""));
  const rejected: string[] = [];
  const models: Debate["models"] = {};
  let usd = 0;

  const call = async (
    role: DebateRole,
    system: string,
    prompt: string,
    maxTokens: number,
  ): Promise<RouteResult> => {
    const result = await withTimeout(
      deps.route({
        task_type: "risk_debate",
        tier_class: "text",
        complexity: role === "reviewer" ? "apex" : "exec",
        context_tokens: contextTokens,
        constitutional_flag: false,
        agent_id: "golden-kog",
        payload: { role, system, prompt, max_tokens: maxTokens },
      }),
      timeoutMs,
    );
    const cost = typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd)
      ? result.cost_usd
      : 0;
    usd += cost;
    if (typeof result.model === "string" && result.model.length > 0) {
      models[role] = result.model;
    }
    return result;
  };

  const advocate = async (role: "sound" | "fragile"): Promise<string> => {
    const result = await call(role, ADVOCATE_SYSTEM, advocatePrompt(role, input), 900);
    const content = typeof result.content === "string" ? result.content : "";
    const problems = reviewPart(content, factsText, MAX_ADVOCATE_WORDS, deps.check);
    if (problems.length > 0) {
      for (const problem of problems) rejected.push(`${role}:${problem}`);
      return ADVOCATE_PLACEHOLDER;
    }
    return content.trim();
  };

  let sound = "";
  let fragile = "";
  try {
    const results = await Promise.all([advocate("sound"), advocate("fragile")]);
    sound = results[0] ?? ADVOCATE_PLACEHOLDER;
    fragile = results[1] ?? ADVOCATE_PLACEHOLDER;
  } catch (error) {
    if (error instanceof TimeoutError) {
      const out = emptyDebate("timeout", rejected);
      out.usd = roundUsd(usd);
      out.models = models;
      return out;
    }
    const out = emptyDebate("rejected", [...rejected, "route_error"]);
    out.usd = roundUsd(usd);
    out.models = models;
    return out;
  }

  let reviewerContent = "";
  try {
    const result = await call(
      "reviewer",
      REVIEWER_SYSTEM,
      reviewerPrompt(input, sound, fragile),
      700,
    );
    reviewerContent = typeof result.content === "string" ? result.content : "";
  } catch (error) {
    if (error instanceof TimeoutError) {
      const out = emptyDebate("timeout", rejected);
      out.usd = roundUsd(usd);
      out.models = models;
      return out;
    }
    const out = emptyDebate("rejected", [...rejected, "reviewer:route_error"]);
    out.usd = roundUsd(usd);
    out.models = models;
    return out;
  }

  const parsed = parseReviewer(reviewerContent);
  if (parsed === undefined) {
    const out = emptyDebate("rejected", [...rejected, "reviewer:unparseable_json"]);
    out.usd = roundUsd(usd);
    out.models = models;
    return out;
  }

  const reviewerText = typeof parsed.text === "string" ? parsed.text : "";
  const problems = reviewPart(reviewerText, factsText, MAX_REVIEWER_WORDS, deps.check);
  if (problems.length > 0) {
    const out = emptyDebate(
      "rejected",
      [...rejected, ...problems.map((p) => `reviewer:${p}`)],
    );
    out.usd = roundUsd(usd);
    out.models = models;
    return out;
  }

  const weight: string[] = [];
  if (Array.isArray(parsed.weight)) {
    for (const item of parsed.weight) {
      if (typeof item === "string" && factIds.includes(item) && !weight.includes(item)) {
        weight.push(item);
      }
    }
  } else if (parsed.weight !== undefined && parsed.weight !== null) {
    rejected.push("reviewer:weight_not_array");
  }

  const out: Debate = {
    status: "ok",
    shown: mode === "on",
    sound,
    fragile,
    reviewer: reviewerText.trim(),
    weight,
    unknown: normalizeUnknown(parsed.unknown, unknownIn),
    models,
    usd: roundUsd(usd),
    rejected,
  };

  const tension = parsed.tension;
  if (typeof tension === "string" && tension.trim().length > 0) {
    const tensionProblems = reviewPart(tension, factsText, MAX_REVIEWER_WORDS, deps.check);
    if (tensionProblems.length === 0) {
      out.tension = tension.trim();
    } else {
      for (const problem of tensionProblems) rejected.push(`tension:${problem}`);
    }
  }

  if (deps.log) {
    try {
      deps.log(out);
    } catch {
      // ignore
    }
  }
  return out;
}

/** Alias kept for the wiring contract used by some Golden Kog builds. */
export const discuss = debate;

export default debate;
