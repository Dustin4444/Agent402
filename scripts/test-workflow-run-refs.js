// Every `workflow_run.workflows` entry must name a workflow that EXISTS.
//
// GitHub matches these by the workflow's `name:`, not its filename, and a
// mismatch is silent: the trigger simply never fires. That is the same shape as
// the canary gate that reported green for five days while it had stopped
// buying, so it gets a test rather than a careful reading. Written after the
// published-package verifier shipped referencing "Deploy" when the workflow is
// actually called "Deploy to Railway".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const names = new Set();
for (const f of files) {
  const m = readFileSync(join(DIR, f), "utf8").match(/^name:\s*(.+?)\s*$/m);
  if (m) names.add(m[1].replace(/^["']|["']$/g, ""));
}
ok(names.size > 0, `found ${names.size} workflow names across ${files.length} files`);

let refs = 0;
for (const f of files) {
  const src = readFileSync(join(DIR, f), "utf8");
  for (const m of src.matchAll(/workflows:\s*\[([^\]]*)\]/g)) {
    for (const raw of m[1].split(",")) {
      const want = raw.trim().replace(/^["']|["']$/g, "");
      if (!want) continue;
      refs++;
      ok(names.has(want), `${f}: workflow_run references ${JSON.stringify(want)}, which exists (GitHub matches on name:, and a mismatch never fires - silently)`);
    }
  }
}
console.log(`\n${pass} passed, 0 failed (${refs} workflow_run reference(s) checked)`);
