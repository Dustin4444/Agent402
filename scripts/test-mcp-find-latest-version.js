// Offline test for scripts/mcp-find-latest-version.js — the helper the
// publish job in deploy.yml pipes the MCP Registry's search response
// through, right before publishing, to capture which version is ABOUT to
// become stale so it can be deprecated right after the new one goes live.
// Drives the real CLI script via child_process + stdin, not a re-import of
// its logic, since the script IS the interface (deploy.yml pipes into it).
//
//   node scripts/test-mcp-find-latest-version.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mcp-find-latest-version.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function run(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out));
    child.stdin.write(input);
    child.stdin.end();
  });
}

const FIXTURE = JSON.stringify({
  servers: [
    { server: { version: "0.10.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
    { server: { version: "0.11.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
    { server: { version: "0.12.5" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } },
  ],
});

const NO_LATEST = JSON.stringify({
  servers: [
    { server: { version: "0.10.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
  ],
});

const out1 = await run(FIXTURE);
ok(out1 === "0.12.5", `finds the isLatest:true row's version (got "${out1}")`);

const out2 = await run(NO_LATEST);
ok(out2 === "", `no row is isLatest -> empty output, not a crash (got "${out2}")`);

const out3 = await run("{}");
ok(out3 === "", "empty servers list -> empty output");

const out4 = await run("not json at all");
ok(out4 === "", "unparseable input -> empty output, never a throw (the caller treats blank as 'nothing to deprecate')");

const out5 = await run("");
ok(out5 === "", "empty stdin -> empty output");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
