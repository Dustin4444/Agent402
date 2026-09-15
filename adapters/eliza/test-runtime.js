// elizaos-plugin-agent402 against a REAL elizaOS runtime (the registry review
// of 2026-09-14 asked for exactly this, and it is right that a stub runtime
// proves nothing about the host):
//
//   npm pack (THIS package, the artifact npm installs) + @elizaos/core,
//   @elizaos/plugin-sql (PGlite) and @elizaos/plugin-bootstrap at the versions
//   the registry's runtime resolves to -> a real AgentRuntime, initialized,
//   migrations run -> runtime.processActions() is the dispatcher, exactly as
//   the message pipeline calls it after the planner picks an action.
//
// What is stubbed, and why: the MODEL. CI has no LLM, so the runtime's
// OBJECT_SMALL/TEXT_SMALL handlers are a deterministic function that reads the
// extraction prompt and answers in the shape the real model would. Everything
// between the planner's decision and the tool's answer is the real runtime.
//
// Evidence produced (each is an assertion below):
//   1. the ACTIONS provider LISTS AGENT402_CALL for a plain user message - the
//      planner can pick it (validate no longer demands content.slug);
//   2. a normal planner->AGENT402_CALL invocation with NO slug in the message:
//      the handler searches the catalog, asks the runtime's model to pick the
//      tool and shape the input, pays the free tier with proof-of-work, and the
//      sha256 digest comes back;
//   3. the COMPLETE result reaches the model-facing text (the ACTION_STATE
//      provider renders result.text, never result.data) - proven by rendering
//      that provider on the runtime's own action results;
//   4. spend ceilings hold ACROSS calls in one runtime: a $0.003 tool under a
//      $0.005 daily limit settles once and is refused the second time before
//      any request leaves the process (the stub gateway counts one paid call);
//      the per-call ceiling refuses with zero requests; nothing here funds a
//      wallet - the stub gateway is the "seller";
//   5. an upstream error's detail is not truncated on the way to the model;
//   6. the v2 parameter path (options.parameters from the runtime's extractor)
//      is honoured ahead of message content.
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const CORE = process.env.ELIZA_CORE_VERSION || "latest";
const sh = (cmd, opts = {}) => String(execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts }) || "").trim();

// ---- 1. the artifact npm would install, into a scratch host --------------------
const work = process.env.ELIZA_RUNTIME_DIR || join(tmpdir(), `a402-eliza-runtime-${CORE}`);
mkdirSync(work, { recursive: true });
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) sh("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE });
const tgz = join(work, sh("npm pack --silent", { cwd: HERE }).split("\n").pop());
sh(`mv ${JSON.stringify(join(HERE, tgz.split("/").pop()))} ${JSON.stringify(tgz)}`);
if (!existsSync(join(work, "package.json"))) writeFileSync(join(work, "package.json"), JSON.stringify({ name: "a402-eliza-host", private: true, type: "module" }));
const want = `@elizaos/core@${CORE} @elizaos/plugin-sql@${CORE} @elizaos/plugin-bootstrap@${CORE}`;
if (!existsSync(join(work, "node_modules", "@elizaos", "plugin-bootstrap"))) {
  console.log(`installing ${want} into ${work} (once; set ELIZA_RUNTIME_DIR to reuse)`);
  sh(`npm i --no-audit --no-fund --ignore-scripts --silent ${want}`, { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
}
// The tgz depends on a published agent402-client range, which is what a user's
// install resolves; CI tests the TREE, so the local client is installed on top
// (the failure-detail case below needs client >= 0.8.4).
sh(`npm i --no-audit --no-fund --ignore-scripts --silent ${JSON.stringify(tgz)} ${JSON.stringify(join(ROOT, "client"))}`, { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
const imp = (m) => import(pathToFileURL(join(work, "node_modules", m, JSON.parse(readFileSync(join(work, "node_modules", m, "package.json"), "utf8")).main || "index.js")).href);
const core = await imp("@elizaos/core");
const sqlMod = await imp("@elizaos/plugin-sql");
const bootstrapMod = await imp("@elizaos/plugin-bootstrap");
const pluginMod = await imp("elizaos-plugin-agent402");
const plugin = pluginMod.default;
const coreVersion = JSON.parse(readFileSync(join(work, "node_modules", "@elizaos", "core", "package.json"), "utf8")).version;
console.log(`@elizaos/core ${coreVersion}; plugin ${pkg.name}@${pkg.version} from ${tgz.split("/").pop()}`);

// ---- 2. the seller: a local paid-mode Agent402 (free tier via proof-of-work) ----
const { getFreePort } = await import(pathToFileURL(join(ROOT, "scripts", "lib", "free-port.js")).href);
const PORT = await getFreePort();
const BASE = process.env.AGENT402_BASE_URL || `http://127.0.0.1:${PORT}`;
let proc = null;
if (!process.env.AGENT402_BASE_URL) {
  proc = spawn("node", ["src/server.js"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" } });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
}
// ...and a stub gateway for the money cases (a wallet-only $0.003 tool paid by a
// credits key; a tool that fails with a long error). Nothing here funds a wallet.
const seen = [];
const LONG_ERROR = `The input "q" must name a listed market; none of ${Array.from({ length: 60 }, (_, i) => `market-${i}`).join(", ")} matched.`;
const stub = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    const j = (code, body, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [
      { slug: "search", method: "POST", path: "/api/search", price: "$0.003", computePayable: false },
      { slug: "broken", method: "POST", path: "/api/broken", price: "$0.002", computePayable: false },
      { slug: "hash", method: "POST", path: "/api/hash", price: "$0.001", computePayable: true },
    ] });
    if (req.url.startsWith("/api/find")) return j(200, { results: [{ slug: "search", name: "search", price: "$0.003", route: "POST /api/search", walletOnly: true, description: "web search" }] });
    if (!req.headers.authorization) return j(402, { error: "Payment required", reason: "missing" });
    if (req.url.startsWith("/api/search")) return j(200, { results: [{ title: "x402", url: "https://x402.org" }] }, { "x-credits-balance": "19.997" });
    if (req.url.startsWith("/api/broken")) return j(400, { error: LONG_ERROR });
    j(404, { error: "no such tool" });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

// ---- 3. a real runtime ------------------------------------------------------------
let pass = 0;
const ok = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); pass++; console.log(`ok - ${m}`); };
const KEY = "a402_" + "k".repeat(40);
async function bootRuntime(settings) {
  const dataDir = join(work, `pglite-${Math.random().toString(36).slice(2)}`);
  const character = { name: "Probe", bio: ["an agent that buys tools from Agent402"], settings: { PGLITE_DATA_DIR: dataDir, ...settings } };
  const runtime = new core.AgentRuntime({ character, plugins: [sqlMod.default, bootstrapMod.default, plugin] });
  // Core tables come from plugin-sql's migrations, which initialize() runs
  // AFTER ensureAgentExists; the CLI runs them first, and so does this.
  const adapter = sqlMod.createDatabaseAdapter({ dataDir }, runtime.agentId);
  await adapter.init();
  await adapter.runPluginMigrations([{ name: "@elizaos/plugin-sql", schema: sqlMod.default.schema }], { verbose: false, force: false, dryRun: false });
  runtime.registerDatabaseAdapter(adapter);
  // THE STUB MODEL: reads the extraction prompt the plugin sends and answers as
  // the real model would - picks the first offered candidate and shapes the
  // input from the request text. Deterministic so CI can assert on it.
  const prompts = [];
  const extract = async (_rt, params) => {
    const prompt = String(params?.prompt || "");
    prompts.push(prompt);
    const req = /User request: ("(?:[^"\\]|\\.)*")/.exec(prompt);
    const menu = /Candidate tools[^\n]*\n([\s\S]*?)\nRespond with ONLY/.exec(prompt);
    if (!req || !menu) return { slug: null, reason: "stub model: prompt shape not recognised" };
    const text = JSON.parse(req[1]);
    const cands = JSON.parse(menu[1]);
    const quoted = /'([^']+)'/.exec(text)?.[1];
    const pick = cands[0];
    if (pick.slug === "hash") return { slug: "hash", params: { text: quoted, algo: "sha256" } };
    return { slug: pick.slug, params: pick.example || {} };
  };
  for (const t of ["OBJECT_SMALL", "OBJECT_LARGE", "TEXT_SMALL", "TEXT_LARGE"]) runtime.registerModel(t, extract, "test-stub-model", 1000);
  runtime.registerModel("TEXT_EMBEDDING", async () => new Array(384).fill(0), "test-stub-model", 1000);
  await runtime.initialize();
  return { runtime, prompts };
}
const ids = (n) => core.stringToUuid(`a402-runtime-test-${n}`);
async function seed(runtime, roomTag) {
  const roomId = ids(`room-${roomTag}`), userId = ids(`user-${roomTag}`), worldId = ids(`world-${roomTag}`);
  await runtime.ensureConnection({ entityId: userId, roomId, worldId, userName: "mike", name: "Mike", source: "test", channelId: `c-${roomTag}`, serverId: "s", type: "DM" });
  return { roomId, userId, worldId };
}
const userMessage = (runtime, ctx, content, tag) => ({ id: ids(`msg-${tag}`), entityId: ctx.userId, agentId: runtime.agentId, roomId: ctx.roomId, worldId: ctx.worldId, content: { source: "test", ...content }, createdAt: Date.now() });
const plannerPicks = (runtime, ctx, actions, text = "On it.") => [{ id: ids(`plan-${actions.join("-")}-${Math.random()}`), entityId: runtime.agentId, agentId: runtime.agentId, roomId: ctx.roomId, content: { text, actions, thought: `use ${actions.join(",")}` }, createdAt: Date.now() }];
const actionStateText = async (runtime, message, actionResults) => {
  const provider = runtime.providers.find((p) => p.name === "ACTION_STATE");
  const out = await provider.get(runtime, message, { values: {}, data: { actionResults }, text: "" });
  return String(out?.text || "");
};

try {
  // ---- (1)+(2)+(3): the planner path on the real seller ---------------------------
  const { runtime, prompts } = await bootRuntime({ AGENT402_BASE_URL: BASE });
  ok(runtime.actions.map((a) => a.name).includes("AGENT402_CALL") && runtime.plugins.some((p) => p.name === "agent402"), `the packed artifact loaded into @elizaos/core ${coreVersion}: plugin registered, actions present`);
  const ctx = await seed(runtime, "a");
  const plain = userMessage(runtime, ctx, { text: "give me the sha256 hash of 'hello world'" }, "plain");
  await runtime.createMemory(plain, "messages");
  const listed = await runtime.composeState(plain, ["ACTIONS"]);
  ok(/AGENT402_CALL/.test(listed.text) && /AGENT402_FIND/.test(listed.text), "the ACTIONS provider lists AGENT402_CALL for a plain user message with no slug field - the planner is able to pick it (1)");
  if (typeof runtime.processActions !== "function") {
    // A 2.x runtime: the planner emits a TOOL CALL {name, arguments}; the
    // executor (executePlannedToolCall, not exported) validates the arguments
    // against the action's declared `parameters` with core's own
    // validateActionParams (exported), hands the result to validate() and
    // handler() as options.parameters. This mirrors that path with the same
    // validator, and says so.
    const { callAction, findAction } = pluginMod;
    const v = core.validateActionParams(callAction, { slug: "hash", params: { text: "hello world", algo: "sha256" } });
    ok(v.valid === true && v.params?.slug === "hash" && v.params?.params?.algo === "sha256", "core's validateActionParams accepts a planner tool call against AGENT402_CALL's declared parameters");
    const missing = core.validateActionParams(findAction, {});
    ok(missing.valid === false && /task/.test(missing.errors.join(" ")), "and reports AGENT402_FIND's required `task` when the planner omits it");
    const opts = { parameters: v.params, parameterErrors: undefined };
    ok((await callAction.validate(runtime, plain, listed, opts)) === true, "validate(runtime, message, state, options) admits the call (v2 passes options to validate)");
    const want = createHash("sha256").update("hello world").digest("hex");
    const r0 = await callAction.handler(runtime, plain, listed, opts, async () => []);
    ok(r0.success === true && r0.data.resolvedVia === "parameters" && r0.text.includes(want) && /complete JSON/.test(r0.text), "the handler ran on the validated parameters, paid the free tier with proof-of-work, and the complete digest is in the model-facing text (2)(3)");
    const { runtime: rt2 } = await bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_DAILY_LIMIT_USD: "0.005", AGENT402_MAX_PER_CALL_USD: "0.004" });
    const paidCalls = () => seen.filter((s) => s.url.startsWith("/api/search") && s.auth).length;
    const call = (params) => callAction.handler(rt2, plain, listed, { parameters: core.validateActionParams(callAction, params).params }, async () => []);
    let r = await call({ slug: "search", params: { q: "x402" } });
    ok(r.success === true && paidCalls() === 1, "call 1: a $0.003 wallet-only tool settles by credits key (the stub saw one paid request)");
    r = await call({ slug: "search", params: { q: "mpp" } });
    ok(r.success === false && /dailyLimitUsd|24h spend/.test(r.text) && paidCalls() === 1, "call 2: refused by the DAILY ceiling before any request left the process - the ledger survived across calls (4)");
    const { runtime: rt4 } = await bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_MAX_PER_CALL_USD: "1", AGENT402_DAILY_LIMIT_USD: "100" });
    r = await callAction.handler(rt4, plain, listed, { parameters: { slug: "broken", params: { q: "nothing" } } }, async () => []);
    ok(r.success === false && r.error && r.text.includes("market-59"), "an upstream failure's detail reaches the result whole (5)");
    console.log(`\n${pass} passed against @elizaos/core ${coreVersion} (2.x executor path mirrored with core's own validator)`);
    process.exitCode = 0;
    throw Object.assign(new Error("done"), { done: true });
  }
  const callbacks = [];
  await runtime.processActions(plain, plannerPicks(runtime, ctx, ["AGENT402_CALL"]), listed, async (c) => { callbacks.push(c); return []; });
  const results = runtime.getActionResults(plain.id);
  const want = createHash("sha256").update("hello world").digest("hex");
  ok(results.length === 1 && results[0].success === true, `runtime.processActions ran AGENT402_CALL to completion (got ${JSON.stringify(results[0]?.text || results).slice(0, 160)})`);
  ok(results[0].data?.slug === "hash" && results[0].data?.resolvedVia === "model" && prompts.length === 1, "with no slug anywhere, the handler searched the catalog and the runtime's model chose the tool and shaped its input (2)");
  ok(results[0].text.includes(want) && /complete JSON/.test(results[0].text), "the free-tier call paid with proof-of-work and the sha256 digest is in the result text");
  const rendered = await actionStateText(runtime, plain, results);
  ok(rendered.includes(want) && /AGENT402_CALL/.test(rendered), "the ACTION_STATE provider - what the model reads next turn - carries the complete digest, not a preview (3)");
  ok(callbacks.length === 1 && callbacks[0].text.includes(want), "the callback delivered the same complete text");

  // ---- (4): spend ceilings across calls in ONE runtime -------------------------------
  const { runtime: rt2 } = await bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_DAILY_LIMIT_USD: "0.005", AGENT402_MAX_PER_CALL_USD: "0.004" });
  const ctx2 = await seed(rt2, "b");
  const paidCalls = () => seen.filter((s) => s.url.startsWith("/api/search") && s.auth).length;
  const run = async (tag, content) => {
    const m = userMessage(rt2, ctx2, content, tag);
    await rt2.createMemory(m, "messages");
    await rt2.processActions(m, plannerPicks(rt2, ctx2, ["AGENT402_CALL"]), await rt2.composeState(m, ["ACTIONS"]), async () => []);
    return rt2.getActionResults(m.id)[0];
  };
  let r = await run("s1", { text: "search the web for x402", slug: "search", params: { q: "x402" } });
  ok(r.success === true && paidCalls() === 1 && r.text.includes("x402.org"), "call 1: a $0.003 wallet-only tool settles by credits key (the stub saw one paid request)");
  ok(pluginMod.spendingSummaryFor(rt2)?.dailyUsd === 0.003 && pluginMod.spendingSummaryFor(rt2)?.calls === 1, "the runtime's client booked $0.003 against the rolling 24h ledger");
  r = await run("s2", { text: "search the web for mpp", slug: "search", params: { q: "mpp" } });
  ok(r.success === false && /dailyLimitUsd|24h spend/.test(r.text) && paidCalls() === 1, "call 2: refused by the DAILY ceiling before any request left the process - the ledger survived across calls (4)");
  ok(!JSON.stringify(r).includes(KEY), "the credits key never appears in an action result");
  const { runtime: rt3 } = await bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_MAX_PER_CALL_USD: "0.001", AGENT402_DAILY_LIMIT_USD: "100" });
  const ctx3 = await seed(rt3, "c");
  const before = paidCalls();
  const m3 = userMessage(rt3, ctx3, { text: "search", slug: "search", params: { q: "x" } }, "s3");
  await rt3.createMemory(m3, "messages");
  await rt3.processActions(m3, plannerPicks(rt3, ctx3, ["AGENT402_CALL"]), await rt3.composeState(m3, ["ACTIONS"]), async () => []);
  r = rt3.getActionResults(m3.id)[0];
  ok(r.success === false && /maxPerCallUsd/.test(r.text) && paidCalls() === before, "a per-call ceiling under the tool's price refuses with zero requests sent");

  // ---- (5): error detail is not truncated -------------------------------------------
  // Settings are stated in full: elizaOS backs runtime.getSetting() with the
  // process environment, and several runtimes share one process here.
  const { runtime: rt4 } = await bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_MAX_PER_CALL_USD: "1", AGENT402_DAILY_LIMIT_USD: "100" });
  const ctx4 = await seed(rt4, "d");
  const m4 = userMessage(rt4, ctx4, { text: "run broken", slug: "broken", params: { q: "nothing" } }, "e1");
  await rt4.createMemory(m4, "messages");
  await rt4.processActions(m4, plannerPicks(rt4, ctx4, ["AGENT402_CALL"]), await rt4.composeState(m4, ["ACTIONS"]), async () => []);
  r = rt4.getActionResults(m4.id)[0];
  ok(r.success === false && r.error && r.text.includes("market-59"), `an upstream failure's detail reaches the result whole (got: ${r.text}) (5)`);

  // ---- (6): the v2 parameter path ---------------------------------------------------
  const { callAction } = pluginMod;
  ok(Array.isArray(callAction.parameters) && callAction.parameters.every((p) => p.name && p.schema && "required" in p), "AGENT402_CALL declares parameters in the v2 shape ({name, description, required, schema})");
  const v2 = await callAction.handler(runtime, userMessage(runtime, ctx, { text: "hash it" }, "v2"), undefined, { parameters: { slug: "hash", params: { text: "abc", algo: "sha256" } } });
  ok(v2.success === true && v2.data.resolvedVia === "parameters" && v2.text.includes(createHash("sha256").update("abc").digest("hex")), "options.parameters from the runtime's extractor is honoured ahead of the message text (6)");
  const v2bad = await callAction.handler(runtime, userMessage(runtime, ctx, { text: "hash it", slug: "uuid" }, "v2b"), undefined, { parameters: { slug: "hash", params: { text: "abc", algo: "sha256" } } });
  ok(v2bad.data.slug === "hash", "and wins over a conflicting content.slug");

  console.log(`\n${pass} passed against @elizaos/core ${coreVersion}`);
} catch (e) {
  if (!e?.done) { console.error(e?.stack || e); process.exitCode = 1; }
} finally {
  stub.close();
  if (proc) proc.kill("SIGKILL");
  process.exit(process.exitCode || 0);
}
