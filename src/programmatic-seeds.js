// Curated entity seeds for the programmatic SEO landing pages
// (/reports/insider/:ticker, /reports/fund/:manager, /reports/dossier/:ticker).
//
// WHY A CURATED LIST AND NOT AN OPEN URL SPACE: every entity page reads SEC
// EDGAR. Advertising an unbounded set of slugs (every 4-letter string) would
// invite crawlers to mint URLs forever and turn each one into an upstream
// request. So the SITEMAP contains only what is listed here, and only these
// entities are linked from the crawlable hub pages. An off-list slug still
// RENDERS when it genuinely resolves on EDGAR (a hand-shared long-tail link
// keeps working) - it is simply never advertised, and an unresolvable slug is
// negative-cached and 404s.
//
// PROVENANCE (nothing here is invented):
//   - Tickers were verified against EDGAR's own company_tickers.json on
//     2026-08-22; every one resolved to a CIK.
//   - Manager CIKs were resolved through the same resolveManager() the paid
//     fund report uses (EDGAR full-text search over 13F-HR) and each was
//     confirmed to have a 13F-HR filing with a report period in 2026 - a
//     manager whose newest 13F was years old (a superseded or deregistered
//     filer entity) was dropped rather than shipped as a dead page.
// Names here are display labels for the hub listings only; every entity page
// prefers the name EDGAR returns live.

/** US issuers with Form 4 / 10-K activity. Ticker only - the company name,
 *  CIK and industry all come from EDGAR at render time. */
export const SEED_TICKERS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "BRK-B", "JPM", "V",
  "MA", "UNH", "XOM", "JNJ", "WMT", "PG", "HD", "CVX", "ABBV", "MRK",
  "KO", "PEP", "COST", "AVGO", "ADBE", "CRM", "NFLX", "AMD", "INTC", "CSCO",
  "ORCL", "QCOM", "TXN", "IBM", "NKE", "MCD", "DIS", "BA", "CAT", "GE",
  "GS", "MS", "BAC", "WFC", "C", "AXP", "PYPL", "SBUX", "LMT", "RTX",
  "HON", "UPS", "FDX", "T", "VZ", "TMUS", "CMCSA", "PFE", "LLY", "BMY",
  "AMGN", "GILD", "CVS", "TGT", "LOW", "MMM", "DE", "UBER", "ABNB", "COIN",
  "HOOD", "PLTR", "SNOW", "CRWD", "DDOG", "NET", "RBLX", "SOFI", "F", "GM",
  "DAL", "LUV", "MAR", "CCL", "DASH", "LYFT", "PINS", "SNAP", "EBAY", "PANW",
  "NOW", "INTU", "SPGI", "SCHW", "MET", "PRU", "AIG", "ADP", "MDLZ", "CMG",
];

/** Institutional 13F filers. `cik` lets the page skip the (expensive) name
 *  resolution step; `name` is the hub-listing label. */
export const SEED_MANAGERS = [
  { slug: "berkshire-hathaway", name: "Berkshire Hathaway", cik: "0001067983" },
  { slug: "bridgewater-associates", name: "Bridgewater Associates", cik: "0001350694" },
  { slug: "renaissance-technologies", name: "Renaissance Technologies", cik: "0001037389" },
  { slug: "citadel-advisors", name: "Citadel Advisors", cik: "0001423053" },
  { slug: "two-sigma-investments", name: "Two Sigma Investments", cik: "0001179392" },
  { slug: "millennium-management", name: "Millennium Management", cik: "0001273087" },
  { slug: "pershing-square-capital-management", name: "Pershing Square Capital Management", cik: "0001336528" },
  { slug: "tiger-global-management", name: "Tiger Global Management", cik: "0001167483" },
  { slug: "baupost-group", name: "Baupost Group", cik: "0001061768" },
  { slug: "appaloosa", name: "Appaloosa", cik: "0001656456" },
  { slug: "third-point", name: "Third Point", cik: "0001040273" },
  { slug: "valueact-holdings", name: "ValueAct Holdings", cik: "0001418814" },
  { slug: "elliott-investment-management", name: "Elliott Investment Management", cik: "0001791786" },
  { slug: "lone-pine-capital", name: "Lone Pine Capital", cik: "0001061165" },
  { slug: "coatue-management", name: "Coatue Management", cik: "0001135730" },
  { slug: "viking-global-investors", name: "Viking Global Investors", cik: "0001103804" },
  { slug: "d-e-shaw", name: "D. E. Shaw", cik: "0001009207" },
  { slug: "aqr-capital-management", name: "AQR Capital Management", cik: "0001167557" },
  { slug: "point72-asset-management", name: "Point72 Asset Management", cik: "0001603466" },
  { slug: "soros-fund-management", name: "Soros Fund Management", cik: "0001029160" },
  { slug: "duquesne-family-office", name: "Duquesne Family Office", cik: "0001536411" },
  { slug: "ark-investment-management", name: "ARK Investment Management", cik: "0001697748" },
  { slug: "himalaya-capital-management", name: "Himalaya Capital Management", cik: "0001709323" },
  { slug: "polen-capital-management", name: "Polen Capital Management", cik: "0001034524" },
  { slug: "akre-capital-management", name: "Akre Capital Management", cik: "0001112520" },
  { slug: "state-street", name: "State Street", cik: "0000093751" },
  { slug: "fmr-llc", name: "FMR LLC (Fidelity)", cik: "0000315066" },
  { slug: "wellington-management", name: "Wellington Management", cik: "0000902219" },
  { slug: "geode-capital-management", name: "Geode Capital Management", cik: "0001214717" },
  { slug: "northern-trust", name: "Northern Trust", cik: "0000073124" },
  { slug: "invesco", name: "Invesco", cik: "0000914208" },
  { slug: "morgan-stanley", name: "Morgan Stanley", cik: "0000895421" },
  { slug: "norges-bank", name: "Norges Bank", cik: "0001374170" },
  { slug: "jane-street-group", name: "Jane Street Group", cik: "0001595888" },
  { slug: "susquehanna-international-group", name: "Susquehanna International Group", cik: "0001446194" },
  { slug: "marshall-wace", name: "Marshall Wace", cik: "0001318757" },
  { slug: "baillie-gifford", name: "Baillie Gifford", cik: "0001088875" },
  { slug: "dodge-cox", name: "Dodge & Cox", cik: "0000200217" },
  { slug: "first-eagle-investment-management", name: "First Eagle Investment Management", cik: "0001325447" },
  { slug: "harris-associates", name: "Harris Associates", cik: "0000813917" },
  { slug: "southeastern-asset-management", name: "Southeastern Asset Management", cik: "0000807985" },
  { slug: "maverick-capital", name: "Maverick Capital", cik: "0000934639" },
  { slug: "farallon-capital-management", name: "Farallon Capital Management", cik: "0000909661" },
  { slug: "starboard-value", name: "Starboard Value", cik: "0001517137" },
  { slug: "trian-fund-management", name: "Trian Fund Management", cik: "0001345471" },
  { slug: "glenview-capital-management", name: "Glenview Capital Management", cik: "0001138995" },
  { slug: "abrams-capital-management", name: "Abrams Capital Management", cik: "0001358706" },
  { slug: "whale-rock-capital-management", name: "Whale Rock Capital Management", cik: "0001387322" },
  { slug: "altimeter-capital-management", name: "Altimeter Capital Management", cik: "0001541617" },
  { slug: "eminence-capital", name: "Eminence Capital", cik: "0001107310" },
];

const MANAGER_BY_SLUG = new Map(SEED_MANAGERS.map((m) => [m.slug, m]));
const TICKER_SET = new Set(SEED_TICKERS);

export const seededManager = (slug) => MANAGER_BY_SLUG.get(String(slug || "")) || null;
export const isSeededTicker = (ticker) => TICKER_SET.has(String(ticker || "").toUpperCase());

/** Every URL these seeds advertise. The sitemap and the hub pages read this -
 *  nothing else generates programmatic URLs. */
export function seededProgrammaticPaths() {
  const paths = ["/reports/insider", "/reports/fund", "/reports/dossier"];
  for (const t of SEED_TICKERS) paths.push(`/reports/insider/${t}`, `/reports/dossier/${t}`);
  for (const m of SEED_MANAGERS) paths.push(`/reports/fund/${m.slug}`);
  return paths;
}
