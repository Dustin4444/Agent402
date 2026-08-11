// Search X (Twitter) from the CLI — read-only ops utility, sibling to tweet.js.
// Deterministic, dependency-free: signs the request with OAuth 1.0a
// (HMAC-SHA1) using Node's built-in crypto and calls GET /2/tweets/search/recent.
// Posts nothing, deletes nothing - pure read.
//
// Same four credentials as tweet.js (X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN
// / X_ACCESS_SECRET, TWITTER_* accepted as fallbacks). Never local - Actions
// secrets only, dispatched via .github/workflows/x-search.yml.
//
// Usage:
//   node scripts/x-search.js --query "x402 stellar facilitator -is:retweet"
//   node scripts/x-search.js --query "..." --max 20
//
// Exit codes: 0 ok, 1 usage/credential error, 2 API error.

import crypto from "node:crypto";

const SEARCH_URL = "https://api.twitter.com/2/tweets/search/recent";

const cred = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return "";
};
const CONSUMER_KEY = cred("X_API_KEY", "TWITTER_API_KEY");
const CONSUMER_SECRET = cred("X_API_SECRET", "TWITTER_API_SECRET");
const ACCESS_TOKEN = cred("X_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN");
const ACCESS_SECRET = cred("X_ACCESS_SECRET", "TWITTER_ACCESS_SECRET");

function parseArgs(argv) {
  const out = { query: null, max: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query" || a === "-q") out.query = argv[++i];
    else if (a === "--max" || a === "-m") out.max = parseInt(argv[++i], 10) || 20;
  }
  return out;
}

// RFC 3986 percent-encoding (encodeURIComponent leaves !*'() — encode them too).
const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Same signing shape as tweet.js's authHeader - for a GET with query params,
// the query params must be part of the signed parameter set (OAuth 1.0a spec),
// so they're passed in here exactly like tweet.js passes body params for POST.
function authHeader(method, url, params = {}) {
  const oauth = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(32).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...params };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const signingKey = `${pct(CONSUMER_SECRET)}&${pct(ACCESS_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

function requireCredentials() {
  let ok = true;
  for (const [name, v] of Object.entries({ X_API_KEY: CONSUMER_KEY, X_API_SECRET: CONSUMER_SECRET, X_ACCESS_TOKEN: ACCESS_TOKEN, X_ACCESS_SECRET: ACCESS_SECRET })) {
    if (!v) { console.error(`${name} is required. Set it in the environment; do not commit it.`); ok = false; }
  }
  if (!ok) process.exit(1);
}

async function main() {
  requireCredentials();
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: node scripts/x-search.js --query "search terms" [--max N]');
    process.exit(1);
  }
  const params = {
    query: args.query,
    max_results: String(Math.min(Math.max(args.max, 10), 100)),
    "tweet.fields": "created_at,author_id,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name",
  };
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const url = `${SEARCH_URL}?${queryString}`;

  const res = await fetch(url, {
    headers: { Authorization: authHeader("GET", SEARCH_URL, params) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`search ${res.status}:`, JSON.stringify(json).slice(0, 1500));
    process.exit(2);
  }

  const users = new Map((json.includes?.users || []).map((u) => [u.id, u]));
  const tweets = json.data || [];
  console.log(`[x-search] query="${args.query}" results=${tweets.length} (meta: ${JSON.stringify(json.meta || {})})`);
  for (const t of tweets) {
    const u = users.get(t.author_id);
    const handle = u ? `@${u.username}` : t.author_id;
    console.log(`\n--- ${handle} (${t.created_at}) ---`);
    console.log(t.text);
  }
  if (!tweets.length) console.log("(no results)");
}

main().catch((e) => {
  console.error("x-search failed:", e?.message || e);
  process.exit(2);
});
