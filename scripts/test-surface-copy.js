// Surface-copy gate: every surface that names what Agent402 IS must name the
// category (Agentic Finance / AIFI) and BOTH payment wires (x402 and MPP).
//
// Why a gate and not a sweep: on 2026-08-18 a hand sweep found the site (134
// pages) fully positioned but the eight JS adapters + the Python adapter, the
// hosted MCP serverInfo/instructions, /api/pricing's description, and 25 wiki
// pages still single-wire or moniker-less - copy that had been updated once by
// hand on the "main" surfaces and never on the long tail. The sweep is now this
// file, so a new package, wiki page or connector string that ships without the
// positioning fails CI instead of quietly reading as x402-only.
//
// Offline: reads the repo, calls the pure text generators (llms.txt, MCP
// instructions), never boots a server or touches the network.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { llmsTxt } from "../src/seo.js";
import { MCP_SERVER_DESCRIPTION as HOSTED_DESC, mcpInitializeInstructions as hostedInstructions } from "../src/mcp-flagship.js";
import { MCP_SERVER_DESCRIPTION as STDIO_DESC, mcpInitializeInstructions as stdioInstructions } from "../mcp/output-schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const hasAifi = (s) => /Agentic Finance/.test(s);
const hasMpp = (s) => /\bMPP\b/.test(s);
const hasX402 = (s) => /x402/i.test(s);
const all3 = (s) => hasAifi(s) && hasMpp(s) && hasX402(s);

// --- npm packages: description + keywords ---------------------------------------
const pkgDirs = ["mcp", "client", "tollbooth", ...readdirSync(join(ROOT, "adapters")).map((d) => `adapters/${d}`).filter((d) => existsSync(join(ROOT, d, "package.json")))];
for (const d of pkgDirs) {
  const pkg = JSON.parse(read(`${d}/package.json`));
  ok(all3(pkg.description || ""), `${d}/package.json description names Agentic Finance + MPP + x402`);
  const kw = (pkg.keywords || []).map((k) => String(k).toLowerCase());
  ok(kw.includes("aifi") && kw.includes("agentic-finance") && kw.includes("mpp") && kw.includes("x402"), `${d}/package.json keywords carry aifi, agentic-finance, mpp, x402`);
  const readme = read(`${d}/README.md`);
  ok(hasAifi(readme.slice(0, 2500)) && hasMpp(readme.slice(0, 2500)), `${d}/README.md lead (first 2.5k chars) names Agentic Finance + MPP`);
}
// Python adapter (PyPI)
if (existsSync(join(ROOT, "adapters/langchain-py/pyproject.toml"))) {
  const py = read("adapters/langchain-py/pyproject.toml");
  const desc = (py.match(/^description = "(.*)"$/m) || [])[1] || "";
  ok(all3(desc), "adapters/langchain-py/pyproject.toml description names Agentic Finance + MPP + x402");
  const kwLine = (py.match(/^keywords = \[(.*)\]$/m) || [])[1] || "";
  ok(/"aifi"/.test(kwLine) && /"mpp"/.test(kwLine) && /"agentic-finance"/.test(kwLine), "langchain-py keywords carry aifi, mpp, agentic-finance");
  const readme = read("adapters/langchain-py/README.md");
  ok(hasAifi(readme.slice(0, 2500)) && hasMpp(readme.slice(0, 2500)), "adapters/langchain-py/README.md lead names Agentic Finance + MPP");
}
// MCP registry manifest
const serverJson = JSON.parse(read("mcp/server.json"));
ok(all3(serverJson.description || ""), "mcp/server.json description names Agentic Finance + MPP + x402");

// --- repo README + docs ----------------------------------------------------------
ok(all3(read("README.md").slice(0, 3000)), "README.md lead names Agentic Finance + MPP + x402");
ok(all3(read("docs/ecosystem-listings.md")), "docs/ecosystem-listings.md (listing copy) names all three");

// --- wiki: every page names MPP; identity pages name the moniker ------------------
const wikiPages = readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md"));
const wikiMissingMpp = wikiPages.filter((f) => f !== "_Sidebar.md" && !hasMpp(read(`wiki/${f}`)));
ok(wikiMissingMpp.length === 0, `every wiki page names MPP (missing: ${wikiMissingMpp.join(", ") || "none"})`);
for (const f of ["Home.md", "_Sidebar.md", "_Footer.md", "Agentic-Finance.md", "Paying-with-MPP.md", "Paying-with-x402.md"]) {
  ok(hasAifi(read(`wiki/${f}`)), `wiki/${f} names Agentic Finance`);
}
ok(hasMpp(read("wiki/_Footer.md")) && hasX402(read("wiki/_Footer.md")), "wiki/_Footer.md (every wiki page's footer) names both wires");

// --- connectors: serverInfo description + initialize instructions ------------------
ok(HOSTED_DESC === STDIO_DESC, "hosted and stdio MCP server descriptions are byte-identical (one source of truth per surface, kept in sync)");
ok(all3(HOSTED_DESC), "MCP serverInfo.description names Agentic Finance + MPP + x402");
const hi = hostedInstructions("https://example.test"), si = stdioInstructions("https://example.test");
ok(all3(hi) && all3(si), "MCP initialize instructions (hosted + stdio) name Agentic Finance + MPP + x402");
ok(hi === si, "hosted and stdio initialize instructions are byte-identical");
ok(/positioning: `Agent402 is the applied layer of Agentic Finance \(AIFI\)/.test(read("src/mcp-http.js")), "hosted describe_server carries a positioning field naming AIFI");
ok((read("mcp/index.js").match(/positioning: `[^`]*Agentic Finance \(AIFI\)[^`]*MPP/g) || []).length >= 2, "stdio describe payloads (both aliases) carry AIFI + MPP positioning");

// --- machine surfaces ---------------------------------------------------------------
const llms = llmsTxt("https://example.test", {});
ok(all3(llms.slice(0, 4000)), "llms.txt lead names Agentic Finance + MPP + x402");
ok(/description: `Agentic Finance \(AIFI\) applied layer[^`]*MPP/.test(read("src/server.js")), "/api/pricing description names AIFI + MPP");
ok(all3(read("src/discovery.js")), "/.well-known/x402 manifest source names Agentic Finance + MPP + x402");
ok(hasAifi(read("src/agentic-finance.js")) && hasAifi(read("src/glossary.js")), "category + glossary pages exist");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
