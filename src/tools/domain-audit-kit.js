// domain-audit-kit — Domain Security & Deliverability Audit. Hand over a domain
// and get one graded, actionable report: email authentication (SPF/DMARC/DKIM/
// MX), web security headers (HSTS/CSP/...), and the TLS certificate, plus (pro)
// the attack surface from Certificate Transparency logs, the tech stack, and
// domain registration. Every finding comes from a LIVE probe (deterministic,
// reproducible) - a chatbot guesses, this measures.
//
// The value is packaging + interpretation: the probes already exist as tools;
// this composes them, grades the whole domain, and synthesizes a prioritized
// remediation plan. Near-zero upstream cost (the probes are free; only the
// synthesis touches OpenRouter), so it is the highest-margin report product.
// Settlement-safe (throws >=400 on failure), WALLET_ONLY, not cached. Gated on
// OPENROUTER_API_KEY for the synthesis (503 without it).
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { KIT } from "./kit.js";
import { NETWORK_TOOLS } from "./network-kit.js";
import { NETWORK_TOOLS2 } from "./network-kit2.js";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
export const DOMAIN_AUDIT_MODELS = [SYNTH];

export const DOMAIN_AUDIT_TIERS = {
  "domain-audit": { price: "$5", maxUpstreamUsd: 1, pro: false, synthMaxTokens: 3500, words: "~1,200" },
  "domain-audit-pro": { price: "$9", maxUpstreamUsd: 1.5, pro: true, synthMaxTokens: 5000, words: "~1,900" },
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

function normDomain(input) {
  let d = String(input?.domain ?? input?.url ?? input?.host ?? "").trim();
  if (!d) throw bad('"domain" is required, e.g. "example.com"');
  d = d.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || d.length > 253) throw bad(`"${d}" is not a valid domain name`);
  return d;
}

// Grade: email auth (40%) + web headers (35%) + TLS (25%).
function tlsScoreOf(tls) {
  if (!tls || tls.daysRemaining == null) return null;
  const d = Number(tls.daysRemaining);
  if (!Number.isFinite(d) || d <= 0) return 0;
  if (d > 30) return 100;
  if (d > 7) return 60;
  return 30;
}
function letterFor(n) { return n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : n >= 60 ? "D" : "F"; }

export function makeDomainAuditHandler(tierSlug) {
  const t = DOMAIN_AUDIT_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"domain": "example.com"}');
    const domain = normDomain(input);
    const user = safeUser(req);

    // 1) LIVE PROBES (parallel, each non-fatal).
    const emailH = H("email-deliverability"), tlsH = H("tls-cert"), hdrH = H("http-headers");
    const core = await Promise.all([
      settle(emailH({ domain }), PROBE_TIMEOUT_MS),
      settle(tlsH({ host: domain }), PROBE_TIMEOUT_MS),
      settle(hdrH({ url: `https://${domain}` }), PROBE_TIMEOUT_MS),
    ]);
    const [emailR, tlsR, hdrR] = core;
    let ct = null, tech = null, whois = null;
    if (t.pro) {
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
    const emailScore = email?.score ?? 0;
    const headerScore = hdr?.security?.score ?? 0;
    const tlsScore = tlsScoreOf(tls);
    // Composite over the dimensions we could measure (renormalize weights).
    const dims = [];
    if (email) dims.push([0.40, emailScore]);
    if (hdr) dims.push([0.35, headerScore]);
    if (tlsScore != null) dims.push([0.25, tlsScore]);
    const wsum = dims.reduce((a, [w]) => a + w, 0) || 1;
    const composite = Math.round(dims.reduce((a, [w, s]) => a + w * s, 0) / wsum);
    const grade = letterFor(composite);

    // 2) GROUNDING BLOCKS (the probe results are the only source of truth).
    const emailBlock = email
      ? `Score ${emailScore}/100 (${email.summary}). SPF: ${email.spf?.hasRecord ? `present (${email.spf.all || "?"}all, ${email.spf.lookupCount} lookups, valid=${email.spf.valid})` : "MISSING"}. DMARC: ${email.dmarc?.hasRecord ? `p=${email.dmarc.policy} at ${email.dmarc.percent}% (valid=${email.dmarc.valid})` : "MISSING"}. DKIM: ${email.dkim?.found?.length ? email.dkim.found.map((d) => `${d.selector} (${d.bits}-bit, valid=${d.valid})`).join(", ") : `none found (probed ${email.dkim?.probed?.length || 0} selectors)`}. MX: ${email.mx?.count || 0} records. Checks: ${(email.checks || []).map((c) => `${c.check}=${c.status}`).join(", ")}.`
      : `email-deliverability probe FAILED: ${emailR.error}`;
    const hdrBlock = hdr
      ? `Security-header score ${headerScore}/100. Findings: ${(hdr.security?.findings || []).map((f) => `${f.header}=${f.present ? "present" : "MISSING"}`).join(", ")}. Warnings: ${(hdr.security?.warnings || []).join("; ") || "none"}. HTTP status ${hdr.status}.`
      : `http-headers probe FAILED: ${hdrR.error}`;
    const tlsBlock = tls
      ? `Issuer ${tls.issuer || "?"}, subject ${tls.subject || "?"}, valid to ${tls.validTo || "?"} (${tls.daysRemaining} days remaining), ${(tls.altNames || []).length} SANs.`
      : `tls-cert probe FAILED: ${tlsR.error}`;
    const proBlock = t.pro ? [
      ct ? `CERTIFICATE TRANSPARENCY: ${ct.total ?? ct.count ?? (ct.subdomains?.length || 0)} certs/subdomains seen. Subdomains: ${(ct.subdomains || ct.names || []).slice(0, 40).join(", ") || "(none parsed)"}.` : "CT probe unavailable.",
      tech ? `TECH STACK: ${(tech.technologies || tech.stack || tech.detected || []).map((x) => (typeof x === "string" ? x : x.name || x.technology)).filter(Boolean).slice(0, 40).join(", ") || "(none detected)"}.` : "Tech-stack probe unavailable.",
      whois ? `REGISTRATION: registrar ${whois.registrar || "?"}, created ${whois.created || whois.creationDate || "?"}, expires ${whois.expires || whois.expiryDate || "?"}.` : "WHOIS probe unavailable.",
    ].join("\n") : "";

    // 3) SYNTHESIZE - grounded, graded, actionable.
    const synthPrompt = `You are a security analyst writing a DOMAIN SECURITY & DELIVERABILITY AUDIT for ${domain} that will be SOLD to a paying customer. Every statement must come from the LIVE PROBE RESULTS below - do not invent a finding, header, or record that is not in the data.

The overall grade is ${grade} (composite ${composite}/100). Write a clear, well-structured report of up to ${t.words} words with these sections:
- OVERALL GRADE: state the letter grade ${grade} and composite ${composite}/100, and a one-paragraph bottom line.
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
    const header = `# Domain Security Audit: ${domain}\n\n**Overall grade: ${grade}** (${composite}/100)\n`;
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
      tier: tierSlug, domain, grade, composite,
      email_score: email ? emailScore : null,
      header_score: hdr ? headerScore : null,
      tls_days_remaining: tls?.daysRemaining ?? null,
      probes: { email: emailR.ok, tls: tlsR.ok, headers: hdrR.ok, ...(t.pro ? { certTransparency: !!ct, techStack: !!tech, whois: !!whois } : {}) },
      synthesis_model: SYNTH,
    };
    const out = { report, domain, grade, composite, sources: [], tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { emailBlock, hdrBlock, tlsBlock, proBlock };
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
