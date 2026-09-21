# What the wish board actually says

Ran the discovery re-rank over the whole live board, 2026-09-21. 400 rows, 57
filtered as adverts by the lexical rule, **331 judged** against live `/api/find`
candidates. About two cents of upstream.

## The result contradicts my own earlier framing

| verdict | all 331 | of the 136 rows with real caller credit |
|---|---|---|
| index-miss (find ranked the wrong tool) | **8** | **3** |
| catalog-gap (we do not sell it) | 100 | 25 |
| confirmed (find was right) | 68 | 55 |
| unclear / consider | 155 | 53 |

**Discovery is not broken. 8 of 331 is 2.4%.** I had argued discovery was the
highest-value judgment point in the codebase and cited find's own comment about
what a wrong top result costs. That comment is still true, and the eight
examples I used to make the case were real, but they were the worst cases I
could find and I generalised from them. At board scale find is right or
defensibly right far more often than my sample implied.

## The board's signal is thinner than its volume

195 of the 331 judged rows carry **zero caller credit**, and those hold most of
the hits. The loudest apparent findings are all in that group:

- "text to speech voiceover", 60 hits, the single biggest index-miss: **0 callers**
- The top catalog gaps by hits - translate, remove image background, todo task
  manager, track a package, book a flight - are all **0 callers**, all first seen
  before 2026-08-27, which is the August bot sweep already documented in
  CLAUDE.md.

The 25 attributable catalog gaps are every one of them **1 hit, 1 caller**, and
several are the same seller phrasing an advert four ways ("arabic rtl text check
$1 usdc on base") that the URL-based filter did not catch because it names no URL.

**So: the machinery works and there is very little for it to find.** Not because
the judgment failed, but because the board is mostly one machine from August plus
singletons.

## What this changes

1. **The alias proposer yields about three usable aliases, not hundreds.**
   `scripts/propose-aliases.js` turns index-miss verdicts into a diff you approve.
   It is worth having and it is a small win. The honest yield from this run:
   `tts` genuinely wants "text to speech voiceover"; the rest are one-offs and two
   of the generated phrases are bad enough that the tool says so rather than
   proposing them.
2. **Do not build more on the wish board until it has traffic.** Every further
   idea here - clustering, demand ranking, gap prioritisation - is bounded by the
   same thing: 136 attributable rows, almost all singletons.
3. **The router stays unbuilt, and this strengthens that call.** It is 17 calls
   all-time. The demonstration below shows the shape works; nothing suggests
   shipping it would move a number anyone reads.

## Router selection, demonstrated not shipped

Real `/api/route` candidates for "summarise a 40-page contract PDF and pull out
the termination clauses", one Score per candidate in a single call, combined with
coefficients that live in our code (relevance 0.6, health 0.25, price 0.15):

```
  tool              relevance  conf   health  price     composite
  summarize           0.57   0.70       1  $0.008   0.622
  summarize           0.56   0.73       1  $0.008   0.616
  pdf                 0.11   0.67       1  $0.01    0.316
  pdf                 0.07   0.79       1  $0.01    0.292

  winner: summarize   margin over next: 0.006
  gate  : return top-N to the buyer instead (low confidence or a near tie)
```

The gate refusing is the point. The top two are near-identical candidates 0.006
apart; picking one and calling it best would be false precision. Relevance is the
only dimension the model supplies, because health and price are numbers we
already hold and asking a model to re-derive data we can read is how you get a
confident wrong answer about a fact.
