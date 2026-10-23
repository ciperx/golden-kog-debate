"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { debate, discuss, ADVOCATE_PLACEHOLDER } = require("../dist/debate.js");

const FACTS = [
  "Top holder share is 12.5 percent.",
  "Liquidity is locked for 180 days.",
  "Two flags fired.",
].join("\n");

const SOUND =
  "Top holder share is 12.5 percent and liquidity is locked for 180 days. The fired flags are contained by the lock and the measured supply stays where it is.";
const FRAGILE =
  "A top holder share of 12.5 percent is concentrated. The 180 day lock expires while the measured exposure stays with few holders.";
const REVIEWER_TEXT =
  "The 12.5 percent holder concentration carries more weight than the 180 day lock.";
const REVIEWER_JSON = JSON.stringify({
  text: REVIEWER_TEXT,
  weight: ["H1", "ZZZ"],
  unknown: ["holder intent"],
  tension: "The lock is real but it ends.",
});

const FORBIDDEN = [
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

function adviceHits(text) {
  const lower = String(text).toLowerCase();
  return FORBIDDEN.filter((phrase) =>
    new RegExp(`(?<![a-z0-9])${phrase}(?![a-z0-9])`, "i").test(lower),
  );
}

function baseInput(overrides) {
  return {
    facts_text: FACTS,
    level: "medium",
    points: 42,
    flag_ids: ["H1", "L2"],
    unknown: ["holder intent"],
    ...overrides,
  };
}

/**
 * Fake route with per role replies. `replies.sound` etc may be a string or a
 * function returning {content, model, cost_usd} or a promise of it.
 */
function makeDeps(options = {}) {
  const calls = [];
  const replies = {
    sound: { content: SOUND, model: "exec-a", cost_usd: 0.001 },
    fragile: { content: FRAGILE, model: "exec-b", cost_usd: 0.001 },
    reviewer: { content: REVIEWER_JSON, model: "apex-a", cost_usd: 0.002 },
    ...options.replies,
  };
  const deps = {
    route: async (args) => {
      calls.push({ args, at: Date.now() });
      if (options.onCall) await options.onCall(args, calls);
      const reply = replies[args.payload.role];
      const value = typeof reply === "function" ? await reply(args) : reply;
      if (!value) throw new Error("no reply for " + args.payload.role);
      return value;
    },
    mode: "on",
  };
  if (options.check) deps.check = options.check;
  if (options.log) deps.log = options.log;
  if (options.timeoutMs !== undefined) deps.timeoutMs = options.timeoutMs;
  if (options.mode !== undefined) deps.mode = options.mode;
  return { deps, calls };
}

function assertNoAdvice(result) {
  const strings = [
    result.sound,
    result.fragile,
    result.reviewer,
    result.tension || "",
    ...result.weight,
    ...result.unknown,
    ...result.rejected,
  ];
  for (const value of strings) {
    const hits = adviceHits(value);
    assert.deepEqual(hits, [], `advice language found in: ${value}`);
  }
}

test("A1 the advocates run in parallel with roles sound and fragile, then the reviewer", async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { deps, calls } = makeDeps({
    onCall: async (args) => {
      if (args.payload.role === "reviewer") return;
      started += 1;
      if (started === 2) release();
      // Both advocates must have started before either may finish.
      await gate;
    },
  });

  const result = await debate(baseInput(), deps);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.weight, ["H1"]);
  assert.equal(calls.length, 3);
  const roles = calls.map((c) => c.args.payload.role);
  assert.deepEqual(roles.slice(0, 2).sort(), ["fragile", "sound"]);
  assert.equal(roles[2], "reviewer");
  // The reviewer sees both advocate texts and the facts.
  const reviewerPrompt = calls[2].args.payload.prompt;
  assert.ok(reviewerPrompt.includes(SOUND));
  assert.ok(reviewerPrompt.includes(FRAGILE));
  assert.ok(reviewerPrompt.includes("Top holder share is 12.5 percent."));
  for (const call of calls) {
    assert.equal(call.args.task_type, "risk_debate");
    assert.equal(call.args.tier_class, "text");
    assert.equal(call.args.agent_id, "golden-kog");
    assert.equal(call.args.constitutional_flag, false);
    assert.equal(typeof call.args.context_tokens, "number");
    assert.equal(typeof call.args.payload.system, "string");
    assert.equal(typeof call.args.payload.max_tokens, "number");
  }
  assert.equal(calls[0].args.complexity, "exec");
  assert.equal(calls[1].args.complexity, "exec");
  assert.equal(calls[2].args.complexity, "apex");
  assertNoAdvice(result);
});

test("A2 an advocate number missing from the facts is replaced and the reason kept", async () => {
  const { deps } = makeDeps({
    replies: {
      sound: { content: "Top holder share is 99.9 percent and the lock holds.", cost_usd: 0.001 },
    },
  });
  const result = await debate(baseInput(), deps);

  assert.equal(result.status, "ok");
  assert.equal(result.sound, ADVOCATE_PLACEHOLDER);
  assert.equal(result.sound, "No case could be written from the measured facts.");
  assert.ok(result.rejected.some((r) => r.includes("number_not_in_facts:99.9")));
  assert.equal(result.fragile, FRAGILE);
  assert.equal(result.reviewer, REVIEWER_TEXT);
});

test("A3 refused words, long dashes, non Latin digits, word caps and check problems refuse a part", async () => {
  const cases = [
    "The structure is sound and the 12.5 percent holder is not bullish at all.",
    "Top holder share is 12.5 percent \u2014 the lock holds for 180 days.",
    "Top holder share is \u0661\u0662.5 percent and the lock holds.",
    "structure ".repeat(181).trim(),
  ];
  for (const bad of cases) {
    const { deps } = makeDeps({ replies: { sound: { content: bad, cost_usd: 0 } } });
    const result = await debate(baseInput(), deps);
    assert.equal(result.sound, ADVOCATE_PLACEHOLDER, `should refuse: ${bad.slice(0, 40)}`);
    assert.ok(result.rejected.length > 0);
    assertNoAdvice(result);
  }

  const { deps } = makeDeps({ check: () => ["caller guard says no"] });
  const blocked = await debate(baseInput(), deps);
  // The guard fails the reviewer too, so the whole debate is dropped.
  assert.equal(blocked.status, "rejected");
  assert.equal(blocked.sound, "");
  assert.equal(blocked.reviewer, "");
  assert.ok(blocked.rejected.some((r) => r.includes("caller guard says no")));
});

test("A3 a clean check() keeps both advocate texts", async () => {
  const seen = [];
  const { deps } = makeDeps({
    check: (text) => {
      seen.push(text);
      return [];
    },
  });
  const result = await debate(baseInput(), deps);
  assert.equal(result.sound, SOUND);
  assert.equal(result.fragile, FRAGILE);
  assert.ok(seen.length >= 3);
});

test("A4 the reviewer JSON is parsed, weight is filtered and bad JSON rejects the debate", async () => {
  const { deps } = makeDeps();
  const result = await debate(baseInput(), deps);
  assert.equal(result.reviewer, REVIEWER_TEXT);
  assert.deepEqual(result.weight, ["H1"]);
  assert.deepEqual(result.unknown, ["holder intent"]);
  assert.equal(result.tension, "The lock is real but it ends.");

  const bad = makeDeps({ replies: { reviewer: { content: "not json at all", cost_usd: 0.002 } } });
  const rejected = await debate(baseInput(), bad.deps);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.sound, "");
  assert.equal(rejected.fragile, "");
  assert.equal(rejected.reviewer, "");
  assert.ok(rejected.rejected.some((r) => r.includes("unparseable_json")));
});

test("A4 a reviewer part breaking the rules drops the debate with the reason kept", async () => {
  const { deps } = makeDeps({
    replies: {
      reviewer: {
        content: JSON.stringify({ text: "The 77.7 percent holder dominates.", weight: ["H1"] }),
        cost_usd: 0,
      },
    },
  });
  const result = await debate(baseInput(), deps);
  assert.equal(result.status, "rejected");
  assert.equal(result.reviewer, "");
  assert.ok(result.rejected.some((r) => r.includes("number_not_in_facts:77.7")));
});

test("A5 a call over timeoutMs gives status timeout without throwing", async () => {
  const { deps } = makeDeps({
    timeoutMs: 25,
    replies: { sound: () => new Promise(() => {}) },
  });
  const result = await debate(baseInput(), deps);
  assert.equal(result.status, "timeout");
  assert.equal(result.shown, false);
  assert.equal(result.reviewer, "");
  assertNoAdvice(result);
});

test("A5 a reviewer over timeoutMs also gives status timeout", async () => {
  const { deps } = makeDeps({
    timeoutMs: 25,
    replies: { reviewer: () => new Promise(() => {}) },
  });
  const result = await debate(baseInput(), deps);
  assert.equal(result.status, "timeout");
  assert.equal(result.sound, "");
  assert.equal(result.fragile, "");
});

test("A6 mode off makes no call and shadow logs shown false while on shows", async () => {
  const off = makeDeps({ mode: "off" });
  const offResult = await debate(baseInput(), off.deps);
  assert.equal(off.calls.length, 0);
  assert.equal(offResult.status, "off");
  assert.equal(offResult.shown, false);
  assert.equal(offResult.usd, 0);

  const logged = [];
  const shadow = makeDeps({ mode: "shadow", log: (row) => logged.push(row) });
  const shadowResult = await debate(baseInput(), shadow.deps);
  assert.equal(shadow.calls.length, 3);
  assert.equal(shadowResult.status, "ok");
  assert.equal(shadowResult.shown, false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, "ok");
  assert.equal(logged[0].shown, false);

  const on = makeDeps({ mode: "on" });
  const onResult = await debate(baseInput(), on.deps);
  assert.equal(onResult.shown, true);

  assert.equal(Number(shadowResult.usd.toFixed(6)), 0.004);
  assert.equal(shadowResult.models.sound, "exec-a");
  assert.equal(shadowResult.models.reviewer, "apex-a");
});

test("A6 an empty facts_text is rejected without any call", async () => {
  const { deps, calls } = makeDeps();
  const result = await debate(baseInput({ facts_text: "   " }), deps);
  assert.equal(result.status, "rejected");
  assert.equal(calls.length, 0);
  assert.ok(result.rejected.includes("empty_facts"));
  assert.equal(result.sound, "");
});

test("A6 the debate never returns or changes level and points", async () => {
  const { deps } = makeDeps();
  const result = await debate(baseInput({ level: "high", points: 91 }), deps);
  assert.equal("level" in result, false);
  assert.equal("points" in result, false);
  assert.equal(result.status, "ok");
  assert.equal(typeof discuss, "function");
});

test("A7 no output ever contains advice language", async () => {
  const runs = [
    makeDeps(),
    makeDeps({ replies: { sound: { content: SOUND + " Buy now.", cost_usd: 0 } } }),
    makeDeps({
      replies: {
        reviewer: {
          content: JSON.stringify({ text: "Price target 12.5.", weight: ["H1"] }),
        },
      },
    }),
    makeDeps({ replies: { reviewer: { content: "{}" } } }),
  ];
  for (const run of runs) {
    const result = await debate(baseInput(), run.deps);
    assertNoAdvice(result);
    const rendered = JSON.stringify(result);
    assert.equal(rendered.includes("price target"), false);
    assert.equal(rendered.includes("Buy now"), false);
  }
});

test("A7 the README shows the flow, the rules, an example and credits TradingAgents", async () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.ok(readme.includes("TradingAgents"));
  assert.ok(readme.includes("TauricResearch"));
  assert.ok(readme.includes("Apache 2.0"));
  assert.ok(readme.includes("debate(input"));
  assert.ok(readme.includes("status"));
  assert.ok(/never.*(advice|trading)/is.test(readme));
  assert.ok(readme.includes("shadow"));
});
