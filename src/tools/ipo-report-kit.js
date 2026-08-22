// ipo-report-kit — IPO PIPELINE DIGEST: new S-1 registrations (companies
// preparing to list) and 424B4 final prospectuses (IPOs that actually priced)
// filed with the SEC in a window, optionally filtered by a keyword on the
// filer's name. DETERMINISTIC - built from EDGAR full-text search through the
// existing edgar-recent-ipos tool, no LLM, so it is cheap enough to run weekly
// for every subscriber of the IPO watch monitor and honest by construction
// (nothing is summarized that is not in the filing index). Egress -> WALLET_ONLY.
//
// `probeIpos()` is exported for the monitor scheduler: same data, plus a
// fingerprint of the accession numbers seen.
import { bad } from "./llm-gateway-kit.js";
import { EDGAR_TOOLS } from "./edgar-kit.js";

export const IPO_TIERS = { "ipo-report": { price: "$0.05", maxDays: 90, limit: 200 } };
const MAX_KEYWORD = 60;

let _edgar = null;
function H(slug) {
  const t = (_edgar ||= EDGAR_TOOLS).find((x) => x.slug === slug);
  if (!t) throw bad(`ipo-report: missing dependency '${slug}'`, 500);
  return t.handler;
}
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

export function normIpoKeyword(input) {
  const k = String(typeof input === "string" ? input : input?.keyword ?? input?.target ?? "").replace(/\s+/g, " ").trim();
  if (!k || /^(all|any|\*)$/i.test(k)) return "";
  if (k.length > MAX_KEYWORD) throw bad(`"keyword" must be at most ${MAX_KEYWORD} characters`);
  if (!/^[\p{L}\p{N} .,'&+/-]+$/u.test(k)) throw bad('"keyword" contains unsupported characters');
  return k;
}

/** Both EDGAR legs for the window; filtered by keyword (case-insensitive,
 *  against the filer display names). Returns rows + a fingerprint of accessions. */
export async function probeIpos({ days = 7, keyword = "", limit = 200 } = {}) {
  const ipos = H("edgar-recent-ipos");
  const [s1, priced] = await Promise.all([
    ipos({ days, form: "S-1", limit }),
    ipos({ days, form: "424B4", limit }),
  ]);
  const kw = keyword ? keyword.toLowerCase() : "";
  const norm = (f, stage) => ({
    stage, form: f.form || "", filedDate: f.filedDate || "", cik: f.cik || "", accessionNumber: f.accessionNumber || "",
    name: Array.isArray(f.displayNames) && f.displayNames.length ? String(f.displayNames[0]).replace(/\s*\(CIK[^)]*\)\s*$/i, "") : "",
    url: f.url || "",
  });
  const rows = [
    ...((s1?.filings || []).map((f) => norm(f, "registration"))),
    ...((priced?.filings || []).map((f) => norm(f, "priced"))),
  ].filter((r) => !kw || r.name.toLowerCase().includes(kw));
  rows.sort((a, b) => b.filedDate.localeCompare(a.filedDate) || a.name.localeCompare(b.name));
  const ids = [...new Set(rows.map((r) => r.accessionNumber).filter(Boolean))].sort();
  return { days, keyword, startDate: s1?.startDate || null, endDate: s1?.endDate || null, totalS1: s1?.total ?? null, totalPriced: priced?.total ?? null, rows, ids, fingerprint: JSON.stringify(ids) };
}

function makeIpoHandler(tierSlug) {
  const t = IPO_TIERS[tierSlug];
  return async (input) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"days": 7, "keyword": ""}');
    const days = clampInt(input.days, 7, 1, t.maxDays);
    const keyword = normIpoKeyword(input);
    const pr = await probeIpos({ days, keyword, limit: t.limit });
    const reg = pr.rows.filter((r) => r.stage === "registration");
    const priced = pr.rows.filter((r) => r.stage === "priced");
    const line = (r) => `- **${r.name || "(unnamed filer)"}** · ${r.form} filed ${r.filedDate} · CIK ${r.cik} · [filing](${r.url})`;
    const scope = keyword ? ` matching "${keyword}"` : "";
    const report = [
      `# IPO Pipeline Digest${scope}: ${pr.startDate || "?"} to ${pr.endDate || "?"}`,
      ``,
      `**${priced.length} priced IPO${priced.length === 1 ? "" : "s"}** (424B4 final prospectus) and **${reg.length} new registration${reg.length === 1 ? "" : "s"}** (S-1) in the last ${days} day${days === 1 ? "" : "s"}${keyword ? `, filtered to filers whose name contains "${keyword}"` : ""}. Source: SEC EDGAR full-text search; counts are filings, not companies (amendments and multiple filers per deal are not collapsed).`,
      ``,
      `## Priced IPOs (424B4)`,
      priced.length ? priced.map(line).join("\n") : `_No 424B4 final prospectuses${scope} in the window._`,
      ``,
      `## New registrations (S-1)`,
      reg.length ? reg.map(line).join("\n") : `_No S-1 registrations${scope} in the window._`,
      ``,
      `## Sources`,
      `[1] SEC EDGAR full-text search, form S-1, ${pr.startDate || "?"} to ${pr.endDate || "?"} - https://efts.sec.gov/LATEST/search-index?q=&forms=S-1`,
      `[2] SEC EDGAR full-text search, form 424B4, ${pr.startDate || "?"} to ${pr.endDate || "?"} - https://efts.sec.gov/LATEST/search-index?q=&forms=424B4`,
    ].join("\n");
    const tables = [{
      name: "filings", label: "IPO filings",
      columns: ["Stage", "Form", "Filed", "Filer", "CIK", "Accession", "URL"],
      rows: pr.rows.map((r) => [r.stage, r.form, r.filedDate, r.name, r.cik, r.accessionNumber, r.url]),
    }];
    const sources = [
      { n: 1, title: `SEC EDGAR full-text search, form S-1, ${pr.startDate || "?"} to ${pr.endDate || "?"}`, url: "https://efts.sec.gov/LATEST/search-index?q=&forms=S-1" },
      { n: 2, title: `SEC EDGAR full-text search, form 424B4, ${pr.startDate || "?"} to ${pr.endDate || "?"}`, url: "https://efts.sec.gov/LATEST/search-index?q=&forms=424B4" },
    ];
    const meta = { tier: tierSlug, days, keyword: keyword || null, start: pr.startDate, end: pr.endDate, priced: priced.length, registrations: reg.length, total_s1_in_window: pr.totalS1, total_424b4_in_window: pr.totalPriced, deterministic: true };
    return { report, title: `IPO pipeline${scope}`, sources, tables, meta };
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    days: { type: "number", description: "Lookback window in days, 1-90 (default 7)." },
    keyword: { type: "string", description: "Optional filter on the filer's name (case-insensitive). Omit or \"all\" for every filing." },
  },
};
const OUT_EXAMPLE = {
  report: "# IPO Pipeline Digest: 2025-11-11 to 2025-11-18\n\n**2 priced IPOs** (424B4 final prospectus) and **9 new registrations** (S-1) in the last 7 days...\n\n## Priced IPOs (424B4)\n- **Example Newco Inc.** · 424B4 filed 2025-11-17 · CIK 0001999888 · [filing](https://www.sec.gov/Archives/...)\n\n## Sources\n[1] ...",
  title: "IPO pipeline",
  sources: [{ n: 1, title: "SEC EDGAR full-text search, form S-1, 2025-11-11 to 2025-11-18", url: "https://efts.sec.gov/LATEST/search-index?q=&forms=S-1" }],
  tables: [{ name: "filings", label: "IPO filings", columns: ["Stage", "Form", "Filed", "Filer", "CIK", "Accession", "URL"], rows: [["priced", "424B4", "2025-11-17", "Example Newco Inc.", "0001999888", "0001213900-25-099999", "https://www.sec.gov/Archives/..."]] }],
  meta: { tier: "ipo-report", days: 7, keyword: null, priced: 2, registrations: 9, deterministic: true },
};

export const IPO_TOOLS = [
  {
    route: "POST /v1/ipo-report", name: "IPO pipeline digest (S-1 + 424B4)", slug: "ipo-report", category: "data", price: IPO_TIERS["ipo-report"].price,
    description: "A deterministic digest of the IPO pipeline for a window: every 424B4 final prospectus (IPOs that priced) and every S-1 registration (companies preparing to list) from SEC EDGAR, optionally filtered by a keyword on the filer's name, with a downloadable filings table. No LLM, no guessing - filing facts only. Default last 7 days.",
    tags: ["ipo", "sec", "edgar", "s-1", "424b4", "new-listings", "digest", "report", "agentic-finance", "x402", "mpp"],
    discovery: { bodyType: "json", input: { days: 7 }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeIpoHandler("ipo-report"),
  },
];
