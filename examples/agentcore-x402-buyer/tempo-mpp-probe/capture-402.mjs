// Local 402 replay server: serves agent402.tools' LIVE tempo challenges,
// captures the Authorization: Payment credential the AgentCore plugin mints,
// writes it to disk, answers 200. No relay call, nothing spent.
import http from "node:http";
import { writeFileSync } from "node:fs";

const OUT = process.env.OUT || "/tmp/captured-credential.txt";
const live = await fetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "hello world", algo: "sha256" }),
});
const wa = live.headers.get("www-authenticate");
if (live.status !== 402 || !wa) { console.error("no live 402?", live.status); process.exit(1); }
// keep only the tempo challenges
const parts = wa.split(/,\s*(?=Payment )/).length > 1 ? wa.split(/,\s*(?=Payment )/) : [wa];
console.log("live 402 captured,", wa.length, "bytes of challenges");

const srv = http.createServer((req, res) => {
  const auth = req.headers["authorization"];
  if (!auth) {
    res.writeHead(402, { "WWW-Authenticate": wa, "content-type": "application/json" });
    res.end("{}");
    console.log("served 402 with live challenges");
    return;
  }
  writeFileSync(OUT, auth);
  console.log("CAPTURED credential ->", OUT, `(${auth.length} bytes)`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hex: "captured-run-no-real-answer" }));
  setTimeout(() => srv.close(), 500);
});
srv.listen(4402, () => console.log("listening on http://localhost:4402"));
