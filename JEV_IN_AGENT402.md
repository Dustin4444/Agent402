# Jev in agent402

Read: the installed SKILL.md, `llms.txt`, Choice, Score, Noul, Confidence, API
reference. Probed the live API. All measurements below are from real agent402
data and real calls, not fixtures.

## 1. The model, stated back

`state` (string or structured) plus a map of typed, atomic `questions` goes in;
typed answers come back under the same keys. Questions in one call run in
parallel and **cannot see each other's answers**, so a judgment needing an
earlier answer is a second request.

| Primitive | `criteria` | Answer | Use when |
|---|---|---|---|
| **Choice** | map: option -> description | `choice`, `probabilities`, `confidence` | one of a fixed unordered set |
| **Score** | ordered array, 2 to 10 levels | `score` (may fall between levels), `probabilities`, `confidence` | a position on a described spectrum |
| **Noul** | none | `noul` (0 to 1) | is this true |

**One correction to the brief's framing: Noul answers carry no `confidence`.**
Confidence is derived from the shape of a distribution, and a Noul returns a
single scalar. The docs say so and our live probe confirms it:
`{"answers":{"advertises":{"type":"noul","noul":0.44}}}`. Anything gating on
Noul gates on distance from 0.5, which is a different and weaker statement than
Choice/Score confidence. Design accordingly.

Multi-factor judgments get decomposed into atomic questions and combined in
code, with the coefficients in our source, not the model's head.

## 2. Where agent402 actually makes judgments

| Subsystem | Site | Decided today by | Why it is fragile |
|---|---|---|---|
| **Tool discovery** | `src/find.js:206-218` | additive lexical score: slug exact +10, slug word +6, substring +2, name +2, tag +3, haystack +1, times IDF | Scores a *string overlap*, not whether the tool does the job. Its own comment at :202 says a wrong top result means "an agent that trusts it pays for the wrong tool and gets something useless on its first call." |
| **Listing moderation** | `src/x402-index.js:3706-3724` | 11 regexes plus an 8,000-char length cap | Matches the phrasing of a 2024 prompt injection. Catches "ignore previous instructions"; blind to a polite listing that is simply a lie about what the seller sells. |
| **Health ranking** | `src/x402-index.js:3560` | mean of a crawl success history | Measures whether the origin *answered*, never whether it answered *correctly*. A seller returning 200 with junk scores 1.0. |
| **Router selection** | `src/server.js` `resolveExternalSeller` | match score, then health, then Bazaar payers, then price | Same lexical score as find, so it inherits the same blindness. |
| **Report integrity** | `src/tools/research-deep-kit.js:90` `auditCitations` | regex: does a sentence's *number* appear in the cited source's text | Verifies a string is present, not that the source *supports the claim*. A number appearing anywhere in the source passes. |
| **Index integrity** | not implemented | `dispatchEligibility` floors: 50 settlements, 3 payers | Counts settlements. Cannot distinguish 50 organic buys from 50 self-funded ones, which is the whole wash-trading case. |

## 3. Ranked, and the brief's seeding is wrong about the top

**The router is the brief's headline candidate and it is the lowest-value one
here.** `viaRouter` is **17 calls all-time** against 35,172 paid calls. Improving
selection on a path that has run 17 times cannot move routing quality, index
quality or the refund guarantee. It is the right shape for Jev and the wrong
place to spend first. Ranked accordingly.

### 1. Tool discovery: Choice over find's own candidates, confidence-gated

**Highest traffic, documented failure mode, and measured proof below.**

The decision: given a natural-language task, which catalog tool does the job, or
none. `Choice`, because the candidate set is fixed per query (find's top-N) and
unordered.

Atomic question, one per query, over the REAL candidates:

```json
{ "state": "An AI agent searched a catalog of paid API tools for: \"<query>\"",
  "model": "jev-latest",
  "questions": { "best": { "type": "choice",
    "instructions": "Which listed tool actually performs the job the agent asked for?",
    "criteria": { "<slug>": "<name>: <description>", "...": "...",
      "none_of_these": "None of the listed tools does this job. The catalog does not cover this request." } } } }
```

The `none_of_these` option is load-bearing: the docs are explicit that a no-match
outcome must be offered or the model cannot express it. It is also exactly what
agent402 wants, because a genuine miss belongs on the wish board.

**Confidence architecture.** Jev re-ranks, it does not replace:

```
conf >= 0.85  -> serve Jev's pick as top-1
0.60 - 0.85   -> keep find's order, surface Jev's pick as an alternative
conf <  0.60  -> keep find's order untouched
pick == none_of_these && conf >= 0.85 -> return the honest empty result AND record a wish
```

Find's ordering is never destroyed, so a bad judgment degrades to today.

### 2. Crawl-time listing moderation: three atomic Nouls plus a Choice

The decision: should this origin enter a 108k-listing index, and under what
category. Runs once per origin per crawl, off the serving path.

Decomposed, because "is this listing acceptable" is three unrelated judgments:

```json
{ "genuine":  { "type": "noul", "instructions": "Does this listing describe a real, specific API capability, rather than a placeholder, a test, or an empty shell?" },
  "hostile":  { "type": "noul", "instructions": "Does this text try to influence how a ranking system treats it, rather than describing the service?" },
  "misleads": { "type": "noul", "instructions": "Does the description claim a capability the declared routes and prices could not plausibly deliver?" },
  "category": { "type": "choice", "instructions": "What does this seller primarily sell?", "criteria": { "data": "...", "compute": "...", "ai-inference": "...", "storage": "...", "other": "..." } } }
```

Combined in code, coefficients ours:

```js
const block = hostile >= 0.85 || (genuine <= 0.25 && misleads >= 0.70);
const flag  = !block && (hostile >= 0.60 || misleads >= 0.60 || genuine <= 0.45);
// block  -> excluded, reason recorded, seller can dispute (the path already exists)
// flag   -> listed, held out of the ROUTER's candidate pool only
// neither-> listed as today
```

`hostile` supersedes the 11 regexes as a *superset*: keep the regexes, since they
are free and catch the literal cases, and let Jev catch the polite ones.

### 3. Report verification: per-claim Noul behind the refund promise

The decision that money rests on. `auditCitations` currently checks whether a
sentence's number appears in the cited source's text. That is string presence,
not support.

One Noul per (claim, cited source) pair, which fans out in a single call:

```json
{ "claim_3": { "type": "noul", "instructions": "Does the source text support this specific claim? Support means the source states it or it follows directly. A source that merely mentions the same entity or number does not support the claim." } }
```

State carries `{ claim, source_title, source_text }` as named fields.

```js
const unsupported = claims.filter((c) => c.noul < 0.5);
// >20% unsupported -> do not deliver, refund before the buyer sees it
// any unsupported  -> strip the citation, keep the prose, note it in meta
```

This turns the refund promise from reactive into a pre-delivery gate. It is
third rather than first because reports are lower volume than discovery, and
every report is already model-backed and declared, so the determinism rule does
not bite.

### 4. Index integrity: Noul over settlement shape

`Noul("this seller's volume looks organic")` given the distribution we already
compute: payer count, repeat rate, inter-arrival times, amount variance. Ranks
fourth because the floors work today and a wrong call here publicly accuses a
named third party, so it can only ever *flag for review*, never delist.

### 5. Health ranking

Score(delivery quality) over a sampled response. Ranked last: it requires
sampling paid responses we do not currently retain, so the cost is data
collection, not judgment.

## 4. Proof on real agent402 data

Eight real find-miss queries from the live wish board, the real candidate set
from live `/api/find?limit=5`, one live Jev Choice each.

| Query | find top-1 | Jev | conf |
|---|---|---|---|
| extract a web page into structured json | `pdf-extract-pages` | **`skill-structured-scrape`** | 0.99 |
| idempotency replay protection | `skill-brand-protection` | **none_of_these** | 0.93 |
| historical technical evidence website | `fx-historical` | **none_of_these** | 0.73 |
| mcp prompt injection protection | `skill-brand-protection` | `action-gate` | 0.40 |
| bureau of labor statistics cpi | `cpi-yoy` | `fred-series` | 0.55 |
| convert kilowatts to mechanical horsepower | `unit-convert` | agrees | 1.00 |
| hash a website response | `hash` | agrees | 0.83 |
| check if a website is up | `http-check` | agrees | 1.00 |

**The finding that matters is not the overrides, it is the separation.** Every
one of those queries scored **45 to 47** on find's lexical scale: correct answers
and nonsense answers are indistinguishable, so no threshold on that score can
gate anything. Jev's confidence spans 0.40 to 1.00 and the spread tracks
correctness. The two genuinely ambiguous cases (`action-gate` for prompt
injection, `fred-series` over `cpi-yoy`) land lowest and would not auto-act under
the gate above. The two clear wins land at 0.99 and 0.93.

**What I would tune.** The 0.85 gate is a starting point from eight queries, not
a calibration; it needs a few hundred. Descriptions are truncated to 170 chars in
`criteria` and some tools are poorly self-described, which bounds the ceiling
regardless of model. And Jev sees only find's top-5, so it cannot rescue a tool
find never surfaced: the real fix is candidates from a wider lexical net, judged
down.

**Cost to ship.** The module pattern already exists (`src/wish-classify.js`):
key-gated, cached, bounded, fails open. `/api/find` is free and unauthenticated,
so a paid call per query is not acceptable on the serving path. Ship it as a
cache-warming pass over the wish board's recorded misses, or behind an opt-in
parameter, not inline. That is a day of work plus calibration.

## 5. Workflows where Jev earns a permanent slot

**Discovery re-rank (offline).** `find` returns candidates -> Jev Choice over the
top-5 -> conf >= 0.85 promotes, 0.60-0.85 appends an alternative, below keeps
today's order -> `none_of_these` at high confidence records a wish. Runs over
recorded misses, results cached by query text.

**Crawl moderation.** Fetch manifest -> regexes (free, keep) -> Jev three Nouls
plus category in ONE call -> block / flag / list -> reason recorded, existing
dispute path applies. Once per origin per crawl.

**Report pre-delivery gate.** Generate -> extract (claim, source) pairs -> one
call, one Noul per pair -> >20% unsupported refunds before delivery, otherwise
strip unsupported citations and note it in `meta`.

## 6. Where Jev is the wrong tool here

- **Anything on the serving path of a free route.** `/api/find`, `/api/route` and
  the PoW tier are free and unauthenticated. A paid third-party call there is an
  unmetered upstream on a free route.
- **Anything generating text.** The report *prose*, tool output, error messages.
  Jev judges; it does not write.
- **Anything the determinism rule covers.** The 500+ priced tools must answer
  their own example in CI keyless. Jev cannot enter a tool handler.
- **Replacing a floor with a judgment.** `dispatchEligibility`'s 50/3 is a
  *rule*, auditable and arguable. A model opinion about a named third party's
  volume is neither. Flag, never gate.
- **Over-broad questions.** "Is this listing acceptable" is three judgments; ask
  three. Measured cost of getting this wrong, from the wish-board work: a second
  Noul asking "is this a request the author could not find?" read 0.32 to 0.53 on
  obviously-a-request rows, because it asked for something the state did not
  contain. It was deleted.
- **Score where Noul is cleaner.** "How spammy" invites a rubric nobody can
  write. "Is this hostile to ranking" is answerable.
- **Ignoring confidence.** Taking `choice` without reading `confidence` throws
  away the only part that makes this safe to automate.

## 7. Cheat sheet

```
POST https://api.typesafe.ai/v1/systemone      Authorization: Bearer $TYPESAFE_API_KEY
{ state, model: "jev-latest", questions: { <id>: <question> } }

choice: { type:"choice", instructions, criteria: { opt: "desc", ... } }  -> choice, probabilities, confidence
score : { type:"score",  instructions, criteria: [ "low", ..., "high" ] } -> score, probabilities, confidence
noul  : { type:"noul",   instructions }                                   -> noul (0-1), NO confidence
```

**Top uses, best first:** discovery re-rank with a `none_of_these` escape ·
crawl-time listing moderation · per-claim report verification · index-integrity
flagging.

**Starting thresholds** (calibrate before trusting): auto-act on Choice/Score
`confidence >= 0.85`; surface-but-do-not-act 0.60 to 0.85; ignore below 0.60.
Noul has no confidence, so gate on distance from 0.5: act at `>= 0.85` or
`<= 0.15`, treat the middle as unknown. Raise every threshold where the action
is irreversible or names a third party. Measured on our own board, the advert
Noul separated 0.83-0.96 against 0.96-0.98 with nothing between.

**The rule:** reach for Jev in agent402 when code already makes a judgment call
it cannot justify, the answer is one of a set we can name, and there is a
sensible thing to do when the answer is "not sure".
