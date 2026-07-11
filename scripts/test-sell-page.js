// Offline unit tests for the /sell hub renderer. Fixture snapshots — no
// server, no network.
import { sellPage } from "../src/sell.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const board = [
  { name: "Agent402.Tools", callsSettled: 30000, totalUsd: 900.5, uniqueBuyers: 300 },
  { name: "Ext Seller", callsSettled: 11209, totalUsd: 483.52, uniqueBuyers: 112 },
];
const lb = { leaderboard: board, windowLabel: "24h" };
const idx = { totals: { sellers: 21 } };

// --- hero + demand receipt with real values -------------------------------
let html = sellPage("https://agent402.tools", { leaderboardSnapshot: lb, indexSnapshot: idx });
ok(html.includes("Get paid<br>per call"), "hero H1 renders");
ok(html.includes("41,209"), "demand receipt sums calls settled across all sellers");
ok(html.includes("$1,384.02"), "demand receipt sums USDC settled across all sellers");
ok(html.includes(">412<"), "demand receipt sums unique buyer wallets across all sellers");
ok(html.includes(">21<"), "demand receipt shows sellers-on-index count from the index snapshot");
ok(html.includes('href="/leaderboard"') && html.includes('href="/index"'), "demand rows link to their proof surfaces");
ok(!html.includes("busiest category"), "busiest-category row omitted rather than invented");

// --- unavailable state when snapshots are absent/failed -------------------
html = sellPage("https://agent402.tools", { leaderboardSnapshot: { warming: true, leaderboard: [] }, indexSnapshot: null });
ok((html.match(/unavailable/g) || []).length >= 4, "missing snapshot data renders 'unavailable', never a zero");
ok(!html.includes(">0<"), "no fabricated zero anywhere in the demand receipt when data is unavailable");

// --- register form: same id/posture as market-page.js ---------------------
html = sellPage("https://agent402.tools", { leaderboardSnapshot: lb, indexSnapshot: idx });
ok(html.includes('id="list-api"') && html.includes('id="reg-origin"') && html.includes('id="reg-go"') && html.includes('id="reg-out"'), "register form present with market-page.js's ids");
ok(html.includes("/api/index/register"), "register form posts to /api/index/register");
ok(html.includes("out.textContent") && !html.includes("innerHTML"), "register-result rendering is textContent-only, never innerHTML");

// --- twin receipts ("the deal, in full") -----------------------------------
ok(html.includes("WHAT YOU GET") && html.includes("WHAT WE TAKE"), "twin receipts render");
ok(html.includes("src/x402-index.js") && html.includes("github.com/MikeyPetrillo/Agent402"), "twin receipts link to the router source for verification");

// --- JSON-LD -----------------------------------------------------------
ok(html.includes("application/ld+json") && html.includes('"@type":"Service"'), "Service JSON-LD present");

// --- copy hygiene: no em dashes in new page copy ---------------------------
ok(!/Get paid[\s\S]{0,400}—/.test(html.split("<!-- PATH A")[0]), "hero section has no em dash in new copy");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
