// Given the MCP Registry's `GET /v0/servers?search=...` response on stdin,
// prints the version currently marked isLatest (nothing if none found or the
// input doesn't parse). Used by the publish job in deploy.yml: right before
// publishing a new version, it captures the version that's ABOUT to become
// stale, so it can be deprecated immediately after the new one goes live -
// otherwise every publish leaves its predecessor "active" forever, which is
// exactly how 24 of 25 published versions ended up non-deprecated (found
// 2026-08-16, first noticed via a growth/revenue audit).
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const row = (data.servers || []).find(
      (s) => s?._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest === true
    );
    if (row?.server?.version) process.stdout.write(String(row.server.version));
  } catch {
    // Any parse/shape surprise -> empty output. The caller (deploy.yml) treats
    // a blank result as "nothing to deprecate" and moves on - a registry
    // hiccup here must never fail the publish job over a best-effort cleanup.
  }
});
