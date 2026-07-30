// Shared proof-of-work replay stores for the Node gate.
//
// The gate's default single-use record lives in one process's memory. That is
// correct for a single-process deploy and a hole in every other shape: with a
// stable TOLLBOOTH_SECRET (which multi-worker deploys need, so tokens verify at
// all) one solved token is redeemable once per process inside its TTL, and again
// after each worker recycle. These factories give the `replayStore` option a
// backend every process shares.
//
// The contract is the one edge.js already uses, so a store written for the edge
// gate works here unchanged:
//
//   { claim(token, expiresAtMs) => boolean | Promise<boolean> }
//
// `claim` must be ATOMIC: true only the very first time it sees a token, false
// for every later call. A get-then-put pair that is not atomic lets two
// concurrent redemptions of the same token both observe "unseen" and both pass.
// A store that throws makes the gate REFUSE the request (pow.js fails closed),
// so a claim implementation should throw rather than guess when its backend is
// unreachable.
//
// No new runtime dependency: every factory takes an ALREADY-OPEN client the
// operator constructed, so the tollbooth never pulls in a driver of its own.

/**
 * SQLite-backed claim, for the common case of several Node workers on one host
 * (`cluster`, pm2, a container with N processes).
 *
 * Pass an open better-sqlite3 `Database`, or a node:sqlite `DatabaseSync` (Node
 * 22.5+). Both expose the same `exec()` / `prepare().run()` surface this uses.
 *
 *   import Database from "better-sqlite3";
 *   const db = new Database("/var/lib/tollbooth/replay.db");
 *   db.pragma("journal_mode = WAL");           // concurrent writers
 *   db.pragma("busy_timeout = 5000");          // wait for the write lock, do not throw
 *   createTollbooth({ replayStore: sqliteReplayStore(db) });
 *
 * Set busy_timeout. A claim that hits SQLITE_BUSY throws, pow.js fails closed on
 * a throw, and the refusal lands on an honest crawler that did the work. Waiting
 * milliseconds for the write lock is strictly better than that.
 *
 * Atomicity comes from the PRIMARY KEY plus INSERT OR IGNORE: SQLite serializes
 * writers on the database file, so exactly one process observes `changes === 1`
 * for a given token. The scope of that guarantee is the FILE, which means this
 * covers many processes sharing a disk and does NOT cover instances on different
 * hosts (a network filesystem does not make SQLite locking reliable). Use Redis
 * or Postgres across hosts.
 */
export function sqliteReplayStore(db, { table = "tollbooth_pow_replay", pruneEveryMs = 60_000 } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("sqliteReplayStore(db): pass an open better-sqlite3 Database or node:sqlite DatabaseSync");
  }
  // Identifier, not a bindable value, so it is whitelisted rather than escaped.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new TypeError("sqliteReplayStore: table must be a plain identifier");
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (token TEXT PRIMARY KEY, expires_ms INTEGER NOT NULL)`);
  const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (token, expires_ms) VALUES (?, ?)`);
  const prune = db.prepare(`DELETE FROM ${table} WHERE expires_ms < ?`);
  let prunedAt = 0;

  return {
    claim: (token, expiresAtMs) => {
      const now = Date.now();
      // Bounded growth without a background timer: the table only ever needs to
      // hold unexpired tokens, and an expired row can be dropped because pow.js
      // rejects an expired token before it ever claims. Time-gated so a busy
      // gate does not run a DELETE on every request.
      if (now - prunedAt > pruneEveryMs) { prunedAt = now; prune.run(now); }
      const res = insert.run(String(token), Math.floor(Number(expiresAtMs) || now));
      return Number(res.changes) === 1;
    },
  };
}

/**
 * Redis-backed claim, for multiple instances across hosts (and the shape most
 * serverless Node runtimes can reach).
 *
 * Pass an open client. Both major clients are supported because their SET
 * signatures differ:
 *
 *   node-redis v4+:  createClient(...)  -> set(k, v, { NX: true, PX: ttl })
 *   ioredis:         new Redis(...)     -> set(k, v, "PX", ttl, "NX")
 *
 *   createTollbooth({ replayStore: redisReplayStore(redis, { prefix: "tb:pow:" }) });
 *
 * SET NX is atomic server-side across every client, and the PX expiry is the
 * token's own remaining lifetime, so the keyspace self-cleans. `claim` returns a
 * PROMISE, which is why pow.js verify() has to tolerate a thenable.
 *
 * Errors are deliberately NOT caught here: pow.js turns a throw into a refusal.
 * Swallowing a Redis outage and returning true would silently restore the
 * per-process hole this store exists to close.
 */
export function redisReplayStore(client, { prefix = "tollbooth:pow:" } = {}) {
  if (!client || typeof client.set !== "function") {
    throw new TypeError("redisReplayStore(client): pass an open node-redis or ioredis client");
  }
  // defineCommand is ioredis-only, and ioredis is the client that takes the
  // positional SET form. Detect rather than send one shape and hope: the failure
  // mode of guessing wrong is not an exception but a SET without the NX flag,
  // which overwrites the record and grants every replay.
  const isIoredis = typeof client.defineCommand === "function";
  const isNodeRedis = typeof client.sendCommand === "function" || typeof client.sSet === "function" || Boolean(client.options && client.options.socket);
  if (!isIoredis && !isNodeRedis) {
    // Fail CLOSED on an unrecognised client instead of guessing a SET shape.
    // The failure mode of a wrong guess is not an exception: the flag argument
    // is silently ignored, the key is overwritten every time, and single-use
    // stops existing while everything still looks healthy.
    throw new TypeError(
      "redisReplayStore(client): could not identify this client as node-redis or ioredis. " +
      "Pass one of those, or supply your own { claim(token, expiresAtMs) } store - guessing the SET argument shape risks dropping NX and granting every replay."
    );
  }
  // Prove NX is actually being honoured, once, before this store is trusted.
  // Detection above is a heuristic; this is the observation. Two claims of a
  // throwaway key must produce a win and then a refusal. Anything else means
  // single-use is not working, and the store refuses rather than pretending.
  // Tri-state on PURPOSE: null = not yet observed, true = proven, false = proven
  // BROKEN and permanently refused.
  //
  // A verdict of false must keep throwing on EVERY later call, not just the one
  // that discovered it. Memoising false and returning it as a resolved value
  // would make the store refuse exactly once and then grant every replay
  // forever - the precise failure this self-test exists to prevent, reached one
  // request later. A caller that solves one challenge could then replay that
  // token for its whole TTL.
  //
  // A probe that THROWS (Redis unreachable) leaves the verdict at null so the
  // next call re-probes: a transient outage must not be remembered as a verdict.
  let nxProven = null;
  const NX_BROKEN =
    "redisReplayStore: SET NX is not honoured by this client, so proof-of-work single-use cannot be enforced. " +
    "The gate refuses rather than granting replays. Pass a client whose SET supports NX, or supply your own { claim(token, expiresAtMs) } store.";
  const proveNx = async () => {
    if (nxProven === true) return true;
    if (nxProven === false) throw new Error(NX_BROKEN);
    const probe = `${prefix}__nxselftest__${Math.random().toString(36).slice(2)}${Date.now()}`;
    const px = 5000;
    const set = (k) => (isIoredis ? client.set(k, "1", "PX", px, "NX") : client.set(k, "1", { NX: true, PX: px }));
    // Deliberately NOT wrapped: a throw here leaves nxProven null (re-probe).
    const first = await set(probe);
    const second = await set(probe);
    const firstWon = first === "OK" || first === true;
    const secondRefused = !(second === "OK" || second === true);
    nxProven = firstWon && secondRefused;
    if (!nxProven) {
      throw new Error(
        `${NX_BROKEN} (first claim won: ${firstWon}, second refused: ${secondRefused})`
      );
    }
    return true;
  };
  return {
    claim: async (token, expiresAtMs) => {
      // Respect the verdict: proveNx throws when unproven, but assert anyway so
      // no future refactor can turn "unproven" into a silently ignored value.
      if ((await proveNx()) !== true) throw new Error(NX_BROKEN);
      const key = prefix + token;
      // Floor of 1ms: Redis rejects a non-positive PX. pow.js has already
      // refused anything actually expired, so a tiny window here just means the
      // key is evicted almost immediately.
      const px = Math.max(1, Math.floor(Number(expiresAtMs) - Date.now()));
      const res = isIoredis
        ? await client.set(key, "1", "PX", px, "NX")
        : await client.set(key, "1", { NX: true, PX: px });
      // node-redis resolves null when NX declined; ioredis resolves null too,
      // and "OK" on a win. Anything that is not a win is treated as already spent.
      return res === "OK" || res === true;
    },
  };
}
