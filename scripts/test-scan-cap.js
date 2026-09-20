// The marketplace activity scanners must report what a wallet actually did,
// not what their own paging bound happened to allow.
//
// The defect this pins, measured on production 2026-09-20: /base?seller=... for
// the busiest seller on the chain reported exactly 10,000 transactions and
// $129.90 of volume. The real figures for that same wallet and window were
// 30,253 transfers and $332.18 - an independent count (Coinbase Bazaar's own
// measurement, 29,296 calls) agreed with the larger number, not ours. Every
// scanner was bounded by `maxPages = 10`, and at a thousand records a page that
// is a hard ceiling of 10,000 that no wallet can ever be reported past. The
// walks were already keyset (each source's own cursor); only the bound was
// wrong, and it sat exactly where a real figure used to be.
//
// A page COUNT is the wrong bound: it is a proxy for cost that drifts with the
// page size a source returns and silently becomes a ceiling on the answer. The
// bound is a wall-clock budget now, so what stops a long walk is what a page
// load can afford, and a walk stopped early says `truncated: true` instead of
// passing a floor off as a total.
//
// Offline: every source is a stub, so this spends nothing and needs no key.
//
//   node scripts/test-scan-cap.js
process.env.ALCHEMY_API_KEY ||= "stub-key-not-a-real-credential";

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const { evmActivity, stellarActivity, algorandActivity, USDC_ISSUER } = await import("../src/revenue-live.js");

const DAY = 86_400_000;
const realFetch = globalThis.fetch;
let calls = 0;

// ---------------------------------------------------------------------------
// Stub sources. Each serves `total` records inside the window, `pageSize` at a
// time behind its own cursor, then one record past the cutoff so a walk that
// reaches the far edge terminates the way the real source would.
// ---------------------------------------------------------------------------
const PAGE = 1000;

function evmPage(total, cursor) {
  const start = cursor ? Number(cursor) : 0;
  const transfers = [];
  for (let i = start; i < Math.min(start + PAGE, total); i++) {
    transfers.push({
      value: 0.001,
      from: `0x${String(i % 37).padStart(40, "0")}`,       // 37 distinct buyers
      metadata: { blockTimestamp: new Date(Date.now() - (i % 20) * DAY).toISOString() },
    });
  }
  const next = start + PAGE;
  if (next >= total) {
    // Past the window: the real source keeps going, the walk must stop here.
    transfers.push({ value: 0.001, from: "0x" + "9".repeat(40), metadata: { blockTimestamp: new Date(Date.now() - 400 * DAY).toISOString() } });
    return { transfers, pageKey: "beyond" };
  }
  return { transfers, pageKey: String(next) };
}

function installStub({ total, delayMs = 0 }) {
  calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;

    if (body?.method === "alchemy_getAssetTransfers") {
      const p = body.params[0];
      return json({ jsonrpc: "2.0", id: 1, result: evmPage(total, p.pageKey) });
    }
    if (u.includes("horizon")) {                                  // Stellar
      const m = /cursor=(\d+)/.exec(u);
      const start = m ? Number(m[1]) : 0;
      const records = [];
      for (let i = start; i < Math.min(start + PAGE, total); i++) {
        records.push({ type: "payment", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "0.001",
          from: `G${String(i % 37).padStart(55, "A")}`, to: "GWALLET", transaction_hash: `h${i}`,
          created_at: new Date(Date.now() - (i % 20) * DAY).toISOString() });
      }
      const next = start + PAGE;
      if (next >= total) records.push({ type: "payment", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "0.001",
        from: "GOLD", to: "GWALLET", transaction_hash: "hold", created_at: new Date(Date.now() - 400 * DAY).toISOString() });
      return json({ _embedded: { records }, _links: { next: { href: `https://horizon.stellar.org/next?cursor=${next}` } } });
    }
    if (u.includes("/transactions?")) {                            // Algorand indexer
      const m = /[?&]next=(\d+)/.exec(u);
      const start = m ? Number(m[1]) : 0;
      const transactions = [];
      for (let i = start; i < Math.min(start + PAGE, total); i++) {
        transactions.push({ id: `t${i}`, sender: `SENDER${i % 37}`, "round-time": Math.floor((Date.now() - (i % 20) * DAY) / 1000),
          "asset-transfer-transaction": { "asset-id": 31566704, receiver: "AWALLET", amount: 1000 } });
      }
      const next = start + PAGE;
      return json(next >= total ? { transactions } : { transactions, "next-token": String(next) });
    }
    return json({});
  };
}
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const restore = () => { globalThis.fetch = realFetch; };

// ---------------------------------------------------------------------------
// CONTROL FIRST. A clean sweep below is only believable once the harness has
// been shown to catch the real defect, so reproduce it: hold the walker to the
// old ten-page bound and require the stub's 25,000 records to come back as
// exactly 10,000. If this ever stops reporting 10,000 the stub is not paging
// and every assertion after it is measuring nothing.
// ---------------------------------------------------------------------------
const TOTAL = 25_000;
installStub({ total: TOTAL });

const old = await evmActivity("base", "0xwallet", { maxPages: 10, budgetMs: 60_000 });
ok(old.totals.tx === 10_000, `control: the old ten-page bound reports exactly 10,000 of ${TOTAL.toLocaleString()} (got ${old.totals.tx}) - the harness can see the defect`);
ok(old.truncated === true, `control: that capped walk admits truncated:true (got ${old.truncated})`);
ok(calls >= 10, `control: the stub actually paged (${calls} fetches)`);

// ---------------------------------------------------------------------------
// The regression itself.
// ---------------------------------------------------------------------------
installStub({ total: TOTAL });
const full = await evmActivity("base", "0xwallet", { budgetMs: 60_000 });
ok(full.totals.tx === TOTAL, `evm: a wallet with ${TOTAL.toLocaleString()} transfers in the window reports all of them (got ${full.totals.tx})`);
ok(full.totals.tx > 10_000, `evm: the reported total is past the old 10,000 ceiling (got ${full.totals.tx})`);
ok(full.truncated === false, `evm: a walk that reached the window edge is NOT truncated (got ${full.truncated})`);
ok(full.totals.buyers === 37, `evm: distinct buyers counted across every page, not just the first ten (got ${full.totals.buyers})`);
ok(Math.abs(full.totals.usd - TOTAL * 0.001) < 0.01, `evm: volume is the whole window too (got $${full.totals.usd.toFixed(2)})`);

// The walk must stop at the window edge rather than run to the page backstop.
ok(calls <= TOTAL / PAGE + 2, `evm: stopped at the cutoff, not at the backstop (${calls} fetches for ${TOTAL / PAGE} pages of data)`);

// ---------------------------------------------------------------------------
// The bound is the clock, and a walk it stops says so.
// ---------------------------------------------------------------------------
installStub({ total: TOTAL, delayMs: 30 });
const starved = await evmActivity("base", "0xwallet", { budgetMs: 120 });
ok(starved.truncated === true, `evm: a walk the budget stops reports truncated:true (got ${starved.truncated})`);
ok(starved.totals.tx > 0 && starved.totals.tx < TOTAL, `evm: and returns an honest partial floor, never zero and never the total (got ${starved.totals.tx})`);

// A budget large enough for the whole walk must not truncate just because it
// was generous - truncation tracks a pending cursor, not elapsed time.
installStub({ total: 2000 });
const small = await evmActivity("base", "0xwallet", { budgetMs: 60_000 });
ok(small.totals.tx === 2000 && small.truncated === false, `evm: a wallet inside one budget is complete and unflagged (got ${small.totals.tx}, truncated=${small.truncated})`);

// ---------------------------------------------------------------------------
// Same class, same bound: the other two paged walkers shared `maxPages = 10`.
// ---------------------------------------------------------------------------
installStub({ total: TOTAL });
const alg = await algorandActivity("AWALLET", { budgetMs: 60_000 });
ok(!alg.error, `algorand: stub scan succeeded (${alg.error || "no error"})`);
ok(alg.totals.tx === TOTAL, `algorand: reports all ${TOTAL.toLocaleString()} transfers, not 10,000 (got ${alg.totals.tx})`);
ok(alg.truncated === false, `algorand: a completed walk is not truncated (got ${alg.truncated})`);

installStub({ total: TOTAL, delayMs: 30 });
const algStarved = await algorandActivity("AWALLET", { budgetMs: 120 });
ok(algStarved.truncated === true, `algorand: a budget-stopped walk reports truncated:true (got ${algStarved.truncated})`);

installStub({ total: 5000 });
const stl = await stellarActivity("GWALLET", { budgetMs: 60_000 });
ok(!stl.error, `stellar: stub scan succeeded (${stl.error || "no error"})`);
ok(stl.totals.tx === 5000, `stellar: reports all 5,000 payments, past the old 10-page x 200 = 2,000 ceiling (got ${stl.totals.tx})`);
ok(stl.truncated === false, `stellar: a completed walk is not truncated (got ${stl.truncated})`);

installStub({ total: 5000, delayMs: 30 });
const stlStarved = await stellarActivity("GWALLET", { budgetMs: 120 });
ok(stlStarved.truncated === true, `stellar: a budget-stopped walk reports truncated:true (got ${stlStarved.truncated})`);

restore();
console.log(`\n${pass} passed`);
