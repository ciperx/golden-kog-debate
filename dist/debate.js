"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.discuss = exports.MAX_REVIEWER_WORDS = exports.MAX_ADVOCATE_WORDS = exports.DEFAULT_TIMEOUT_MS = exports.ADVOCATE_PLACEHOLDER = void 0;
exports.reviewPart = reviewPart;
exports.debate = debate;
exports.ADVOCATE_PLACEHOLDER = "No case could be written from the measured facts.";
exports.DEFAULT_TIMEOUT_MS = 45000;
exports.MAX_ADVOCATE_WORDS = 180;
exports.MAX_REVIEWER_WORDS = 150;
/** Words and phrases that turn a risk note into a trading call. */
const REFUSED_PHRASES = [
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
function numberTokens(text) {
    return text.match(NUMBER_RE) ?? [];
}
function wordCount(text) {
    const trimmed = text.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(WORD_SPLIT_RE).length;
}
function refusedPhrase(text) {
    const lower = text.toLowerCase();
    for (const phrase of REFUSED_PHRASES) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
        if (re.test(lower))
            return phrase;
    }
    return undefined;
}
/** Check a candidate part against the shared rules. Returns the problems found. */
function reviewPart(text, factsText, limitWords, check) {
    const problems = [];
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
        let extra = [];
        try {
            extra = check(value);
        }
        catch {
            extra = ["check_failed"];
        }
        if (!Array.isArray(extra))
            extra = ["check_failed"];
        for (const item of extra)
            problems.push(`check:${String(item)}`);
    }
    return problems;
}
function withTimeout(work, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), Math.max(1, ms));
    });
    return Promise.race([work, timeout]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
function estimateContextTokens(text) {
    const approx = Math.ceil(text.length / 4);
    return approx > 0 ? approx : 1;
}
function roundUsd(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
function normalizeUnknown(value, fallback) {
    if (!Array.isArray(value))
        return [...fallback];
    const out = [];
    for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0)
            out.push(item.trim());
    }
    return out.length > 0 ? out : [...fallback];
}
function parseReviewer(content) {
    const cleaned = content
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
    const candidates = [cleaned];
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first)
        candidates.push(cleaned.slice(first, last + 1));
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // try the next candidate
        }
    }
    return undefined;
}
function emptyDebate(status, rejected = []) {
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
function advocatePrompt(role, input) {
    const stance = role === "sound"
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
function reviewerPrompt(input, sound, fragile) {
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
async function debate(input, deps) {
    const mode = deps.mode ?? "shadow";
    if (mode === "off") {
        return emptyDebate("off");
    }
    const factsText = typeof input.facts_text === "string" ? input.facts_text : "";
    const factIds = Array.isArray(input.flag_ids) ? input.flag_ids : [];
    const unknownIn = Array.isArray(input.unknown) ? input.unknown : [];
    const timeoutMs = typeof deps.timeoutMs === "number" && deps.timeoutMs > 0
        ? deps.timeoutMs
        : exports.DEFAULT_TIMEOUT_MS;
    if (factsText.trim().length === 0) {
        const debateOut = emptyDebate("rejected", ["empty_facts"]);
        if (deps.log) {
            try {
                deps.log(debateOut);
            }
            catch {
                // a broken logger never breaks the debate
            }
        }
        return debateOut;
    }
    const contextTokens = estimateContextTokens(factsText + reviewerPrompt(input, "", ""));
    const rejected = [];
    const models = {};
    let usd = 0;
    const call = async (role, system, prompt, maxTokens) => {
        const result = await withTimeout(deps.route({
            task_type: "risk_debate",
            tier_class: "text",
            complexity: role === "reviewer" ? "apex" : "exec",
            context_tokens: contextTokens,
            constitutional_flag: false,
            agent_id: "golden-kog",
            payload: { role, system, prompt, max_tokens: maxTokens },
        }), timeoutMs);
        const cost = typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd)
            ? result.cost_usd
            : 0;
        usd += cost;
        if (typeof result.model === "string" && result.model.length > 0) {
            models[role] = result.model;
        }
        return result;
    };
    const advocate = async (role) => {
        const result = await call(role, ADVOCATE_SYSTEM, advocatePrompt(role, input), 900);
        const content = typeof result.content === "string" ? result.content : "";
        const problems = reviewPart(content, factsText, exports.MAX_ADVOCATE_WORDS, deps.check);
        if (problems.length > 0) {
            for (const problem of problems)
                rejected.push(`${role}:${problem}`);
            return exports.ADVOCATE_PLACEHOLDER;
        }
        return content.trim();
    };
    let sound = "";
    let fragile = "";
    try {
        const results = await Promise.all([advocate("sound"), advocate("fragile")]);
        sound = results[0] ?? exports.ADVOCATE_PLACEHOLDER;
        fragile = results[1] ?? exports.ADVOCATE_PLACEHOLDER;
    }
    catch (error) {
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
        const result = await call("reviewer", REVIEWER_SYSTEM, reviewerPrompt(input, sound, fragile), 700);
        reviewerContent = typeof result.content === "string" ? result.content : "";
    }
    catch (error) {
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
    const problems = reviewPart(reviewerText, factsText, exports.MAX_REVIEWER_WORDS, deps.check);
    if (problems.length > 0) {
        const out = emptyDebate("rejected", [...rejected, ...problems.map((p) => `reviewer:${p}`)]);
        out.usd = roundUsd(usd);
        out.models = models;
        return out;
    }
    const weight = [];
    if (Array.isArray(parsed.weight)) {
        for (const item of parsed.weight) {
            if (typeof item === "string" && factIds.includes(item) && !weight.includes(item)) {
                weight.push(item);
            }
        }
    }
    else if (parsed.weight !== undefined && parsed.weight !== null) {
        rejected.push("reviewer:weight_not_array");
    }
    const out = {
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
        const tensionProblems = reviewPart(tension, factsText, exports.MAX_REVIEWER_WORDS, deps.check);
        if (tensionProblems.length === 0) {
            out.tension = tension.trim();
        }
        else {
            for (const problem of tensionProblems)
                rejected.push(`tension:${problem}`);
        }
    }
    if (deps.log) {
        try {
            deps.log(out);
        }
        catch {
            // ignore
        }
    }
    return out;
}
/** Alias kept for the wiring contract used by some Golden Kog builds. */
exports.discuss = debate;
exports.default = debate;
