// Boots free-mode server, asserts the legacy surfaces 301 to /marketplace.
const base = process.env.TARGET_URL || "http://localhost:3000";
let fail = 0;
for (const p of ["/index", "/marketplaces"]) {
  const r = await fetch(base + p, { redirect: "manual" });
  const loc = r.headers.get("location");
  const good = r.status === 301 && loc === "/marketplace";
  console.log(`${good ? "ok" : "NOT OK"} - ${p} → 301 /marketplace (got ${r.status} ${loc})`);
  if (!good) fail++;
}
process.exit(fail ? 1 : 0);
