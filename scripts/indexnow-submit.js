// Submit the site's sitemap URLs to IndexNow (api.indexnow.org) — instant
// indexing for the engines that share the index (Bing/Copilot, DuckDuckGo,
// Yahoo, Seznam, Naver). Run after catalog changes, or any time:
//
//   INDEXNOW_KEY=<key> node scripts/indexnow-submit.js [--urls url1,url2,...]
//
// Without --urls it submits every URL in the live sitemap (protocol cap is
// 10,000 per POST; the whole catalog fits in one). The key must match what
// the server exposes at /{key}.txt (INDEXNOW_KEY on Railway) — IndexNow
// verifies ownership by fetching that file. Exit 0 on accepted (200/202),
// 1 otherwise. Best-effort by design: a failed ping never breaks anything,
// the sitemap remains the source of truth.
const BASE = process.env.TARGET_URL || "https://agent402.tools";
const KEY = (process.env.INDEXNOW_KEY || "").trim();

async function main() {
  if (!KEY) {
    console.error("INDEXNOW_KEY is not set — nothing to submit.");
    process.exit(1);
  }
  const host = new URL(BASE).host;

  // Sanity: the key file must be live before engines will accept pings.
  const keyUrl = `${BASE}/${KEY}.txt`;
  const keyRes = await fetch(keyUrl, { signal: AbortSignal.timeout(15000) });
  const keyBody = (await keyRes.text()).trim();
  if (keyRes.status !== 200 || keyBody !== KEY) {
    console.error(`key file check failed: ${keyUrl} → HTTP ${keyRes.status}, body ${keyBody.slice(0, 40)}`);
    process.exit(1);
  }
  console.error(`key file OK: ${keyUrl}`);

  const urlsArg = process.argv.indexOf("--urls");
  let urlList;
  if (urlsArg > -1 && process.argv[urlsArg + 1]) {
    urlList = process.argv[urlsArg + 1].split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const xml = await fetch(`${BASE}/sitemap.xml`, { signal: AbortSignal.timeout(30000) }).then((r) => r.text());
    urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  }
  if (urlList.length > 10000) urlList = urlList.slice(0, 10000);
  console.error(`submitting ${urlList.length} URL(s) for ${host}`);

  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: KEY, keyLocation: keyUrl, urlList }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  console.log(JSON.stringify({ status: res.status, ok: res.status === 200 || res.status === 202, body: body.slice(0, 200), urls: urlList.length }));
  process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
