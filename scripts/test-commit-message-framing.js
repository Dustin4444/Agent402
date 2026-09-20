#!/usr/bin/env node
// Commit messages carry technical mechanism, not market framing.
//
// The repo rule is that nothing we publish - code, commits, CI text - argues
// about the market: no competitor comparisons, no positioning, no strategy.
// Source FILES have had a guard since 2026-09-13 (test-copy-absolutes), and
// commit messages have had none, so the class kept recurring where nothing
// was looking: a per-buyer comparison against a named seller shipped in a
// commit body on 2026-09-19, and four more stand in history before it.
//
// Those cannot be fixed. The oldest is 2026-06-16, so rewriting them means
// new SHAs for ~90% of the repo, a force-push to a protected branch, and a
// broken .gitleaks.toml commit allowlist - and the old objects stay
// addressable by SHA and live on in every fork, so the text is not withdrawn
// by any of it. What IS controllable is the next one, which is this guard.
//
// SCOPE IS THE PUSH RANGE, never all history: the offenders already merged
// would fail every run forever, and a guard that cannot go green is deleted.
//
// The rules are SHAPES, not strings, for the reason test-copy-absolutes
// learned the hard way - the same claim shipped in four phrasings and a
// string match found one of them. And every rule is pinned in BOTH
// directions below, because a rule that flags honest engineering prose gets
// suppressed by the next author and becomes decoration.
import { execSync } from "node:child_process";

// Naming a seller is not framing: "blockrun's middleware tolerated it" is
// mechanism, and the routing fixes need it. What these match is the ARGUMENT
// - us measured against them, or the market reasoning behind a decision.
const RULES = [
  {
    name: "us-vs-them comparison",
    re: /\b(out-earn|out-earning|out-acquir\w*|out-compet\w*|market share|land ?grab)\b/i,
    why: "compares our standing to someone else's",
  },
  {
    name: "comparative against our own numbers",
    // A QUANTITY, not any digit: "a capture against our own production always
    // exits 1" is a real commit and not a comparison. Requires a dollar
    // figure or a number of at least three digits, which is what a buyer /
    // revenue / settlement comparison actually looks like.
    re: /\bagainst our\b[^.]{0,40}(\$[\d,.]+|\b\d[\d,]{2,}\b)/i,
    why: "sets their figures against ours",
  },
  {
    name: "ranked-seller framing",
    re: /\b(busiest|biggest|largest|top|leading)\s+(seller|competitor|rival)\b|\bcomparable seller\b/i,
    why: "ranks sellers rather than describing a mechanism",
  },
  {
    // "arrival" is the trap: \b on its own is not enough, the word must stand
    // alone. Measured in history - six commits say "dead on arrival".
    name: "rival/competitor as a framing noun",
    re: /(^|[^a-z])(rival|competitors?)([^a-z]|$)/i,
    why: "frames another project as a competitor",
    // Legitimate uses, each a real product or a technical sense:
    //  - market/competitor brief and competitor-scan are things we SELL
    //  - "competing for the runner's network", "a second competing list"
    // A commit that FIXES this class has to be able to name it. "no
    // competitors", "no market framing" is the rule being quoted, not an
    // argument being made - and the other rules still cover a message that
    // cites the rule and then breaks it anyway.
    exempt: /competitor[- ]scan|market ?\/ ?competitor|competitor brief|competing (for|with) (it|the|a)\b|second, competing|\bno (market framing|competitors?|positioning)\b/i,
    // This is the only AMBIGUOUS rule, so it is the only one with an escape.
    // The word is legitimate whenever a commit is REMOVING the framing or
    // quoting what the old text said, which is exactly what a commit fixing
    // this class does - and refusing those would mean the guard forbids its
    // own remedy. The precise rules below and above (out-earning, "against
    // our N", busiest seller, strategic plan) are unambiguous and get no
    // escape, so a message cannot smuggle an argument past this by opening
    // with the word "stop".
    scopedBy: /\b(stop|stops|stopped|drop|drops|dropped|remove[sd]?|removing|no longer|instead of|rather than|replaced?|reworded?|was|said|used to|describ(e|ed|es|ing)|call(s|ed)|carr(y|ied|ies)|read|reads)\b/i,
  },
  {
    name: "strategy framing",
    re: /\b(strategic plan|go-to-market|our moat|the moat|positioning play)\b/i,
    why: "states strategy rather than what the change does",
  },
];

function messages(range) {
  // \x00 between commits: a message body contains blank lines, so no
  // line-based separator can split them reliably.
  const raw = execSync(`git log --format=%B%x00 ${range}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return raw.split("\0").map((m) => m.trim()).filter(Boolean);
}

export function violations(message) {
  const out = [];
  for (const r of RULES) {
    if (!r.re.test(message)) continue;
    if (r.exempt && r.exempt.test(message)) continue;
    // Read the offending LINE joined with the next: a commit body wraps, and
    // a claim split across two lines was invisible to line-by-line matching
    // when test-copy-absolutes hit this.
    const lines = message.split("\n");
    const joined = lines.map((l, i) => `${l} ${lines[i + 1] || ""}`.trim());
    const hit = joined.find((l) => r.re.test(l) && !(r.exempt && r.exempt.test(l)));
    if (!hit) continue;
    // A scoped rule is satisfied only on the line that carries the match, so
    // a removal verb three paragraphs away cannot clear it.
    if (r.scopedBy && r.scopedBy.test(hit)) continue;
    // Quote the MATCH with context around it, not the start of the line.
    // Joining each line with the next catches prose that wraps, but it also
    // means the hit can sit past a head-of-line truncation - reporting
    // evidence that does not contain the offending words reads as a false
    // positive and gets the guard suppressed.
    const m = hit.match(r.re);
    const at = m ? hit.indexOf(m[0]) : 0;
    const from = Math.max(0, at - 45);
    const line = (from > 0 ? "..." : "") + hit.slice(from, at + m[0].length + 55).trim() + (at + m[0].length + 55 < hit.length ? "..." : "");
    out.push({ rule: r.name, why: r.why, line: line.trim().slice(0, 120) });
  }
  return out;
}

// ---- Both directions, from REAL history. The fail cases are the exact
// sentences that shipped; the pass cases are honest commits that name
// sellers, use "competing" technically, or merely contain "arrival".
const MUST_FAIL = [
  ["our median external buyer settles twice, while a comparable seller's busiest single endpoint carries about 233 calls per buyer", "the 2026-09-19 comparison"],
  ["They have 1,933 buyers against our 348, on $70 lifetime against our $145. They are out-acquiring us, not out-earning us.", "the 2026-09-12 note on the numbers"],
  ["a rival board's top row is a gateway wallet with sixteen vendors behind it", "the 2026-09-11 seller sweep"],
  ["The busiest seller on x402scan by buyer count sells one thing", "the 2026-09-12 namespace commit"],
  ["Position #1 from the strategic plan: own the cross-seller discovery", "the June squash commits"],
];
const MUST_PASS = [
  ["SVM payload builder fetches a blockhash when the accept omits one\n\nblockrun's stock middleware tolerated it; api.xfuel.app's own verifier refused it.", "names sellers as mechanism"],
  ["bound the paywall probe; it was competing with it for the runner's network", "'competing' in the technical sense"],
  ["chain names live in one place (this can't drift into a second, competing list)", "a competing LIST, not a competitor"],
  ["Insider flow report + watch, market/competitor brief; card sales ledgered", "market/competitor brief is a product we sell"],
  ["Bound what one buyer can make us spend: an underlying cap makes that tier dead on arrival", "'arrival' must not match 'rival'"],
  ["keep serving through a deploy instead of closing on arrival, never draining at all", "'arrival' again"],
  ["Seller dossier: everything we already hold about one external x402 origin", "describing a product over seller data"],
  ["this host mounts no offer-receipt extension, so a capture against our own production always exits 1 by design", "'against our' + a digit is not a comparison"],
  ["Say \"another seller\" in the shared-hosting threat model\n\nThe comment described the victim as a competitor's listing. The party\nbeing starved is another seller in the index.", "a commit quoting the wording it REMOVES"],
  ["Stop naming a real competitor in the live MCP about/description", "a commit removing the framing"],
  ["Drop market framing from a served source file\n\nThe repo rule is technical mechanism only: no market framing, no\ncompetitors, no positioning.", "a commit FIXING this class must be able to name it"],
];

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let pass = 0, failed = 0;
  const ok = (c, m) => { if (c) { pass++; } else { failed++; console.error(`FAIL - ${m}`); } };

  // The control runs FIRST: a clean scan is only believed once the rules have
  // been shown to catch the real sentences and to leave honest ones alone.
  for (const [text, why] of MUST_FAIL) ok(violations(text).length > 0, `must FLAG: ${why}`);
  for (const [text, why] of MUST_PASS) ok(violations(text).length === 0, `must PASS: ${why} -> ${JSON.stringify(violations(text))}`);

  const range = process.env.COMMIT_RANGE || process.argv[2] || "origin/main..HEAD";
  let msgs = [];
  try { msgs = messages(range); } catch (e) {
    console.log(`commit-message framing: range ${range} unreadable (${String(e.message).slice(0, 60)}) - nothing to scan`);
  }
  for (const m of msgs) {
    const v = violations(m);
    const subject = m.split("\n")[0].slice(0, 70);
    ok(v.length === 0, `commit "${subject}"\n    ${v.map((x) => `${x.rule}: ${x.why}\n      ${x.line}`).join("\n    ")}`);
  }

  console.log(`commit-message framing: ${pass} passed, ${failed} failed (${msgs.length} commit${msgs.length === 1 ? "" : "s"} in ${range})`);
  if (failed) {
    console.error("\nCommit messages carry technical mechanism only: what changed, why, how it is verified.");
    console.error("Market framing belongs in none of it. Reword the commit (git commit --amend / rebase -i) before pushing.");
    process.exit(1);
  }
}
