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
    models: {
        sound?: string;
        fragile?: string;
        reviewer?: string;
    };
    usd: number;
    rejected: string[];
}
export declare const ADVOCATE_PLACEHOLDER = "No case could be written from the measured facts.";
export declare const DEFAULT_TIMEOUT_MS = 45000;
export declare const MAX_ADVOCATE_WORDS = 180;
export declare const MAX_REVIEWER_WORDS = 150;
/** Check a candidate part against the shared rules. Returns the problems found. */
export declare function reviewPart(text: string, factsText: string, limitWords: number, check?: (text: string) => string[]): string[];
/**
 * Run the two sided structure debate. Risk only: the returned debate carries
 * no level, no points, no trading view and no advice.
 */
export declare function debate(input: DebateInput, deps: DebateDeps): Promise<Debate>;
/** Alias kept for the wiring contract used by some Golden Kog builds. */
export declare const discuss: typeof debate;
export default debate;
