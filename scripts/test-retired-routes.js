// Retired catalog routes answer 410 Gone with the replacement, never the
// guessed-slug 404 (src/retired-tools.js). Offline half: the registry rules.
// Booted half: the wire shape on a free server.
//
//   node scripts/test-retired-routes.js
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { RETIRED_TOOLS, RETIRED_PACKS, retiredEntryFor, assertRetiredRegistryConsistent } from "../src/retired-tools.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); process.exit(1); } };
const throws = (fn, re, m) => { let e = null; try { fn(); } catch (err) { e = err; } ok(e && re.test(e.message), `${m} (${e ? e.message.slice(0, 80) : "did not throw"})`); };

// --- the registry rules ---------------------------------------------------------
const live = new Set(["crypto-options-chain", "stock-quote", "price-coingecko", "business-days", "cron-next", "slugify", "hash"]);
ok(assertRetiredRegistryConsistent(live) === true, "control: the registry is consistent against a live set that carries every replacement");
throws(() => assertRetiredRegistryConsistent(new Set([...live, "options-chain"])), /listed as retired but is live/, "a retired tool that is live again fails the boot");
throws(() => assertRetiredRegistryConsistent(new Set([...live, "skill-market-open"])), /pack "market-open" is listed as retired but is live/, "a retired pack that is live again fails the boot");
throws(() => assertRetiredRegistryConsistent(new Set([...live].filter((s) => s !== "crypto-options-chain"))), /names replacement "crypto-options-chain", which is not a live/, "a replacement that is not live fails the boot");
ok(Object.values(RETIRED_TOOLS).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.retiredAt)) && Object.values(RETIRED_PACKS).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.retiredAt)), "every entry carries a retirement date");

// The boot guard is CALLED, against the real catalog, before any route is served.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/assertRetiredRegistryConsistent\(new Set\(Object\.values\(CATALOG\)\.map\(\(d\) => d\.slug\)\)\)/.test(src), "server.js runs the registry guard over the catalog's own slugs at boot");
  ok(src.indexOf("assertRetiredRegistryConsistent(new Set(") < src.indexOf("app.listen("), "...before the server listens");
}

// --- path resolution ------------------------------------------------------------
ok(retiredEntryFor("/api/options-chain")?.replacement === "crypto-options-chain", "/api/<retired tool> resolves with its replacement");
ok(retiredEntryFor("/api/options-chain/anything?x=1")?.slug === "options-chain", "a trailing segment does not hide a retired route");
ok(retiredEntryFor("/api/skill/market-open")?.kind === "pack", "/api/skill/<retired pack> resolves as a pack");
ok(retiredEntryFor("/api/skill/options-chain") === null, "a tool slug under /api/skill/ is not a retired pack");
ok(retiredEntryFor("/api/market-open") === null, "a pack slug under /api/ is not a retired tool");
ok(retiredEntryFor("/api/nope-nope") === null && retiredEntryFor("/v1/options-chain") === null, "unknown and off-prefix paths resolve to nothing");

// --- the wire, on a free boot ------------------------------------------------------
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(port), BASE_URL: "http://agent402.test", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off" }, stdio: ["ignore", "ignore", "inherit"] });
try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted (the boot guard accepted the registry against the real catalog)");
  const get = await fetch(`${base}/api/options-chain`);
  const gb = await get.json();
  ok(get.status === 410 && gb.error === "gone" && gb.slug === "options-chain", `GET /api/options-chain is 410 gone (got ${get.status} ${JSON.stringify(gb).slice(0, 80)})`);
  ok(gb.replacement?.slug === "crypto-options-chain" && /^POST \/api\/crypto-options-chain$/.test(gb.replacement?.route || "") && gb.replacement?.url === "http://agent402.test/api/crypto-options-chain", "...naming the live replacement's slug, route and url");
  ok(gb.retiredAt === "2026-09-20" && /retired on 2026-09-20/.test(gb.hint) && /crypto-options-chain/.test(gb.hint), "...with the date and the replacement in the hint");
  ok(Array.isArray(gb.suggestions) && typeof gb.find === "string", "...and the same find + suggestions the 404 carries");
  const post = await fetch(`${base}/api/options-chain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: "AAPL" }) });
  ok(post.status === 410, `POST on a retired route is 410 too (got ${post.status})`);
  const none = await fetch(`${base}/api/stock-dividends`);
  const nb = await none.json();
  ok(none.status === 410 && nb.replacement === null && /no direct replacement/.test(nb.hint), "a retirement with no replacement says so instead of inventing one");
  const pack = await fetch(`${base}/api/skill/market-open`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const pb = await pack.json();
  ok(pack.status === 410 && pb.slug === "market-open" && /Skill pack market-open was retired/.test(pb.hint), `a retired skill pack is 410 (got ${pack.status})`);
  const unknown = await fetch(`${base}/api/nope-nope`);
  ok(unknown.status === 404 && (await unknown.json()).error === "not-found", "a guessed slug that was never a tool is still 404");
  const liveRoute = await fetch(`${base}/api/crypto-options-chain`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(liveRoute.status !== 410 && liveRoute.status !== 404, `the replacement itself is served (got ${liveRoute.status})`);
  const conv = await fetch(`${base}/api/convert/km-to-miles`);
  ok(conv.status === 410, `the retired converters keep their own teaching 410 (got ${conv.status})`);
} finally { proc.kill("SIGTERM"); }
console.log(`OK: ${pass} passed`);
