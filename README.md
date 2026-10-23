# golden-kog-debate

Two sided structure debate for token risk analysis, used inside **Golden Kog**
(the Solana and Base token risk agent).

Two advocates argue from the measured facts: one that the structure is sound,
one that it is fragile. A reviewer then weighs both cases. The module is a
**risk instrument only**. It never returns a level, a points score, a trading
view, a price target, an entry, an exit or any advice. It does not touch the
caller's risk level or points.

The pattern is adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents)
by TauricResearch, licensed under the Apache License 2.0, with its trader and
portfolio manager stages left out. This repository is MIT licensed; the
TradingAgents project remains under Apache 2.0.

## Install

```
npm install
npm run build
npm test
```

Node 22 or newer. There are **no runtime dependencies**. TypeScript is a dev
dependency only, used to compile `src/` into `dist/`.

## Call flow

```
input {facts_text, level, points, flag_ids, unknown}
   |
   +-- mode off ------------------------------> status off, no route call
   |
   +-- advocate "sound"   (complexity exec) --+
   +-- advocate "fragile" (complexity exec) --+  run in parallel
   |                                          |
   |   each part is checked before it is kept  |
   |                                          |
   +-- reviewer (complexity apex) <-----------+  gets both texts and the facts
   |      answers JSON {text, weight, unknown, tension}
   |
   +-- Debate {status, shown, sound, fragile, reviewer, weight, unknown,
               tension, models, usd, rejected}
```

Every route call carries:

```ts
{
  task_type: "risk_debate",
  tier_class: "text",
  complexity: "exec" | "apex",
  context_tokens: number,
  constitutional_flag: false,
  agent_id: "golden-kog",
  payload: { role: "sound" | "fragile" | "reviewer", system, prompt, max_tokens }
}
```

## Contract

```ts
export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate>;
```

`DebateInput` is `{facts_text: string, level: string, points: number, flag_ids: string[], unknown: string[]}`.
`facts_text` holds one measured fact per line, with every number already
computed by the caller.

`DebateDeps` is:

- `route(args)` returns `Promise<{content: string, model?: string, cost_usd?: number}>`.
- `check?(text)` returns extra problems from your own guard. An empty array means the text is fine.
- `mode?: "off" | "shadow" | "on"`, default `"shadow"`.
- `log?(row)` receives the finished `Debate`.
- `timeoutMs?: number`, default `45000`, applied to each call.

`Debate` is
`{status: "ok" | "rejected" | "timeout" | "off", shown: boolean, sound: string, fragile: string, reviewer: string, weight: string[], unknown: string[], tension?: string, models: {sound?, fragile?, reviewer?}, usd: number, rejected: string[]}`.

### Modes

- `off` makes no route call and returns `status: "off"`.
- `shadow` runs everything, passes the debate to `log`, and returns it with `shown: false`.
- `on` runs everything and returns `shown: true`.

`usd` is the sum of the `cost_usd` of the calls that completed.

An empty `facts_text` is refused before any route call: `status: "rejected"`,
empty texts and the reason `empty_facts` in `rejected`.

## Rules every part must pass

A part is an advocate text (`sound`, `fragile`) or the reviewer `text`.

1. Every number in the part appears in `facts_text`, written the same way.
2. None of these words: bull, bear, bullish, bearish, upside, downside target,
   undervalued, overvalued, accumulate, moon, buy now, sell now, price target,
   entry, exit, take profit, not financial advice.
3. `deps.check(text)` returns nothing.
4. At most 180 words for an advocate, 150 for the reviewer.
5. Latin digits only, and no dash characters.

If an advocate part fails, it is replaced with exactly
`No case could be written from the measured facts.` and the reasons are kept in
`rejected`. If the reviewer part fails or its JSON cannot be parsed, the debate
gets `status: "rejected"` and empty texts. A call that runs past `timeoutMs`
gives `status: "timeout"` and never throws. `weight` keeps only ids that are in
`flag_ids`.

## Example

```ts
import { debate } from "golden-kog-debate";

const result = await debate(
  {
    facts_text: [
      "Top holder share is 12.5 percent.",
      "Liquidity is locked for 180 days.",
    ].join("\n"),
    level: "medium",
    points: 42,
    flag_ids: ["holder_concentration"],
    unknown: ["holder intent"],
  },
  {
    route: async (args) => llm.complete(args.payload),
    check: (text) => guard.problems(text),
    mode: "shadow",
    log: (row) => store.insert(row),
  },
);
```

```json
{
  "status": "ok",
  "shown": false,
  "sound": "Top holder share of 12.5 percent is offset by the 180 day liquidity lock, which keeps the float out of reach.",
  "fragile": "A single holder controls 12.5 percent of supply and the 180 day lock is the only thing holding the position in place.",
  "reviewer": "The concentration at 12.5 percent carries more weight than the 180 day lock, which merely delays the same exposure.",
  "weight": ["holder_concentration"],
  "unknown": ["holder intent"],
  "tension": "The lock is measured, the intent behind the position is not.",
  "models": { "sound": "exec-model", "fragile": "exec-model", "reviewer": "apex-model" },
  "usd": 0.0041,
  "rejected": []
}
```

## Tests

```
npm test        # tsc build, then node --test test/*.test.js
```

The suite injects a fake `route` and covers, among others: parallel advocates
(A1), a number that is not in the facts (A2), refused words, long dashes, non
Latin digits, word caps and `check` problems (A3), reviewer JSON parsing and
weight filtering (A4), timeouts (A5), the three modes and `usd` (A6), and the
rule that no output ever carries advice language (A7).

## No advice

This is a risk tool, not a trading tool. It gives no buy or sell view, no price
target, no entry or exit, and no advice of any kind. Nothing it returns is
financial advice.

## License

MIT. See `LICENSE`. The debate pattern is adapted from TradingAgents
(TauricResearch, Apache 2.0).

## Checksums

`SHA256SUMS.txt` lists the sha256 of every shipped source, test and doc file.
