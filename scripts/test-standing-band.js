#!/usr/bin/env node
// The framing paragraph on /revenue, /proof and /leaderboard.
//
// It exists because a diligence review found the same thing on all three:
// every number was true, published on purpose, and unframed - so the reader
// supplied the frame, and the frame they reach for from "$109 lifetime" is
// "small business" rather than "market operator that publishes its own P&L".
//
// The band is the one sentence asking to be trusted, which makes two things
// non-negotiable: every figure is DERIVED, and a cold cache says NOTHING
// rather than a wrong number.
import { strict as assert } from "node:assert";
import { standingBand } from "../src/standing.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// --- a cold or half-loaded index must stay silent ---------------------------
// The crawl cache warm-starts incrementally and holds only our own entry for
// the first seconds of a boot. "1 seller origin indexed" is true and useless,
// and publishing it inside the sentence that asks to be trusted is worse than
// publishing nothing.
for (const cold of [{}, { sellers: 0 }, { sellers: 1, listings: 581, rails: 12 }, { sellers: 49 }]) {
  ok(standingBand(cold) === "", `a cold index publishes no frame (${JSON.stringify(cold)})`);
}
ok(standingBand({ sellers: 50 }) !== "", "at the floor it speaks");

// --- warm: every figure present, and the small number said out loud ---------
{
  const t = text(standingBand({ sellers: 4153, listings: 101583, settled: 42934, ourUsd: 109.42, rails: 12 }));
  ok(/4,153 seller origins indexed/.test(t), "sellers, with thousands separators");
  ok(/101,583 tool listings/.test(t), "listings");
  ok(/42,934 settlements through these gates/.test(t), "settlements, described as throughput rather than revenue");
  ok(/12 payment rails/.test(t), "rails");
  ok(/\$109\.42 is ours/.test(t),
     "OUR OWN NUMBER IS IN THE SAME BREATH - the argument is that we publish it, so burying it would forfeit the argument");
  ok(/we index this market, we are not trying to be it/.test(t), "and the frame is stated, not implied");
  ok(/ranks other sellers above this one/.test(t),
     "the leaderboard ranking a rival above us is cited AS the evidence of neutrality, which is the reason to trust the index at all");
}

// --- grammar, because a framing sentence with a plural bug reads careless ---
{
  const one = text(standingBand({ sellers: 50, settled: 1, rails: 1 }));
  ok(/1 settlement through/.test(one) && !/1 settlements/.test(one), "singular settlement");
  ok(/1 payment rail\b/.test(one) && !/1 payment rails/.test(one), "singular rail");
}

// --- a figure that cannot be read is omitted, never guessed -----------------
{
  const partial = text(standingBand({ sellers: 4153 }));
  ok(/4,153 seller origins indexed/.test(partial), "what is known is stated");
  ok(!/listings|settlements|rails/.test(partial), "and what is not known is simply absent");
  ok(!/\$/.test(partial), "with no dollar figure invented when the ledger could not be read");
}

// --- it is wired into all three pages, from source -------------------------
{
  const { readFileSync } = await import("node:fs");
  for (const [file, label] of [["../src/revenue-live.js", "/revenue"], ["../src/proof.js", "/proof"], ["../src/ledger-leaderboard.js", "/leaderboard"]]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    ok(/standingBand\(/.test(src), `${label} renders the band`);
  }
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/function standingFigures\(\)/.test(server), "one derivation feeds all three");
  ok(/getIndexSnapshot\(\)\?\.totals/.test(server), "...read from the index totals, not typed into the copy");
}

console.log(`\ntest-standing-band: ${n} assertions OK`);
