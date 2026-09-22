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

// --- the payTo a live 402 names is RECORDED (2026-09-22) ---------------------
// A seller whose manifest publishes `resources` as bare URL STRINGS and its
// wallet once, in a top-level payment block, was listed with an EMPTY
// payToByNetwork: the live-402 probe read the price, the chains and the EIP-712
// domain off the challenge and threw the payTo away, the carry-forward carried
// everything but that, and the manifest reader only ever looked for a payTo on
// a RESOURCE. allPayToOrigins builds the Base scan's wallet list from that one
// field, so the wallet was never scanned, no settlement could be credited to
// the origin, and such a seller could not clear the settlement floor however
// many outside buyers paid it. Fixtures are the live shapes on a neutral origin.
{
  process.env.X402_INDEX_CRAWL = "off";
  process.env.X402_SYNC_ON_START = "false";
  const { quoteFromAccepts } = await import("../src/x402-live-quote.js");
  const {
    enrichLiveQuotes, carryForwardLearnedQuotes, normaliseManifestTools,
    allPayToOrigins, sellerDetail, indexSnapshot, __testSeedCache, __testResetSubmitted,
  } = await import("../src/x402-index.js");

  const PAYTO = "0x3aEDB825B264e82676A42B1a6d12EA253c0Ce852";
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_PAYTO = "J28Fii2VFnJcavvaeEfsKc628htk3mnrZKubD7WsGStW";
  const accept = (over = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amount: "32000", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });

  // 1. the reader keeps every accept's payTo, keyed by its network
  {
    const q = quoteFromAccepts([accept(), { network: SOL_NET, payTo: SOL_PAYTO, amount: "32000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]);
    check(`a live 402's payTo rides out per network (got ${JSON.stringify(q?.payToByNetwork)})`,
      q?.payToByNetwork?.["eip155:8453"] === PAYTO && q.payToByNetwork[SOL_NET] === SOL_PAYTO);
    const twice = quoteFromAccepts([accept({ payTo: "0x0000000000000000000000000000000000000001", extra: { name: "WEIRD" } }), accept()]);
    check("one network offered twice keeps the PREFERRED accept's payee, not the first row",
      twice?.payToByNetwork?.["eip155:8453"] === PAYTO);
  }

  // 2. the probe writes it onto the row, and a v1-style network label is
  //    normalised first - allPayToOrigins reads the eip155 key, so a payTo
  //    filed under "base" is a payTo the Base scan never sees.
  const ORIGIN = "https://example.com"; // resolves: assertPublicUrl runs before the (stubbed) fetch
  const header = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
  const stub = (rules) => async (url, init = {}) => {
    const u = new URL(String(url));
    const hit = rules[`${String(init.method || "GET").toUpperCase()} ${u.pathname}`];
    if (!hit) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 402, headers: { "payment-required": header(hit), "content-type": "application/json" } });
  };
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = stub({ "GET /x402/basic": [accept()] });
    const rows = [{ seller: ORIGIN, route: "/x402/basic", method: "GET", slug: "basic", price: null, networks: [] }];
    await enrichLiveQuotes(rows, ORIGIN, { ignoreBudget: true });
    check(`the probed row carries the payTo its own 402 named (got ${JSON.stringify(rows[0].payToByNetwork)})`,
      rows[0].payToByNetwork?.["eip155:8453"] === PAYTO);

    globalThis.fetch = stub({ "GET /x402/v1": [accept({ network: "base" })] });
    const v1 = [{ seller: ORIGIN, route: "/x402/v1", method: "GET", slug: "v1", price: null, networks: [] }];
    await enrichLiveQuotes(v1, ORIGIN, { ignoreBudget: true });
    check(`a 402 naming "base" files its payTo under eip155:8453 (got ${JSON.stringify(v1[0].payToByNetwork)})`,
      v1[0].payToByNetwork?.["eip155:8453"] === PAYTO);

    // the sibling branch: the stated GET does not answer, the declared POST
    // sibling does, so the payTo belongs on the row that survives.
    globalThis.fetch = stub({ "POST /x402/full": [accept()] });
    const pair = [
      { seller: ORIGIN, route: "/x402/full", method: "GET", slug: "full-get", price: null, networks: [] },
      { seller: ORIGIN, route: "/x402/full", method: "POST", slug: "full-post", price: null, networks: [] },
    ];
    await enrichLiveQuotes(pair, ORIGIN, { ignoreBudget: true });
    const survivor = pair.find((r) => r.method === "POST");
    check(`the surviving sibling carries the payTo (got ${JSON.stringify(survivor?.payToByNetwork)}, rows ${pair.length})`,
      pair.length === 1 && survivor?.payToByNetwork?.["eip155:8453"] === PAYTO);
  } finally {
    globalThis.fetch = origFetch;
  }

  // 3. and it SURVIVES the next crawl, which rebuilds the row from a catalogue
  //    that names no wallet - filling a gap only, never overriding an address
  //    the origin's own document declared this crawl.
  const learned = { tools: [{ route: "/x402/basic", method: "GET", price: 0.032, quoteSource: "live-402", networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": PAYTO } }] };
  const carried = carryForwardLearnedQuotes([{ route: "/x402/basic", method: "GET", slug: "basic" }], learned)[0];
  check(`carry-forward keeps the learned payTo across the rebuild (got ${JSON.stringify(carried.payToByNetwork)})`,
    carried.payToByNetwork?.["eip155:8453"] === PAYTO);
  const declaredNow = carryForwardLearnedQuotes([{ route: "/x402/basic", method: "GET", payToByNetwork: { "eip155:8453": "0x0000000000000000000000000000000000000002" } }], learned)[0];
  check("a payTo this crawl read from the origin is never overwritten by the remembered one",
    declaredNow.payToByNetwork["eip155:8453"] === "0x0000000000000000000000000000000000000002");
  const sharedSource = { "eip155:8453": "0x0000000000000000000000000000000000000003" };
  carryForwardLearnedQuotes([{ route: "/a", method: "GET", payToByNetwork: sharedSource }],
    { tools: [{ route: "/a", method: "GET", price: 1, quoteSource: "live-402", payToByNetwork: { [SOL_NET]: SOL_PAYTO } }] });
  check("a manifest's shared payTo object is never written through (rows on one path would move together)",
    sharedSource[SOL_NET] === undefined);

  // 4. the manifest's own top-level wallet reaches a bare-string resource row
  const manifest = {
    spec: "x402", version: 2,
    resources: ["https://seller.example/x402/basic", "https://seller.example/x402/full"],
    payment: { x402: { version: 2, currency: "USDC", networks: ["base"], primaryNetwork: "base", payTo: PAYTO, nonCustodial: true } },
  };
  const bare = normaliseManifestTools(manifest, "https://seller.example");
  check(`a bare-string resource inherits the service-wide payTo (got ${JSON.stringify(bare[0]?.payToByNetwork)})`,
    bare.length === 2 && bare.every((r) => r.payToByNetwork?.["eip155:8453"] === PAYTO));
  check(`and the declared chain with it (got ${JSON.stringify(bare[0]?.networks)})`, bare[0]?.networks?.[0] === "eip155:8453");
  const mixed = normaliseManifestTools({ resources: ["https://seller.example/x"], payment: { x402: { networks: ["base", "solana"], payTo: PAYTO } } }, "https://seller.example");
  check(`an EVM wallet is not filed under a Solana network (got ${JSON.stringify(mixed[0]?.payToByNetwork)})`,
    mixed[0]?.payToByNetwork?.["eip155:8453"] === PAYTO && Object.keys(mixed[0].payToByNetwork).length === 1
    && mixed[0].networks.length === 2);

  // 5. end to end: the field the Base scan and the seller page actually read
  __testResetSubmitted();
  __testSeedCache([["https://seller.example", {
    origin: "https://seller.example", fetchedAt: Date.now(), history: [1], originResponded: true,
    manifest: { name: "Seller" },
    tools: bare.map((r) => ({ ...r, price: 0.032, paid: true })),
  }]]);
  const detail = sellerDetail("seller.example");
  check(`sellerDetail publishes the payTo (got ${JSON.stringify(detail?.payToByNetwork)})`,
    detail?.payToByNetwork?.["eip155:8453"] === PAYTO && detail.payTosByNetwork["eip155:8453"][0] === PAYTO);
  const snapRow = indexSnapshot({ baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "x" })
    .sellers.find((x) => x.origin === "https://seller.example");
  check(`the snapshot row carries it (got ${JSON.stringify(snapRow?.payToByNetwork)})`,
    snapRow?.payToByNetwork?.["eip155:8453"] === PAYTO);
  const scan = allPayToOrigins("eip155:8453");
  check("allPayToOrigins offers the wallet to the Base scan, mapped to its origin",
    scan.get(PAYTO.toLowerCase())?.has("https://seller.example") === true);
  __testResetSubmitted();
}

// --- an ATOMIC amount is not dollars, in two more shapes (2026-09-22) --------
// The 2026-09-15 fix taught the reader that an accept-shaped ENTRY states base
// units. Two live shapes kept reading them as dollars because the context sits
// one level in: a manifest `price` OBJECT carrying decimals/asset beside the
// amount (listed a $0.003 route at $3000) and MPP's `x-payment-info`
// {amount, currency, method, intent, offers} (listed a $0.005 route at $5000).
// A listing a million times the seller's real price also puts the route over
// every router tier cap, and the seller cannot see our index to report it.
{
  const { normaliseManifestTools, normaliseOpenapiTools, openapiOperationPayment, mergeOpenapiIntoBazaar, bazaarItemToTool, priceToMicroUsd } = await import("../src/x402-index.js");
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50"; // Tempo, six decimals
  const PAYTO = "0x2880EdfFF13100677Bf97A3CBdF3Bc34771C4E5E";
  const stack = (price) => normaliseManifestTools({
    x402Version: 2,
    payment: { protocol: "x402", scheme: "exact", network: "eip155:8453", asset: "USDC", asset_address: USDC_BASE, pay_to: PAYTO },
    resources: [{ resource: "https://seller.example/stack", method: "POST", price, description: "Identify a site's stack." }],
  }, "https://seller.example")[0];

  const priced = (row, want, why) => check(`${why} -> ${want} (got ${row?.price})`, row?.price === want);
  priced(stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" }), "$0.003",
    "the seller's own display string wins over a figure we would have to convert");
  priced(stack({ amount: "3000", asset: USDC_BASE, decimals: 6 }), "$0.003", "declared decimals size the amount");
  priced(stack({ amount: "3000", asset: USDC_BASE }), "$0.003", "a token we know is six decimals needs no declaration");
  priced(stack({ amount: "0.032", currency: "USDC", network: "eip155:8453" }), "$0.032",
    "a bare currency beside a fractional amount is dollars, which is what catalogues publish");
  priced(stack({ amount: "0.003", asset: USDC_BASE, decimals: 6 }), "$0.003",
    "a fractional figure cannot be base units whatever sits beside it");
  const unknown = stack({ amount: "3000", asset: "0x00000000000000000000000000000000000000ff" });
  check(`a token we cannot size publishes NO price rather than a guess (got ${unknown?.price})`,
    unknown?.price == null && !(Number(unknown?.originDeclaredPrice) > 0));
  check(`the readable one anchors the drift guard (got ${stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" })?.originDeclaredPrice})`,
    stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" })?.originDeclaredPrice === 0.003);

  const mpp = { amount: "5000", currency: USDC_E, description: "Ask a question.", intent: "charge", method: "tempo" };
  const doc = { openapi: "3.1.0", paths: { "/v1/query": { post: { operationId: "query", "x-payment-info": { ...mpp, offers: [{ ...mpp }] } } } } };
  const mppRow = normaliseOpenapiTools(doc, "https://seller.example").find((t) => t.route === "/v1/query");
  check(`MPP x-payment-info amount "5000" is $0.005, never $5000 (got ${mppRow?.price})`, mppRow?.price === "$0.005" && mppRow?.paid === true);
  check("an offers-only declaration prices the same way",
    openapiOperationPayment({ "x-payment-info": { intent: "charge", method: "tempo", offers: [{ ...mpp }] } }).price === "$0.005");
  const stripeish = openapiOperationPayment({ "x-payment-info": { amount: "50", currency: "usd", intent: "charge", method: "stripe" } });
  check(`a currency we cannot size is PAID with the price unknown, never $50 (got ${stripeish.price})`,
    stripeish.paid === true && stripeish.price == null);

  // GUARD, scoped to the FIGURE rather than to these two dialects: an
  // origin-declared price that differs from the settlement-observed Bazaar
  // price by 1000x or more is not a disagreement about value, it is a units
  // bug. Whatever shape arrives next in base units lands here.
  const thousandfold = (rows) => rows.filter((r) => {
    const o = priceToMicroUsd(r?.priceObservations?.origin);
    const b = priceToMicroUsd(r?.priceObservations?.bazaar);
    if (!(o > 0) || !(b > 0)) return false;
    return (o > b ? o / b : b / o) >= 1000;
  });
  const observed = (route, amount, method) => bazaarItemToTool({
    resource: `https://seller.example${route}`, method,
    accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAYTO, amount, extra: { name: "USD Coin" } }],
  }, "https://seller.example");
  // control FIRST: the figure the old reader produced must be flagged, so a
  // clean sweep below is only believed once the check has caught one.
  const planted = mergeOpenapiIntoBazaar([{ ...stack({ amount: "3000", asset: USDC_BASE, decimals: 6 }), price: "$3000" }], [observed("/stack", "3000", "POST")]);
  check(`control: a $3000 reading of a 3000-base-unit route is flagged (${thousandfold(planted).length})`, thousandfold(planted).length === 1);
  const swept = [
    ...mergeOpenapiIntoBazaar([stack({ amount: "3000", asset: USDC_BASE, decimals: 6, display: "$0.003" })], [observed("/stack", "3000", "POST")]),
    ...mergeOpenapiIntoBazaar([mppRow], [observed("/v1/query", "5000", "POST")]),
  ];
  check(`no declared price is a thousandfold of what settled (${thousandfold(swept).length} flagged of ${swept.length})`,
    swept.length === 2 && thousandfold(swept).length === 0);
}

console.log(`\ntest-index-tools-catalog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);