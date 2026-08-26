// domain-audit-kit — Domain Security & Deliverability Audit. Hand over a domain
// and get one graded, actionable report: email authentication (SPF/DMARC/DKIM/
// MX), web security headers (HSTS/CSP/...), and the TLS certificate, plus (pro)
// the attack surface from Certificate Transparency logs, the tech stack, and
// domain registration. Every finding comes from a LIVE probe (deterministic,
// reproducible) - a chatbot guesses, this measures.
//
// The value is packaging + interpretation: the probes already exist as tools;
// this composes them, grades the whole domain, and synthesizes a prioritized
// remediation plan. The probes are free (only the synthesis touches OpenRouter).
// Settlement-safe (throws >=400 on failure), WALLET_ONLY, not cached. Gated on
// OPENROUTER_API_KEY for the synthesis (503 without it).
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { KIT } from "./kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { NETWORK_TOOLS } from "./network-kit.js";
import { NETWORK_TOOLS2 } from "./network-kit2.js";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
export const DOMAIN_AUDIT_MODELS = [SYNTH];

export const DOMAIN_AUDIT_TIERS = {
  "domain-audit": { price: "$0.60", maxUpstreamUsd: 0.35, pro: false, synthMaxTokens: 3500, words: "~1,200" },
  "domain-audit-pro": { price: "$0.85", maxUpstreamUsd: 0.5, pro: true, synthMaxTokens: 5000, words: "~1,900" },
};

const SYNTH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;

// Resolve a dependency handler across the kits that hold the probe tools,
// lazily (after all modules have loaded) to avoid any import-order surprise.
let _all = null;
const allTools = () => (_all ||= [...KIT, ...NETWORK_TOOLS, ...NETWORK_TOOLS2]);
function H(slug) {
  const t = allTools().find((x) => x.slug === slug);
  if (!t) throw bad(`domain-audit: missing dependency '${slug}'`, 500);
  return t.handler;
}
async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();

async function settle(p, timeoutMs) {
  try {
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

export function normDomain(input) {
  let d = String(input?.domain ?? input?.url ?? input?.host ?? "").trim();
  if (!d) throw bad('"domain" is required, e.g. "example.com"');
  d = d.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || d.length > 253) throw bad(`"${d}" is not a valid domain name`);
  return d;
}

// Does the certificate cover this host? subject CN or a SAN, wildcard-aware
// (one label). Exported for tests.
export function certCoversHost(tls, domain) {
  const d = String(domain || "").toLowerCase();
  const names = [tls?.subject, ...(Array.isArray(tls?.altNames) ? tls.altNames : [])].filter(Boolean).map((n) => String(n).toLowerCase());
  if (!names.length) return null; // unknown - do not penalise what we did not see
  return names.some((n) => n === d || (n.startsWith("*.") && d.endsWith(n.slice(1)) && d.slice(0, -n.slice(1).length).indexOf(".") < 0 && d.length > n.length - 1));
}

// Grade: email auth (40%) + web headers (35%) + TLS (25%).
// A certificate the chain does not trust, or one for a different host, is a
// broken TLS deployment however many days it has left - it used to score
// 100/100 on days alone (self-signed.badssl.com, wrong.host.badssl.com both
// graded perfect, measured 2026-08-26). Exported for tests.
export function tlsScoreOf(tls, domain = null) {
  if (!tls || tls.daysRemaining == null) return null;
  if (tls.chainTrusted === false) return 0;
  if (domain && certCoversHost(tls, domain) === false) return 0;
  const d = Number(tls.daysRemaining);
  if (!Number.isFinite(d) || d <= 0) return 0;
  if (d > 30) return 100;
  if (d > 7) return 60;
  return 30;
}
function letterFor(n) { return n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : n >= 60 ? "D" : "F"; }

// The LIVE PROBE + GRADE stage, with no LLM: parallel probes (each non-fatal),
// per-dimension scores, the weighted composite and letter grade, and a
// deterministic FINGERPRINT of the security-relevant facts. Exported so the
// monitor scheduler can re-probe a subscribed domain for free on a cadence and
// only pay for a fresh synthesis when something actually changed; the paid
// handler below uses the SAME function, so the two can never grade differently.
export async function probeDomain(domain, { pro = false } = {}) {
  const emailH = H("email-deliverability"), tlsH = H("tls-cert"), hdrH = H("http-headers");
  const core = await Promise.all([
    settle(emailH({ domain }), PROBE_TIMEOUT_MS),
    settle(tlsH({ host: domain }), PROBE_TIMEOUT_MS),
    settle(hdrH({ url: `https://${domain}` }), PROBE_TIMEOUT_MS),
  ]);
  const [emailR, tlsR, hdrR] = core;
  let ct = null, tech = null, whois = null;
  if (pro) {
    const proTools = await Promise.all([
      settle(H("cert-transparency")({ domain }), PROBE_TIMEOUT_MS),
      settle(H("tech-stack")({ url: `https://${domain}` }), PROBE_TIMEOUT_MS),
      settle(H("whois")({ domain }), PROBE_TIMEOUT_MS),
    ]);
    ct = proTools[0].ok ? proTools[0].data : null;
    tech = proTools[1].ok ? proTools[1].data : null;
    whois = proTools[2].ok ? proTools[2].data : null;
  }
  // If EVERY core probe failed, we cannot produce an audit (not charged).
  if (!emailR.ok && !tlsR.ok && !hdrR.ok) throw bad(`Could not reach "${domain}" on any probe (DNS, TLS, or HTTP). Confirm the domain is live. Not charged.`, 422);

  const email = emailR.ok ? emailR.data : null;
  const tls = tlsR.ok ? tlsR.data : null;
  const hdr = hdrR.ok ? hdrR.data : null;
  // A probe that failed (or returned no numeric score) is UNASSESSED, not a
  // zero - a network blip on the email probe must not silently print grade A
  // for a domain with broken email auth, nor drag it to F.
  const emailScore = typeof email?.score === "number" ? email.score : null;
  const headerScore = typeof hdr?.security?.score === "number" ? hdr.security.score : null;
  const tlsScore = tlsScoreOf(tls, domain);
  const dims = [], assessed = [];
  if (emailScore != null) { dims.push([0.40, emailScore]); assessed.push("email auth"); }
  if (headerScore != null) { dims.push([0.35, headerScore]); assessed.push("security headers"); }
  if (tlsScore != null) { dims.push([0.25, tlsScore]); assessed.push("TLS"); }
  if (!dims.length) throw bad(`Could not assess any security dimension for "${domain}" (all probes failed). Not charged.`, 422);
  const wsum = dims.reduce((a, [w]) => a + w, 0) || 1;
  const composite = Math.round(dims.reduce((a, [w, s]) => a + w * s, 0) / wsum);
  const grade = letterFor(composite);
  // The grade only covers dimensions we could measure - say so in the headline
  // so a missing dimension is visible, not buried in prose.
  const gradeCaveat = assessed.length === 3 ? "" : ` (assessed on ${assessed.join(", ")} only)`;

  // Security-relevant FACTS only (no timestamps, no free-text, no volatile
  // fields like days-remaining) so a re-probe of an unchanged domain yields the
  // same fingerprint. tls_days_remaining rides separately for expiry alerts.
  const signals = {
    grade, composite, assessed,
    spf: email ? (email.spf?.hasRecord ? `present:${email.spf.all || "?"}all:valid=${!!email.spf.valid}` : "missing") : null,
    dmarc: email ? (email.dmarc?.hasRecord ? `p=${email.dmarc.policy}:pct=${email.dmarc.percent}:valid=${!!email.dmarc.valid}` : "missing") : null,
    dkim: email ? (email.dkim?.found || []).map((d) => `${d.selector}:${d.bits}`).sort() : null,
    mx: email ? (email.mx?.count ?? 0) : null,
    headers: hdr ? (hdr.security?.findings || []).filter((f) => f.present).map((f) => String(f.header || "").toLowerCase()).sort() : null,
    tls_issuer: tls?.issuer || null,
    tls_valid_to: tls?.validTo || null,
    tls_days_remaining: tls?.daysRemaining ?? null,
  };
  // Excluded from the fingerprint: days-remaining (volatile), and the TLS
  // issuer / valid-to pair - multi-cert CDNs rotate issuers and renew often,
  // which is not a security change; expiry is covered by tls_days_remaining
  // (the monitor's expiry alert) and by the TLS score folded into composite.
  const { tls_days_remaining: _d, tls_issuer: _i, tls_valid_to: _v, ...stable } = signals;
  const fingerprint = JSON.stringify(stable);

  return { domain, emailR, tlsR, hdrR, email, tls, hdr, ct, tech, whois, emailScore, headerScore, tlsScore, composite, grade, assessed, gradeCaveat, signals, fingerprint };
}

function makeDomainAuditHandlerInner(tierSlug) {
  const t = DOMAIN_AUDIT_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"domain": "example.com"}');
    const domain = normDomain(input);
    const user = safeUser(req);

    // 1) LIVE PROBES + GRADE (shared with the monitor scheduler's free re-probe).
    const { emailR, tlsR, hdrR, email, tls, hdr, ct, tech, whois, emailScore, headerScore, composite, grade, assessed, gradeCaveat } = await probeDomain(domain, { pro: t.pro });

    // 2) GROUNDING BLOCKS (the probe results are the only source of truth).
    const emailBlock = email
      ? `Score ${emailScore}/100 (${email.summary}). SPF: ${email.spf?.hasRecord ? `present (${email.spf.all || "?"}all, ${email.spf.lookupCount} top-level lookup mechanisms counted (nested includes not expanded), valid=${email.spf.valid})` : "MISSING"}. DMARC: ${email.dmarc?.hasRecord ? `p=${email.dmarc.policy} at ${email.dmarc.percent}% (valid=${email.dmarc.valid}${email.dmarc.subdomainPolicy ? `; sp=${email.dmarc.subdomainPolicy}` : ""}${email.dmarc.alignment ? `; aspf=${email.dmarc.alignment.spf}, adkim=${email.dmarc.alignment.dkim}` : ""}${email.dmarc.reportingUris ? `; rua=${email.dmarc.reportingUris.aggregate?.length ? email.dmarc.reportingUris.aggregate.join(",") : "NONE"}; ruf=${email.dmarc.reportingUris.failure?.length ? email.dmarc.reportingUris.failure.join(",") : "none"}` : ""}${email.dmarc.failureOptions ? `; fo=${email.dmarc.failureOptions}` : ""})` : "MISSING"}. DKIM: ${email.dkim?.found?.length ? email.dkim.found.map((d) => `${d.selector} (${d.bits}-bit, valid=${d.valid})`).join(", ") : `none found (probed ${email.dkim?.probed?.length || 0} selectors: ${(email.dkim?.probed || []).join(", ")} - a selector outside that list would not be seen)`}. MX: ${email.mx?.count || 0} records${email.mx?.records?.length ? ` (${email.mx.records.slice(0, 8).join(", ")})` : ""}. Checks: ${(email.checks || []).map((c) => `${c.check}=${c.status}`).join(", ")}.`
      : `email-deliverability probe FAILED: ${emailR.error}`;
    const hdrBlock = hdr
      ? `Security-header score ${headerScore}/100. Findings: ${(hdr.security?.findings || []).map((f) => `${f.header}=${f.present ? `present${f.value ? ` [${String(f.value).replace(/\s+/g, " ").slice(0, 300)}]` : ""}` : "MISSING"}`).join(", ")}. Warnings: ${(hdr.security?.warnings || []).join("; ") || "none"}. HTTP status ${hdr.status}.`
      : `http-headers probe FAILED: ${hdrR.error}`;
    const tlsBlock = tls
      ? `Chain trusted: ${tls.chainTrusted === true ? "YES" : tls.chainTrusted === false ? `NO (${tls.authorizationError || "untrusted"}) - TLS scored 0` : "unknown"}; covers ${domain}: ${certCoversHost(tls, domain) === false ? "NO (hostname mismatch) - TLS scored 0" : certCoversHost(tls, domain) ? "yes" : "unknown"}. Issuer ${tls.issuer || "?"}, subject ${tls.subject || "?"}, valid to ${tls.validTo || "?"} (${tls.daysRemaining} days remaining), ${(tls.altNames || []).length} SANs${tls.protocol ? `, negotiated ${tls.protocol}${tls.cipher ? ` / ${tls.cipher}` : ""}` : ""}.`
      : `tls-cert probe FAILED: ${tlsR.error}`;
    const proBlock = t.pro ? [
      ct ? `CERTIFICATE TRANSPARENCY: ${ct.total ?? ct.count ?? (ct.subdomains?.length || 0)} certs/subdomains seen. Subdomains: ${(ct.subdomains || ct.names || []).slice(0, 40).join(", ") || "(none parsed)"}.` : "CT probe unavailable.",
      tech ? `TECH STACK: ${(tech.technologies || tech.stack || tech.detected || []).map((x) => (typeof x === "string" ? x : x.name || x.technology)).filter(Boolean).slice(0, 40).join(", ") || "(none detected)"}.` : "Tech-stack probe unavailable.",
      whois ? `REGISTRATION: registrar ${whois.registrar || "?"}, created ${whois.created || whois.creationDate || "?"}, expires ${whois.expires || whois.expiryDate || "?"}.` : "WHOIS probe unavailable.",
    ].join("\n") : "";

    // 3) SYNTHESIZE - grounded, graded, actionable.
    const synthPrompt = `You are a security analyst writing a DOMAIN SECURITY & DELIVERABILITY AUDIT for ${domain} that will be SOLD to a paying customer. Every statement must come from the LIVE PROBE RESULTS below - do not invent a finding, header, or record that is not in the data.

The overall grade is ${grade} (composite ${composite}/100)${gradeCaveat}. Write a clear, well-structured report of up to ${t.words} words with these sections:
- OVERALL GRADE: state the letter grade ${grade} and composite ${composite}/100, a one-paragraph bottom line, AND if the grade covers only some dimensions (${assessed.join(", ")}) say so plainly - the grade does not cover any probe that could not be completed.
- EMAIL AUTHENTICATION: SPF, DMARC, DKIM, and MX - what is configured, what is missing or weak, and specifically why it affects whether mail lands in the inbox vs spam.
- WEB SECURITY HEADERS: which security headers are present or missing (HSTS, CSP, X-Frame-Options, etc.) and the risk each missing one creates.
- TLS CERTIFICATE: issuer, expiry, and days remaining - flag clearly if it is expiring soon.${t.pro ? "\n- ATTACK SURFACE & STACK: notable subdomains from Certificate Transparency, the detected tech stack, and domain registration." : ""}
- PRIORITIZED FIXES: a NUMBERED, actionable remediation list, most impactful first. Name the exact record or header to add and a concrete example value where you can (e.g. the DMARC record to publish). Be specific and practical.

Do NOT write a sources section. Ground every claim in the probe data; where a probe failed, say the check could not be completed rather than guessing.

=== EMAIL AUTH PROBE ===\n${emailBlock}
=== WEB SECURITY HEADERS PROBE ===\n${hdrBlock}
=== TLS CERTIFICATE PROBE ===\n${tlsBlock}${t.pro ? `\n=== ATTACK SURFACE / STACK / REGISTRATION ===\n${proBlock}` : ""}`;

    let spent = 0;
    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Domain audit synthesis produced nothing - not charged", 502);
    const header = `# Domain Security Audit: ${domain}\n\n**Overall grade: ${grade}** (${composite}/100)${gradeCaveat}\n`;
    const report = `${header}\n${prose}`;

    // 4) DOWNLOADABLE DATA APPENDIX.
    const tables = [];
    if (email?.checks?.length) tables.push({
      name: "email-checks", label: "Email authentication checks",
      columns: ["Check", "Status", "Detail"],
      rows: email.checks.map((c) => [String(c.check || ""), String(c.status || ""), String(c.detail || "")]),
    });
    if (hdr?.security?.findings?.length) tables.push({
      name: "security-headers", label: "Web security headers",
      columns: ["Header", "Present", "Value"],
      rows: hdr.security.findings.map((f) => [String(f.header || ""), f.present ? "yes" : "no", String(f.value ?? "")]),
    });
    if (t.pro && ct) {
      const subs = ct.subdomains || ct.names || [];
      if (subs.length) tables.push({ name: "subdomains", label: "Subdomains (Certificate Transparency)", columns: ["Subdomain"], rows: subs.slice(0, 500).map((s) => [String(s)]) });
    }

    const meta = {
      tier: tierSlug, domain, grade, composite, assessed,
      email_score: emailScore,
      header_score: headerScore,
      tls_days_remaining: tls?.daysRemaining ?? null,
      probes: { email: emailR.ok, tls: tlsR.ok, headers: hdrR.ok, ...(t.pro ? { certTransparency: !!ct, techStack: !!tech, whois: !!whois } : {}) },
      synthesis_model: SYNTH,
    };
    const out = { report, domain, grade, composite, sources: [], tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { emailBlock, hdrBlock, tlsBlock, proBlock };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(DOMAIN_AUDIT_TIERS[tierSlug]) });
    return out;
  };
}

const SCHEMA = {
  type: "object",
  required: ["domain"],
  properties: {
    domain: { type: "string", description: "The domain to audit, e.g. example.com (also accepts a URL or host)." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown report)." },
  },
};
const OUT_EXAMPLE = {
  report: "# Domain Security Audit: example.com\n\n**Overall grade: B** (82/100)\n\n## Overall grade\n...",
  domain: "example.com", grade: "B", composite: 82,
  sources: [],
  tables: [{ name: "email-checks", label: "Email authentication checks", columns: ["Check", "Status", "Detail"], rows: [["spf", "pass", "SPF record present, 1 DNS lookup, ~all qualifier"]] }],
  meta: { tier: "domain-audit", domain: "example.com", grade: "B", composite: 82, email_score: 90, header_score: 70, tls_days_remaining: 204, synthesis_model: "anthropic/claude-opus-5" },
};

export const DOMAIN_AUDIT_TOOLS = [
  {
    route: "POST /v1/domain-audit", name: "Domain security & deliverability audit (graded)", slug: "domain-audit", category: "llm", price: DOMAIN_AUDIT_TIERS["domain-audit"].price,
    description: "Hand over a domain and get one graded security & email-deliverability audit: SPF, DMARC, DKIM and MX (why your mail lands in spam), the web security headers, and the TLS certificate - every finding from a live probe, with an overall letter grade, a downloadable checks appendix, and a prioritized, specific list of fixes. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["security", "domain", "email", "deliverability", "spf", "dmarc", "dkim", "tls", "headers", "audit", "premium", "agent"],
    discovery: { bodyType: "json", input: { domain: "example.com" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeDomainAuditHandler("domain-audit"),
  },
  {
    route: "POST /v1/domain-audit/pro", name: "Domain security audit - PRO (attack surface + stack)", slug: "domain-audit-pro", category: "llm", price: DOMAIN_AUDIT_TIERS["domain-audit-pro"].price,
    description: "The deeper tier: everything in the standard audit plus the attack surface from Certificate Transparency logs (subdomains), the detected tech stack, and domain registration, in a longer graded report with a fuller remediation plan. USDC or card (Stripe). Not cached.",
    tags: ["security", "domain", "email", "deliverability", "attack-surface", "subdomains", "tls", "audit", "premium", "agent"],
    discovery: { bodyType: "json", input: { domain: "example.com" }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "domain-audit-pro" } } } },
    handler: makeDomainAuditHandler("domain-audit-pro"),
  },
];

// Upstream-usage telemetry wrapper: a successful run records its exact spend at
// the return site; a failed run (thrown >= 400, not charged) is recorded here
// so the burn on failures is visible too (spend unknown at this point -> 0).
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
export function makeDomainAuditHandler(tierSlug) {
  const run = makeDomainAuditHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(DOMAIN_AUDIT_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}
