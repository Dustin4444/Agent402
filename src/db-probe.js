// Postgres reachability probe (diagnostic, 2026-08-25). Both Postgres services
// have timed out from the app at every boot ("Connection terminated due to
// connection timeout") while Redis and the render worker on the same private
// mesh answer, and Railway's dashboard shows zero traffic reaching either
// database for a week. A connect timeout says nothing about WHY, so on an
// init failure the DB modules call this: resolve the host, then open a bare
// TCP socket to every address it resolves to, per family, with a short
// deadline, and log host/port/family/outcome. No credentials are read or
// logged - the URL is parsed for host and port only.
import dns from "node:dns/promises";
import net from "node:net";

export async function probeDbHost(label, url) {
  let host, port;
  try { const u = new URL(url); host = u.hostname; port = Number(u.port || 5432); }
  catch { console.warn(`[${label}] probe: URL unparseable`); return; }
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) { console.warn(`[${label}] probe: dns.lookup(${host}) failed: ${e.code || e.message}`); return; }
  if (!addrs.length) { console.warn(`[${label}] probe: ${host} resolved to nothing`); return; }
  const results = await Promise.all(addrs.map(({ address, family }) => new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: address, port, family, autoSelectFamily: false });
    const done = (r) => { try { s.destroy(); } catch { /* closed */ } resolve(`v${family} ${address} -> ${r} (${Date.now() - t0}ms)`); };
    s.setTimeout(3000, () => done("timeout"));
    s.once("connect", () => done("tcp ok"));
    s.once("error", (e) => done(`error ${e.code || e.message}`));
  })));
  console.warn(`[${label}] probe ${host}:${port} - ${results.join("; ")}`);
}
