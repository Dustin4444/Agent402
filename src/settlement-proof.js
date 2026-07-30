// Proven-ness from OUR OWN chain observation, not from registry membership.
//
// The router refuses to spend a buyer's money on a seller that has not been
// observed settling (SOR_MIN_SETTLED_TX). That gate was only ever as wide as
// its evidence, and its evidence came from the Bazaar-derived leaderboard — so
// "has settled" actually meant "is listed in a registry we crawl". A seller who
// registers nowhere had a settled count of 0 no matter how much they settled.
//
// That is not hypothetical. The #2 merchant on Base by settlement count —
// ~198k settlements in seven days, 11.3% of all x402 settlement COUNT on the
// chain — is in no registry at all: absent from our 2,258-origin index and from
// all 15,517 Bazaar resources. Our router could never select it, and nothing
// anywhere said so. The gate reported "unproven" when the truth was "unlooked".
//
// The join below fixes the class, not the instance. We already crawl each
// origin's advertised payTo (`payToByNetwork`), and we already scan Base for
// settlements grouped by receiving address. Joining those two gives a settled
// count for ANY origin we have crawled, whether or not a registry lists it —
// evidence we gathered ourselves, about money that actually moved.
//
// What it cannot do is invent an origin. A settlement carries no URL, so
// address → origin is not derivable from the chain; an unregistered seller we
// have never crawled stays invisible until something tells us its URL. That
// residue is exactly what `unattributedMerchants` measures, so the part we
// cannot see is reported rather than silently counted as zero.

/** EVM addresses are case-insensitive; base58/Stellar are NOT (see src/payer.js). */
// Case-insensitive on the 0x prefix too: an address arriving as "0XABC…" is the
// same wallet, and rejecting it would silently drop that seller's evidence
// rather than fail loudly.
const isEvmAddress = (a) => typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a);
const evmKey = (a) => (isEvmAddress(a) ? a.toLowerCase() : null);

/** The Base-mainnet payTo an origin advertises, or null. EVM only, by design. */
export function baseNetworkPayTo(seller, network = "eip155:8453") {
  const addr = seller?.payToByNetwork?.[network];
  return evmKey(addr);
}

/**
 * Index on-chain merchants by receiving address.
 * @param {Array<{merchant:string, payments:number, payers:number, volumeUsd:number}>} merchants
 */
export function merchantsByAddress(merchants) {
  const m = new Map();
  for (const row of Array.isArray(merchants) ? merchants : []) {
    const k = evmKey(row?.merchant);
    if (!k) continue; // non-EVM merchant rows are out of scope, never case-folded
    const prev = m.get(k);
    // Same address can appear once per query shape; keep the strongest evidence.
    if (!prev || Number(row.payments || 0) > prev.payments) {
      m.set(k, {
        payments: Number(row.payments || 0),
        payers: Number(row.payers || 0),
        volumeUsd: Number(row.volumeUsd || 0),
      });
    }
  }
  return m;
}

/**
 * origin -> observed settled-call count, joined by advertised Base payTo.
 * Registry membership is irrelevant here: the only inputs are an origin we
 * crawled and money we watched arrive.
 */
export function provenByChain({ sellers, merchants, network = "eip155:8453" } = {}) {
  const byAddr = merchantsByAddress(merchants);
  const out = new Map();
  for (const s of Array.isArray(sellers) ? sellers : []) {
    const origin = typeof s?.origin === "string" ? s.origin.replace(/\/+$/, "").toLowerCase() : "";
    if (!origin) continue;
    const payTo = baseNetworkPayTo(s, network);
    if (!payTo) continue;
    const hit = byAddr.get(payTo);
    if (!hit) continue;
    const prev = out.get(origin);
    if (!prev || hit.payments > prev.settled) {
      out.set(origin, { settled: hit.payments, payers: hit.payers, volumeUsd: hit.volumeUsd, payTo, source: "chain" });
    }
  }
  return out;
}

/**
 * Merchants moving real money that we cannot attribute to any crawled origin —
 * the measured blind spot. `ourAddresses` are excluded: our own treasury is not
 * a discovery gap.
 *
 * Returns null when there is no usable merchant data. That distinction is the
 * whole point: an empty scan and a scan showing nothing unattributed look
 * identical in a bare number, and reporting "0 unattributed" for a scan that
 * never ran is the failure this codebase keeps rediscovering.
 */
export function unattributedMerchants({ sellers, merchants, ourAddresses = [], minPayments = 50, network = "eip155:8453" } = {}) {
  if (!Array.isArray(merchants) || merchants.length === 0) return null; // no data ≠ no gap
  const known = new Set();
  for (const s of Array.isArray(sellers) ? sellers : []) {
    const p = baseNetworkPayTo(s, network);
    if (p) known.add(p);
  }
  for (const a of ourAddresses) { const k = evmKey(a); if (k) known.add(k); }

  const rows = [];
  for (const [addr, ev] of merchantsByAddress(merchants)) {
    if (known.has(addr)) continue;
    if (ev.payments < minPayments) continue;
    rows.push({ merchant: addr, payments: ev.payments, payers: ev.payers, volumeUsd: ev.volumeUsd });
  }
  rows.sort((a, b) => b.payments - a.payments);

  const scanned = merchantsByAddress(merchants).size;
  const totalPayments = [...merchantsByAddress(merchants).values()].reduce((s, r) => s + r.payments, 0);
  const unattributedPayments = rows.reduce((s, r) => s + r.payments, 0);
  return {
    merchantsScanned: scanned,
    originsWithKnownPayTo: known.size,
    unattributed: rows,
    unattributedCount: rows.length,
    unattributedPayments,
    // How much of the settlement activity we can see is happening at addresses
    // we cannot route to. This is the number that was previously unobservable.
    unattributedShareOfPayments: totalPayments > 0 ? Number((unattributedPayments / totalPayments).toFixed(4)) : null,
    minPayments,
    note: "Merchants observed settling on Base whose address matches no origin in our crawl. A settlement carries no URL, so these cannot be resolved to a seller from chain data alone — they need an origin from somewhere before the router can ever consider them.",
  };
}
