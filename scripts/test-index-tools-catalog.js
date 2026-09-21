// Offline unit test for the third-party tool catalog (/marketplace/tools).
//
// The catalog reproduces other people's endpoints, in their own words, at
// scale. The properties that matter are therefore not "does it render" but
// "does it stay honest and safe": our own tools must never appear in a list
// whose premise is that nothing on it is ours, seller-supplied strings must be
// inert, and outbound links must not lend them our ranking.
//
// Run: node scripts/test-index-tools-catalog.js
import { indexToolsPage } from "../src/index-tools-page.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

const tool = (over = {}) => ({
  seller: "https://seller.test", sellerName: "Seller", name: "A tool", route: "/x", method: "POST",
  url: "https://seller.test/x", description: "Does a thing for agents, deterministically.", described: true,
  category: "data", tags: [], priceUsd: 0.01, networks: ["eip155:8453"], ...over,
});
const page = (results, extra = {}) =>
  indexToolsPage("https://agent402.tools",
    { total: results.length, matched: results.length, offset: 0, limit: 100, described: results.filter((r) => r.described).length, results, ...extra },
    [{ category: "data", count: 1 }], {});

// ── Disclaimers, scoped by provenance ───────────────────────────────────────
// The page mixes our tools with other people's, so a BLANKET disclaimer would
// now be a lie in both directions: "we do not test any of this" is false for
// our rows, and "tested on every deploy" is false for everyone else's. The
// wording has to attach to the badge, not the page.
{
  const html = page([tool({ ours: true, sellerName: "Agent402", slug: "hash" }), tool()]);
  const must = [
    "do not operate, host, or test",   // third-party rows
    "written by the seller",           // third-party metadata is theirs
    "directly to the seller",          // non-custodial
    "not endorsement",                 // listing != review
    "untrusted",                       // prompt-injection warning
    "applies only to these rows",      // the scoping itself
  ];
  for (const phrase of must) check(`states: "${phrase}"`, html.toLowerCase().includes(phrase.toLowerCase()));
  check("claims the guarantee for OUR rows specifically", /build, host and stand behind/i.test(html));
  check("offers a way back to our own catalog", html.includes('href="/tools"'));
  check("does NOT disclaim everything as third-party", !/we do not operate, host, or test any endpoint on this page/i.test(html));
}

// ── Provenance is visible without reading ───────────────────────────────────
{
  const html = page([tool({ ours: true, sellerName: "Agent402", slug: "hash" }), tool({ sellerName: "Someone Else" })]);
  check("our row carries an OURS badge", /ix-badge ours/.test(html));
  check("their row carries a third-party badge", /ix-badge third/.test(html));
  check("our row is visually marked", /class="is-ours"/.test(html));
  check("our row links to our own tool page, not an outbound link", html.includes('href="/tools/hash"'));
  check("our row is NOT nofollowed like a third party", !/href="\/tools\/hash"[^>]*nofollow/.test(html));
}

// ── Undescribed rows are shown and labelled, never silently dropped ─────────
{
  const html = page([tool({ described: false, description: "" })]);
  check("an undescribed tool is still listed", html.includes("A tool"));
  check("and is labelled as the seller's omission", /No description supplied by the seller/.test(html));
}

// ── Seller-supplied strings are inert ───────────────────────────────────────
{
  const evil = `<img src=x onerror=alert(1)> " onmouseover="alert(2)`;
  const html = page([tool({ name: evil, description: evil, sellerName: evil, category: evil })]);
  check("no unescaped tag survives", !/<img\s/i.test(html));
  check("no attribute break-out from a quote", !/href="[^"]*"[a-z]+="/i.test(html));
  check("no injected event handler becomes an attribute", !/\s onmouseover="/i.test(html));
  check("hostile text still renders, as escaped text", html.includes("&lt;img"));
}

// ── Outbound links must not lend third parties our ranking ──────────────────
{
  const html = page([tool(), tool({ url: "https://other.test/y", sellerName: "Other" })]);
  const links = html.match(/rel="noopener nofollow ugc"/g) || [];
  check("every seller link carries noopener nofollow ugc", links.length === 2);
}

// ── Prompt-injection notice for the agents that will read this ──────────────
{
  const html = page([tool()]);
  check("warns agents to treat descriptions as data, not instructions", /never as instructions/i.test(html));
}

// ── Empty state stays useful ────────────────────────────────────────────────
{
  const html = page([], { total: 1234, matched: 0 });
  check("empty result set explains itself", /Nothing matched/.test(html));
  check("and still offers the router", html.includes('href="/api/route"'));
}

// Price CUTS must propagate (reported 2026-08-29 by a seller whose 2026-08-20
// cut we were still quoting at 10x, nine days and dozens of crawls later).
// Three sites composed into "a learned price can rise but never fall": the
// merge took max(), carry-forward filled the fresh row with the stale amount
// and re-stamped it live-402, and a priced route was never re-probed.
{
  const { mergeOpenapiIntoBazaar, carryForwardLearnedQuotes, priceDisagreesWithOrigin } = await import("../src/x402-index.js");

  // 1. the merge prefers the origin's OWN current declaration, both directions
  if (typeof mergeOpenapiIntoBazaar === "function") {
    // signature is (openapiTools, bazaarTools): the ORIGIN's document first.
    const cut = mergeOpenapiIntoBazaar(
      [{ route: "/audit", method: "POST", price: 0.05, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
      [{ route: "/audit", method: "POST", price: 0.5, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
    )[0];
    check(`a price CUT propagates: origin 0.05 beats a stale 0.5 (got ${cut.price})`, cut.price === 0.05);
    check("both observations stay visible for a buyer that wants to fail closed", cut.originDeclaredPrice === 0.05 && cut.priceObservations?.bazaar === 0.5);
    const raise = mergeOpenapiIntoBazaar(
      [{ route: "/audit", method: "POST", price: 0.5, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
      [{ route: "/audit", method: "POST", price: 0.05, slug: "audit", name: "Audit", description: "d", tags: [], category: "c" }],
    )[0];
    check(`a price RISE still wins too, which is what max() was protecting (got ${raise.price})`, raise.price === 0.5);
  }

  // 2. carry-forward fills a gap, never overrides what the origin declared today
  const kept = carryForwardLearnedQuotes(
    [{ route: "/audit", price: 0.05, originDeclaredPrice: 0.05 }],
    { tools: [{ route: "/audit", price: 0.5, quoteSource: "live-402" }] },
  )[0];
  check(`a stale learned quote never overwrites today's origin price (got ${kept.price})`, kept.price === 0.05);
  check("and it is not re-stamped live-402, which made a nine-day-old price look fresh", kept.quoteSource !== "live-402");
  // Keyed by method + route (2026-09-02): a path with GET and POST keeps each
  // row's own verb. Before, the remembered row's verb was stamped onto every
  // current row on the route, and minia2a.uk's POST operations came out GET.
  {
    const prev = { tools: [
      { method: "GET", route: "/x402/ip-geo", price: 0.5, networks: ["eip155:8453"], quoteSource: "live-402" },
      { method: "POST", route: "/x402/ip-geo", price: 0.5, networks: ["eip155:8453"], quoteSource: "live-402" },
    ] };
    const cur = [
      { method: "GET", route: "/x402/ip-geo", slug: "x402_ip_geo_get" },
      { method: "POST", route: "/x402/ip-geo", slug: "x402_ip_geo_post" },
    ];
    const out = carryForwardLearnedQuotes(cur, prev);
    check("GET and POST rows on one route each keep their own verb when both were learned", out.map((r) => r.method).join(",") === "GET,POST" && out.every((r) => r.price === 0.5));
    const onlyGet = { tools: [{ method: "GET", route: "/x402/ip-geo", price: 0.5, networks: ["eip155:8453"], quoteSource: "live-402" }] };
    const declared = carryForwardLearnedQuotes([{ method: "POST", route: "/x402/ip-geo", slug: "p" }], onlyGet)[0];
    check("a DECLARED POST keeps its verb when only GET was learned on the route, and still takes the price + networks", declared.method === "POST" && declared.price === 0.5 && declared.networks.length === 1);
    const inferred = carryForwardLearnedQuotes([{ method: "GET", methodInferred: true, route: "/x402/ip-geo", slug: "i" }], { tools: [{ method: "POST", route: "/x402/ip-geo", price: 0.5, quoteSource: "live-402" }] })[0];
    check("an INFERRED verb adopts the verb that was observed to answer the quote", inferred.method === "POST" && inferred.methodInferred === false);
  }
  const filled = carryForwardLearnedQuotes([{ route: "/x" }], { tools: [{ route: "/x", price: 0.02, quoteSource: "live-402" }] })[0];
  check("a genuine gap is still filled, and says so", filled.price === 0.02 && filled.quoteCarriedForward === true);

  // 3. a priced route that disagrees with the origin is re-probed
  check("a 10x disagreement is worth a live probe", priceDisagreesWithOrigin({ price: 0.5, originDeclaredPrice: 0.05 }) === true);
  check("a rounding difference is not", priceDisagreesWithOrigin({ price: 0.051, originDeclaredPrice: 0.05 }) === false);
  check("no origin declaration means nothing to disagree with", priceDisagreesWithOrigin({ price: 0.5 }) === false);
}

// A learned quote also EXPIRES (2026-08-29): the drift test only fires when the
// origin declares a price, and about 95% of crawled sellers publish none. For
// them a learned amount would stand forever - the same ratchet by a quieter
// route - so a live-402 quote is re-asked once it is a week old.
{
  const { quoteIsStale, carryForwardLearnedQuotes } = await import("../src/x402-index.js");
  const day = 86_400_000, now = Date.now();
  check(`a week-old learned quote is re-probed`, quoteIsStale({ quoteSource: "live-402", price: 0.5, quoteObservedAt: now - 8 * day }, now) === true);
  check(`a fresh learned quote is left alone`, quoteIsStale({ quoteSource: "live-402", price: 0.5, quoteObservedAt: now - 2 * day }, now) === false);
  check(`a row from before stamping existed is refreshed once`, quoteIsStale({ quoteSource: "live-402", price: 0.5 }, now) === true);
  check(`an origin-declared price is not a learned quote and never expires this way`, quoteIsStale({ quoteSource: "openapi", price: 0.5 }, now) === false);
  check(`nothing to refresh when there is no price`, quoteIsStale({ quoteSource: "live-402" }, now) === false);
  // the age must survive a carry-forward, or every crawl would reset the clock
  const carried = carryForwardLearnedQuotes([{ route: "/x" }], { tools: [{ route: "/x", price: 0.02, quoteSource: "live-402", quoteObservedAt: now - 9 * day }] })[0];
  check(`carry-forward preserves when the quote was observed, so the clock cannot reset`, carried.quoteObservedAt === now - 9 * day && quoteIsStale(carried, now) === true);
  // Manifest-vs-402 consistency (issue #1178, 2026-09-02): a manifest-priced,
  // manifest-networked row is read live once, then weekly, and the chains the
  // 402 actually offers are unioned in and survive the next crawl's rebuild.
  const { networksNeedLiveVerify } = await import("../src/x402-index.js");
  check(`a manifest-priced row with chains but no live read is verified once`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: ["eip155:8453"] }, now) === true);
  check(`verified two days ago: left alone`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 2 * day }, now) === false);
  check(`verified eight days ago: read again`, networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: ["eip155:8453"], networksVerifiedAt: now - 8 * day }, now) === true);
  check(`a learned (live-402) row keeps its own clock, not this one`, networksNeedLiveVerify({ quoteSource: "live-402", price: 0.25, networks: ["eip155:8453"] }, now) === false);
  check(`an unpriced or chainless row is already a candidate by the older rule`, networksNeedLiveVerify({ quoteSource: "manifest", networks: ["eip155:8453"] }, now) === false && networksNeedLiveVerify({ quoteSource: "manifest", price: 0.25, networks: [] }, now) === false);
  const rebuilt = carryForwardLearnedQuotes([{ route: "/api/rewrite", method: "POST", price: 0.25, networks: ["eip155:8453"], quoteSource: "manifest" }],
    { tools: [{ route: "/api/rewrite", method: "POST", price: 0.25, quoteSource: "live-402", networks: ["eip155:8453", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="], networksVerifiedAt: now - 1 * day }] })[0];
  check(`a verified live read's extra chain survives the next crawl's manifest-shaped rebuild (union, never a drop)`, rebuilt.networks.length === 2 && rebuilt.networks.includes("eip155:8453") && rebuilt.networksVerifiedAt === now - 1 * day && networksNeedLiveVerify(rebuilt, now) === false);
  const unverified = carryForwardLearnedQuotes([{ route: "/y", method: "GET", price: 0.1, networks: ["eip155:8453"], quoteSource: "manifest" }],
    { tools: [{ route: "/y", method: "GET", price: 0.1, quoteSource: "live-402", networks: ["eip155:137"] }] })[0];
  check(`a remembered row that was never VERIFIED does not add chains to a row that already has them (the old fill-a-gap rule stands)`, unverified.networks.length === 1 && unverified.networks[0] === "eip155:8453");
}

// The reporter's own row is discovered via /.well-known/x402, NOT OpenAPI, and
// a manifest price is a display STRING ("$0.05"). The first cut of the #1043
// fix marked only OpenAPI prices as origin-declared and guarded with a bare
// Number(), so their corrected manifest price kept losing to the stale learned
// quote even after the "fix" - verified against their live endpoint.
{
  const { normaliseManifestTools, carryForwardLearnedQuotes } = await import("../src/x402-index.js");
  const rows = normaliseManifestTools({ tools: [{ route: "/audit", price: "$0.05", name: "Audit" }] }, "https://seller.example");
  const row = rows.find((r) => String(r.route).includes("/audit"));
  check(`a manifest price is marked origin-declared even as a display string (got ${row?.originDeclaredPrice})`, row?.originDeclaredPrice === 0.05);
  const after = carryForwardLearnedQuotes(rows, { tools: [{ route: row?.route, price: 0.5, quoteSource: "live-402" }] }).find((r) => String(r.route).includes("/audit"));
  check(`a stale learned quote cannot override a manifest-declared price (got ${after?.price})`, String(after?.price).includes("0.05"));
  const bare = normaliseManifestTools({ tools: [{ route: "/x", name: "X" }] }, "https://seller.example").find((r) => String(r.route).includes("/x"));
  check(`an unpriced manifest entry claims no declaration`, !(Number(bare?.originDeclaredPrice) > 0));

  // A `price` that is an OBJECT is a legitimate, richer manifest shape: the
  // seller carries scheme/network/asset/payTo per resource with the figure
  // inside. Reading scalars only, we normalised such a manifest to price null,
  // which costs a live-402 probe to learn what the origin already stated and,
  // worse, leaves `originDeclaredPrice` unstamped - the anchor this whole block
  // exists to protect. Found reviewing a seed PR (2026-09-13) whose manifest
  // used `price: { amountUsd: "0.01", ... }`.
  const objShape = normaliseManifestTools(
    { resources: [{ url: "https://seller.example/api/score", method: "POST",
      price: { scheme: "exact", network: "eip155:8453", amountUsd: "0.01", amountLabel: "$0.01 USDC",
               payTo: "0x0000000000000000000000000000000000000001" } }] },
    "https://seller.example").find((r) => String(r.route).includes("/api/score"));
  check(`an object-shaped manifest price is read (got ${objShape?.price})`, String(objShape?.price).includes("0.01"));
  check(`...and is marked origin-declared, so the drift guard keeps its anchor (got ${objShape?.originDeclaredPrice})`,
    objShape?.originDeclaredPrice === 0.01);
  const objNoFigure = normaliseManifestTools(
    { resources: [{ url: "https://seller.example/api/nofig", method: "POST", price: { scheme: "exact", network: "eip155:8453" } }] },
    "https://seller.example").find((r) => String(r.route).includes("/api/nofig"));
  check(`a price object carrying no figure still declares nothing`, !(Number(objNoFigure?.originDeclaredPrice) > 0));
  // An ARRAY is not the object shape: descending into it reads index keys that
  // mean nothing, so it must declare nothing rather than invent a figure.
  const objArray = normaliseManifestTools(
    { resources: [{ url: "https://seller.example/api/arr", method: "POST", price: [{ amountUsd: "0.01" }] }] },
    "https://seller.example").find((r) => String(r.route).includes("/api/arr"));
  check(`an array-shaped price declares nothing (got ${objArray?.price})`,
    !(Number(objArray?.originDeclaredPrice) > 0) && !String(objArray?.price || "").includes("0.01"));
}

// ---- new-catalog quote burst (2026-09-01) ----------------------------------
// An origin with zero priced tools is invisible to routing; the burst exists
// so a new large catalog becomes routable in one cycle instead of half a day.
{
  const { quoteProbeCapFor } = await import("../src/x402-index.js");
  const unpriced = Array.from({ length: 100 }, (_, i) => ({ route: `/r${i}`, price: null }));
  const cap = quoteProbeCapFor(unpriced);
  check(`a wholly unpriced catalog gets the burst (${cap})`, cap >= 60);
  check("a FEW priced rows do not end the burst - the live miss: a registry merge priced 8 of 128 and the burst never fired",
    quoteProbeCapFor([...Array.from({ length: 8 }, (_, i) => ({ route: `/p${i}`, price: 0.001 })), ...unpriced]) >= 60);
  check("a mostly-priced catalog is back on the polite cap",
    quoteProbeCapFor([...Array.from({ length: 90 }, (_, i) => ({ route: `/p${i}`, price: 0.001 })), ...Array.from({ length: 10 }, (_, i) => ({ route: `/u${i}`, price: null }))]) === 5);
  check("an empty list never returns a smaller cap than the steady state", quoteProbeCapFor([]) >= 5);
}

// ── One reader for every payment annotation dialect (2026-09-18) ────────────
// One prod crawl cycle logged unrecognized payment-ish keys from ~250 origins,
// whose operations were indexed as FREE because the reader knew four keys.
// Each fixture below is the shape read off a live document that day (addresses
// replaced). Mutation check: remove one dialect from openapiOperationPayment
// and its fixture reads free (paid false / price null) here.
{
  const { normaliseOpenapiTools, openapiOperationPayment, unknownPaymentishKeys } = await import("../src/x402-index.js");
  const PAYTO = "0x1111111111111111111111111111111111111111";
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const doc = {
    openapi: "3.1.0",
    paths: {
      // dialect A: x-price-usd + x-payment with amountUsd AND amountAtomic
      "/usd": { post: { operationId: "usd", "x-x402-price-usd": 0.001, "x-price-usd": 0.001, "x-payment": { protocol: "x402", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amountUsd: 0.001, amountAtomic: "1000" } } },
      // dialect B: "$0.003" string + x-payment with no amount at all
      "/usd-str": { post: { operationId: "usd-str", "x-price-usd": "$0.003", "x-payment": { protocol: "x402", network: "eip155:8453", asset: "USDC", payTo: PAYTO } } },
      // dialect C: x-x402 accepts-shaped with amountAtomic only
      "/x402-atomic": { post: { operationId: "x402-atomic", "x-x402": { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amountAtomic: "1000" } } },
      // dialect D: x-x402 with a display price and network_default
      "/x402-price": { post: { operationId: "x402-price", "x-x402": { price: "$0.01", scheme: "exact", network_default: "eip155:8453" } } },
      // dialect E: x-payment v2 accepts with the ATOMIC `amount` (1,000,000 = $1)
      "/pay-amount": { post: { operationId: "pay-amount", "x-payment": { x402Version: 2, scheme: "exact", network: "eip155:8453", amount: "1000000", asset: USDC_BASE, payTo: PAYTO, maxTimeoutSeconds: 300 } } },
      // dialect F: x-402 with price + priceMicros
      "/x402-micros": { post: { operationId: "x402-micros", "x-402": { price: "$0.05", priceMicros: 50000, network: "eip155:8453", payTo: PAYTO, asset: "USDC" } } },
      // dialect G: x-402 with price_usdc and a shorthand network
      "/x402-usdc": { post: { operationId: "x402-usdc", "x-402": { price_usdc: 0.003, network: "base", asset: "USDC" } } },
      // dialect H: x-402 priceUsd
      "/x402-priceusd": { post: { operationId: "x402-priceusd", "x-402": { priceUsd: 0.005, network: "eip155:8453", asset: "USDC" } } },
      // dialect I: x-price-usdc scalar
      "/price-usdc": { post: { operationId: "price-usdc", "x-price-usdc": 0.001 } },
      // dialect J: x-x402-price-atomic + x-x402-network beside x-payment-info
      "/atomic": { post: { operationId: "atomic", "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.003" } }, "x-x402-price-atomic": "3000", "x-x402-network": "eip155:8453" } },
      // dialect K: x-payment-required true + x-payment-info with a STRING price
      "/required": { get: { operationId: "required", "x-payment-required": true, "x-payment-info": { protocols: ["x402"], pricingMode: "fixed", price: "$0.01" } } },
      // x-payment-required true alone: paid, price unknown (the live 402 learns it)
      "/required-bare": { get: { operationId: "required-bare", "x-payment-required": true } },
      // dialect J, router form: x-payment-required false + a non-numeric atomic marker: FREE
      "/free": { post: { operationId: "free", "x-payment-required": false, "x-x402-price-atomic": "quoted_from_live_rail" } },
      // no annotation at all in an annotated document: free sibling
      "/plain": { get: { operationId: "plain" } },
    },
  };
  const rows = Object.fromEntries(normaliseOpenapiTools(doc, "https://seller.example").map((t) => [t.slug, t]));
  const priced = (slug, price, why) => check(`${slug}: ${why} -> price ${price} (got ${rows[slug]?.price}, paid ${rows[slug]?.paid})`, rows[slug]?.price === price && rows[slug]?.paid === true);
  priced("usd", "$0.001", "x-price-usd scalar reads as dollars");
  priced("usd-str", "$0.003", "x-price-usd \"$0.003\" string reads as dollars");
  priced("x402-atomic", "$0.001", "x-x402 amountAtomic 1000 reads through the asset's decimals");
  priced("x402-price", "$0.01", "x-x402 display price reads as dollars");
  priced("pay-amount", "$1", "x-payment accepts-shaped amount \"1000000\" is ATOMIC, one dollar, never a million");
  priced("x402-micros", "$0.05", "x-402 price wins over priceMicros and they agree");
  priced("x402-usdc", "$0.003", "x-402 price_usdc reads as dollars");
  priced("x402-priceusd", "$0.005", "x-402 priceUsd reads as dollars");
  priced("price-usdc", "$0.001", "x-price-usdc scalar reads as dollars");
  priced("atomic", "$0.003", "x-payment-info amount + x-x402-price-atomic agree at $0.003");
  priced("required", "$0.01", "x-payment-info with a STRING price beside x-payment-required true");
  check(`required-bare: x-payment-required true alone is PAID with the price unknown (got paid ${rows["required-bare"]?.paid}, price ${rows["required-bare"]?.price})`, rows["required-bare"]?.paid === true && rows["required-bare"]?.price == null);
  check(`free: x-payment-required false with no price is FREE (got paid ${rows.free?.paid}, price ${rows.free?.price})`, rows.free?.paid === false && rows.free?.price == null);
  check(`plain: an unannotated sibling in an annotated document is free (got paid ${rows.plain?.paid})`, rows.plain?.paid === false);
  // A declared ZERO is "free", never a paid "$0" row that wins the cheapest-price
  // tiebreak on every equal-score /api/route query; negative and exponent
  // figures are not prices at all (a "$-0.001" display price the money path
  // cannot read). x-payment-required true beside a zero wins as paid/unknown.
  const zero = (op, why, exp) => { const r = openapiOperationPayment(op); check(`${why} (got paid ${r.paid}, price ${r.price})`, r.paid === exp.paid && r.price === exp.price); };
  zero({ "x-price-usd": 0 }, "x-price-usd 0 is FREE, not a $0 paid row", { paid: false, price: null });
  zero({ "x-402": { priceMicros: 0, network: "eip155:8453" } }, "x-402 priceMicros 0 is FREE", { paid: false, price: null });
  zero({ "x-payment": { x402Version: 2, scheme: "exact", network: "eip155:8453", amount: "0", asset: USDC_BASE, payTo: PAYTO } }, "accepts-shaped amount 0 is FREE", { paid: false, price: null });
  zero({ "x-price-usd": 0, "x-payment-required": true }, "zero beside x-payment-required true is PAID with the price unknown", { paid: true, price: null });
  zero({ "x-x402": { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amountAtomic: "-1000" } }, "a negative atomic amount is not a price (terms declared, so still paid)", { paid: true, price: null });
  zero({ "x-x402": { scheme: "exact", network: "eip155:8453", asset: "USDC", amountAtomic: "1e6" } }, "an exponent atomic amount is not a price", { paid: true, price: null });
  zero({ "x-price-usd": -0.5 }, "a negative dollar figure is not a price (terms declared, so still paid)", { paid: true, price: null });
  // Chains and payTo ride out of the object dialects, so these rows chain-match.
  check(`usd: network + payTo from x-payment (got ${JSON.stringify(rows.usd?.networks)} ${JSON.stringify(rows.usd?.payToByNetwork)})`, rows.usd?.networks?.[0] === "eip155:8453" && rows.usd?.payToByNetwork?.["eip155:8453"] === PAYTO);
  check(`x402-usdc: shorthand network "base" normalises to eip155:8453 (got ${JSON.stringify(rows["x402-usdc"]?.networks)})`, rows["x402-usdc"]?.networks?.[0] === "eip155:8453");
  check(`atomic: x-x402-network rides out as the row's network (got ${JSON.stringify(rows.atomic?.networks)})`, rows.atomic?.networks?.[0] === "eip155:8453");
  check(`x402-price: network_default rides out (got ${JSON.stringify(rows["x402-price"]?.networks)})`, rows["x402-price"]?.networks?.[0] === "eip155:8453");
  // An atomic figure read as dollars would be the 2026-09-15 class of overquote.
  const atomicOnly = openapiOperationPayment({ "x-payment": { x402Version: 2, network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amount: "2500" } });
  check(`accepts-shaped amount "2500" is $0.0025, not $2500 (got ${atomicOnly.price})`, atomicOnly.price === "$0.0025");
  // The dialect watch: every key above is recognized (no log line), a novel one still surfaces.
  check(`no recognized dialect is reported as unknown (got ${JSON.stringify(unknownPaymentishKeys(doc))})`, unknownPaymentishKeys(doc).length === 0);
  const novel = unknownPaymentishKeys({ paths: { "/n": { get: { "x-fee-usd": 0.1 } } } });
  check(`a novel payment-ish key still announces itself (got ${JSON.stringify(novel)})`, novel.length === 1 && novel[0] === "x-fee-usd");
  // A document annotated only with x-payment-required:false is not a paid service.
  check("x-payment-required:false alone never reads as a paid signal", openapiOperationPayment({ "x-payment-required": false }).paid === false);
}


// --- the origin-declaration anchor (2026-09-21) ------------------------------
// CN Evidence reported a $0.032 route listed at $0.002 across two
// re-registrations. The correction that should have caught it re-probes a
// route whose learned price disagrees with the origin's declaration - and the
// anchor it needs, originDeclaredPrice, was never stamped for them, so there
// was nothing to disagree with. Measured across 41 indexed sellers carrying
// priced rows, 38 had no anchor at all: the fix shipped in August and again in
// September was inert for about 93% of them.
{
  const { normaliseOpenapiTools } = await import("../src/x402-index.js");
  const openapi = {
    openapi: "3.0.0",
    paths: {
      "/paid": { get: { summary: "Paid thing", "x-price": "$0.032" } },
      "/free": { get: { summary: "Free thing" } },
    },
  };
  const rows = normaliseOpenapiTools(openapi, "https://seller.example");
  const paid = rows.find((r) => r.route === "/paid");
  check(`an x-price in the origin's OWN OpenAPI stamps the anchor (got ${paid?.originDeclaredPrice})`, Number(paid?.originDeclaredPrice) === 0.032);
  const free = rows.find((r) => r.route === "/free");
  check("an operation that declares no price declares no anchor either", free && free.originDeclaredPrice === undefined);

  // The stamp must survive a display string. A bare Number("$0.032") is NaN,
  // which skipped the stamp silently on the manifest path once already.
  const dollars = normaliseOpenapiTools({ openapi: "3.0.0", paths: { "/d": { get: { "x-price": "$1.25" } } } }, "https://seller.example");
  check(`a display-string price still stamps (got ${dollars[0]?.originDeclaredPrice})`, Number(dollars[0]?.originDeclaredPrice) === 1.25);
}

// --- a priced catalogue beside an unpriced canonical array --------------------
{
  const { normaliseManifestTools } = await import("../src/x402-index.js");
  // CN Evidence's real shape: `resources` is bare URL strings carrying no
  // price, and the priced rows live one key over in `resourceCatalog`.
  const manifest = {
    resources: ["https://seller.example/x402/basic", "https://seller.example/x402/full"],
    resourceCatalog: [
      { id: "basic", method: "GET", url: "https://seller.example/x402/basic", price: { amount: "0.032", currency: "USDC" } },
      { id: "full", method: "POST", url: "https://seller.example/x402/full", price: { amount: "0.093", currency: "USDC" } },
    ],
  };
  const rows = normaliseManifestTools(manifest, "https://seller.example");
  check(`the bare URL and its priced catalogue entry merge into ONE row per route (got ${rows.length})`, rows.length === 2);
  const basic = rows.find((r) => r.route === "/x402/basic");
  const full = rows.find((r) => r.route === "/x402/full");
  check(`the price is read from the catalogue (got ${basic?.price})`, Number(String(basic?.price).replace(/[^0-9.]/g, "")) === 0.032);
  check("and it anchors, so a stale learned quote can be corrected", Number(basic?.originDeclaredPrice) === 0.032);
  check(`the declared method wins over the verb inferred from a bare URL (got ${full?.method})`, full?.method === "POST");
}

// --- an inferred verb must not publish a seller's route twice -----------------
{
  const { normaliseManifestTools } = await import("../src/x402-index.js");
  // Measured on api.aurelianflo.com: 8 bare `resources` URLs inferred as GET
  // alongside the SAME 8 routes declared POST in `endpoints`, so every endpoint
  // was listed twice and half the buyers were sent to a verb the seller answers
  // 405 to. jmt-x402-proxy carried 20 of these.
  const dup = {
    resources: ["https://seller.example/api/thing"],
    endpoints: [{ path: "/api/thing", method: "POST", name: "Thing" }],
  };
  const rows = normaliseManifestTools(dup, "https://seller.example");
  check(`an inferred-GET row is dropped when a declared sibling exists for that route (got ${rows.length})`, rows.length === 1);
  check("the surviving row carries the method the seller declared", rows[0].method === "POST");

  // A seller who genuinely serves both declares both, and neither is inferred.
  const both = {
    endpoints: [
      { path: "/api/thing", method: "GET", name: "Read" },
      { path: "/api/thing", method: "POST", name: "Write" },
    ],
  };
  const kept = normaliseManifestTools(both, "https://seller.example");
  check(`two DECLARED verbs on one route both survive (got ${kept.length})`, kept.length === 2);

  // An inferred row with no declared sibling is real listing data and stays.
  const lone = { resources: ["https://seller.example/api/only"] };
  check("an inferred row with no declared sibling is kept - the rule removes duplicates, not discoveries", normaliseManifestTools(lone, "https://seller.example").length === 1);
}

console.log(`\ntest-index-tools-catalog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);