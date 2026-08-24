#!/usr/bin/env node
// "Has this exact tree already passed the full suite?"
//
// The normal flow pushes to the dev branch, waits for a green run, then merges
// to main - and main runs the identical suite over the identical files again,
// because a merge to main deploys unconditionally by design (see the `on:`
// block in deploy.yml, and the 2026-08-11 incident that put it there). That
// second run is ~13 minutes of duplicated work on every change.
//
// This answers the ONE question that makes skipping it safe: is the tree main
// is about to deploy byte-identical to a tree that already went green? A git
// TREE hash, not a commit hash - a merge commit has a different sha and a
// different parent list, but when main has not moved its tree is exactly the
// branch tip's. Two different commits with the same tree contain the same
// files, so a suite that passed on one cannot fail on the other for any reason
// the suite can see.
//
// Everything here fails CLOSED: any doubt at all runs the tests. The cost of a
// wrong "skip" is shipping untested code; the cost of a wrong "run" is 13
// minutes. Those are not comparable, so nothing is inferred, defaulted, or
// retried into a skip.

/**
 * @param {object} o
 * @param {string} o.eventName    the workflow event
 * @param {string} o.ref          the ref being built
 * @param {string} o.currentTree  git tree hash of the commit under test
 * @param {string[]} o.passedTrees tree hashes of head commits of GREEN runs
 * @returns {{skip: boolean, reason: string}}
 */
export function decideSkip({ eventName, ref, currentTree, passedTrees } = {}) {
  // Only a push to main is ever eligible. A pull_request run is the required
  // status check on the PR itself, and a dispatch is a human explicitly asking
  // for a run - neither may be short-circuited by history.
  if (eventName !== "push") return { skip: false, reason: `not a push (${eventName || "unknown"})` };
  if (ref !== "refs/heads/main") return { skip: false, reason: `not main (${ref || "unknown"})` };
  // A tree hash we could not read is not a tree hash that matched.
  if (!isSha(currentTree)) return { skip: false, reason: "current tree unreadable" };
  if (!Array.isArray(passedTrees) || passedTrees.length === 0) {
    return { skip: false, reason: "no green run to compare against" };
  }
  const clean = passedTrees.filter(isSha);
  if (clean.length !== passedTrees.length) {
    // A malformed entry means the lookup itself is suspect. Do not cherry-pick
    // the well-formed ones out of a result we do not trust.
    return { skip: false, reason: "green-run tree list contained an unreadable entry" };
  }
  if (!clean.includes(currentTree)) return { skip: false, reason: "tree has not passed before" };
  return { skip: true, reason: `tree ${currentTree.slice(0, 12)} already passed the full suite` };
}

// Full 40-hex only. A short hash could collide across the abbreviations git
// hands out at different repo sizes, and "close enough" is not a property that
// should be able to skip a test suite.
function isSha(s) { return typeof s === "string" && /^[0-9a-f]{40}$/.test(s); }

// --- CLI: used by the workflow ----------------------------------------------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { execFileSync } = await import("node:child_process");
  const { appendFileSync, readFileSync } = await import("node:fs");
  const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return ""; } };
  const sh = (cmd, ...a) => { try { return execFileSync(cmd, a, { encoding: "utf8" }); } catch { return ""; } };

  const currentTree = git("rev-parse", "HEAD^{tree}");
  const devBranch = process.env.DEV_BRANCH || "claude/sweet-brown-i99jl3";
  const workflow = process.env.GATE_WORKFLOW || "Deploy to Railway";

  // Head SHAs of recent dev-branch push runs whose TEST LANES all passed.
  //
  // Deliberately not "runs whose conclusion is success". A run can conclude
  // FAILURE because the deploy job lost a Railway race while every test lane
  // went green - measured on 409e33d7, whose three lanes all passed and whose
  // run is red because "Wait for the NEW deployment to reach SUCCESS" failed.
  // Keying on the run's conclusion would refuse to skip a tree that demonstrably
  // passed the suite. It errs safe, but for the wrong reason, and a gate that
  // is right by accident stops being right when the accident changes.
  //
  // What matters is only: did every test lane pass over these files.
  // Derived from the workflow in the tree under test, never hardcoded. This is
  // exact rather than approximate: deploy.yml is ITSELF part of the tree, so a
  // matching tree hash means the suite DEFINITION matched too - the same lanes,
  // the same steps, the same guards. A tree cannot claim a green run from a
  // workflow that tested less than this one does.
  const { load } = await import("js-yaml");
  let LANES = [];
  try {
    const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
    LANES = Object.entries(wf.jobs || {})
      .filter(([n, j]) => /^test(-|$)/.test(n) &&
        (j.steps || []).some((st) => /node\s+scripts\/test-[\w.-]+\.js/.test(String(st.run || ""))))
      .map(([n]) => n);
  } catch { LANES = []; }
  // No lanes discovered means the workflow could not be read, which is not a
  // state in which anything may be skipped.
  if (!LANES.length) {
    console.log("tree-gate: skip=false (could not derive the test lanes from deploy.yml)");
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, "skip=false\nreason=lanes underivable\n");
    }
    process.exit(0);
  }
  console.log(`  lanes required: ${LANES.join(", ")}`);
  let runs = [];
  try {
    const raw = sh("gh", "run", "list", "--workflow", workflow, "--branch", devBranch,
      "--event", "push", "--limit", "15", "--json", "databaseId,headSha");
    runs = JSON.parse(raw || "[]");
  } catch { runs = []; }

  const shas = [];
  for (const r of runs) {
    let jobs = [];
    try {
      const raw = sh("gh", "run", "view", String(r.databaseId), "--json", "jobs");
      jobs = JSON.parse(raw || "{}").jobs || [];
    } catch { continue; }
    const byName = new Map(jobs.map((j) => [j.name, j.conclusion]));
    // Every lane must be present AND successful. A lane that did not run at all
    // is not a lane that passed - that is how a gate learns to trust a run in
    // which the suite was itself skipped.
    if (LANES.every((l) => byName.get(l) === "success") && typeof r.headSha === "string") {
      shas.push(r.headSha);
    }
  }

  // Resolve each qualifying commit to its TREE. The object may not be local on
  // a shallow checkout; fetching one commit is cheap, and a fetch that fails
  // simply drops that candidate instead of poisoning the comparison.
  const passedTrees = [];
  for (const sha of shas) {
    if (!git("cat-file", "-e", `${sha}^{commit}`)) sh("git", "fetch", "--quiet", "--depth", "1", "origin", sha);
    const t = git("rev-parse", `${sha}^{tree}`);
    if (t) passedTrees.push(t);
  }

  const verdict = decideSkip({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    currentTree,
    passedTrees,
  });
  console.log(`tree-gate: skip=${verdict.skip} (${verdict.reason})`);
  console.log(`  current tree : ${currentTree || "(unreadable)"}`);
  console.log(`  green trees  : ${passedTrees.length} from ${shas.length} run(s) with all lanes green on ${devBranch}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `skip=${verdict.skip}\nreason=${verdict.reason}\n`);
  }
}
