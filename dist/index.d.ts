/**
 * Golden Kog debate entry point.
 *
 * This module is a risk instrument. It carries no level, no points, no trading
 * view, no price target and no advice.
 */
export { debate, discuss, reviewPart, ADVOCATE_PLACEHOLDER, DEFAULT_TIMEOUT_MS, MAX_ADVOCATE_WORDS, MAX_REVIEWER_WORDS, } from "./debate";
export type { Debate, DebateDeps, DebateInput, DebateMode, DebateRole, RouteArgs, RouteResult, } from "./debate";
export { debate as default } from "./debate";
