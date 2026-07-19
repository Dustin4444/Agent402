// F04 validating + pinning egress proxy. Chromium is launched through this
// proxy so it can't resolve/connect to a private, metadata, or
// *.railway.internal destination even under DNS rebinding — the proxy is the
// single resolver + connector and pins the validated IP. Offline: unit-tests the
// resolve/validate decision on IP literals (no DNS) and functionally proves the
// proxy REFUSES a CONNECT to a private/metadata target.
//
//   node scripts/test-egress-proxy.js
import net from "node:net";
import { resolvePinned, startEgressProxy } from "../worker/egress-proxy.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const blocked = async (host) => { try { await resolvePinned(host); return false; } catch { return true; } };

// --- 1. resolvePinned: IP-literal decisions (no DNS) --------------------------
{
  const pub = await resolvePinned("8.8.8.8");
  ok(pub.address === "8.8.8.8" && pub.family === 4, "a public IPv4 literal is allowed and pinned");
  ok(await blocked("127.0.0.1"), "loopback 127.0.0.1 is blocked");
  ok(await blocked("10.0.0.1"), "RFC1918 10.0.0.1 is blocked");
  ok(await blocked("192.168.1.1"), "RFC1918 192.168.1.1 is blocked");
  ok(await blocked("169.254.169.254"), "cloud metadata 169.254.169.254 is blocked");
  ok(await blocked("100.64.0.1"), "CGNAT 100.64.0.1 is blocked");
  ok(await blocked("::1"), "IPv6 loopback ::1 is blocked");
  ok(await blocked("fd00::1"), "IPv6 ULA fd00::1 (the *.railway.internal class) is blocked");
  ok(await blocked("fe80::1"), "IPv6 link-local fe80::1 is blocked");
}

// --- 2. Functional: the proxy refuses a CONNECT to a private/metadata target --
{
  const proxy = await startEgressProxy();
  const connectResult = (target) => new Promise((resolve) => {
    const s = net.connect(proxy.port, "127.0.0.1", () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n") || buf.length > 200) { resolve(buf.split("\r\n")[0]); s.destroy(); } });
    s.on("error", () => resolve("ERROR"));
    setTimeout(() => { resolve(buf.split("\r\n")[0] || "TIMEOUT"); try { s.destroy(); } catch { /* */ } }, 4000);
  });

  ok(/403/.test(await connectResult("127.0.0.1:80")), "CONNECT to loopback is refused (403)");
  ok(/403/.test(await connectResult("10.0.0.1:5432")), "CONNECT to an RFC1918 host (e.g. an internal DB) is refused (403)");
  ok(/403/.test(await connectResult("169.254.169.254:80")), "CONNECT to the metadata endpoint is refused (403)");
  await proxy.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
