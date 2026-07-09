# B20 Fast-Follow Tools (b20-new-tokens + b20-memos) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two log-scanning B20 tools — recently deployed B20 tokens (factory `B20Created` scan) and payment-memo reads (`Transfer`+`Memo` pairing) — to `src/tools/b20-kit.js`.

**Architecture:** Both tools reuse the kit's existing `rpc()` ladder (Alchemy-first, then public Base RPCs) with a new chunked `eth_getLogs` helper. Event *decoding* avoids the unpublished indexed-layout problem: token addresses are located by their `0xb200` prefix and enriched via existing `readToken()` eth_calls; memos are extracted as the log's final 32-byte word from either data or topics. Spec: `docs/superpowers/specs/2026-07-09-b20-fast-follow-tools-design.md`.

**Tech Stack:** Node ESM, `js-sha3` keccak256 (already a dep), raw JSON-RPC via the kit's `rpc()`. No new dependencies.

## Global Constraints

- Both new slugs are egress tools → MUST be added to `WALLET_ONLY_SLUGS` in `src/pow.js` (hard project rule).
- Prices: both `$0.005`. Category `payments`.
- `blocks` input: default `50000`, max `200000`, min `1`. Chunk size `9000` blocks per `eth_getLogs`.
- `b20-new-tokens` `limit`: default 25, max 100. `b20-memos` `limit`: default 50, max 200.
- `b20-memos` `token` must match `^0xb200[0-9a-f]{36}$` (after lowercasing) → 400 otherwise.
- Discovery examples must answer in CI with no special env (`blocks: 1000`; empty results are valid).
- Both routes go into test-all's lenient `NETWORK` set.
- Commit messages: plain text, no CI-marker substrings until the final ship commit; no AI attribution, no session links.
- After adding tools: run `node scripts/sync-count.js` (1,418 → 1,418).
- Addresses: EVM-only here, lowercase normalization is safe (kit convention).

---

### Task 1: Decode helpers + offline unit tests

**Files:**
- Modify: `src/tools/b20-kit.js` (add helpers + `B20_INTERNALS` export, after the existing `readToken()` around line 137)
- Create: `scripts/test-b20-decode.js`

**Interfaces:**
- Consumes: existing `hexBody(hex)`, `decodeUint(hex)`, `TOKEN_PREFIX` from b20-kit.js module scope; `keccak256` already imported.
- Produces (used by Tasks 2–3): module-scope constants `TOPIC_B20_CREATED`, `TOPIC_TRANSFER`, `TOPIC_MEMO`; functions `findB20Address(log) -> string|null`, `decodeTransfer(log) -> {from,to,value}|null`, `memoWord(log) -> string|null`, `memoText(memoHex) -> string|null`, `logIndexNum(hex) -> number`. Test-only export `B20_INTERNALS` bundling all of these.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-b20-decode.js` (mirrors the `test-util-kit.js` style):

```js
// Offline unit tests for the b20-kit log-decoding helpers. Synthetic logs in
// BOTH plausible indexed layouts (the official B20 ABI's indexed-ness is
// unpublished) — no network.
import { B20_INTERNALS } from "../src/tools/b20-kit.js";

const { TOPIC_TRANSFER, TOPIC_MEMO, TOPIC_B20_CREATED, findB20Address, decodeTransfer, memoWord, memoText, logIndexNum } = B20_INTERNALS;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const pad = (hex) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const B20_ADDR = "0xb200000000000000000000000000000000000abc";
const EOA = "0x1111111111111111111111111111111111111111";
const EOA2 = "0x2222222222222222222222222222222222222222";

// topic constants are 32-byte hashes
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_TRANSFER), "TOPIC_TRANSFER is a 32-byte hash");
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_MEMO), "TOPIC_MEMO is a 32-byte hash");
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_B20_CREATED), "TOPIC_B20_CREATED is a 32-byte hash");
ok(TOPIC_TRANSFER === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "TOPIC_TRANSFER matches the canonical ERC-20 Transfer topic");

// findB20Address: layout A — token address indexed (topic 1)
ok(findB20Address({ topics: [TOPIC_B20_CREATED, pad(B20_ADDR)], data: "0x" }) === B20_ADDR,
  "findB20Address finds an indexed 0xb200 address");
// layout B — token address in data, after another word
ok(findB20Address({ topics: [TOPIC_B20_CREATED], data: "0x" + pad(EOA).slice(2) + pad(B20_ADDR).slice(2) }) === B20_ADDR,
  "findB20Address finds a data-word 0xb200 address (skipping non-B20 words)");
// no B20 address anywhere -> null
ok(findB20Address({ topics: [TOPIC_B20_CREATED, pad(EOA)], data: "0x" }) === null,
  "findB20Address returns null when no 0xb200 word exists");
// word that merely CONTAINS b200 mid-string but is not address-shaped -> null
ok(findB20Address({ topics: [TOPIC_B20_CREATED], data: pad("0xffb200000000000000000000000000000000000abc") }) === null,
  "findB20Address ignores non-address-shaped words");

// decodeTransfer: canonical (from/to indexed, value in data)
let t = decodeTransfer({ topics: [TOPIC_TRANSFER, pad(EOA), pad(EOA2)], data: pad("0x64") });
ok(t && t.from === EOA && t.to === EOA2 && t.value === "100", "decodeTransfer canonical layout");
// non-indexed fallback (all three in data)
t = decodeTransfer({ topics: [TOPIC_TRANSFER], data: "0x" + pad(EOA).slice(2) + pad(EOA2).slice(2) + pad("0x64").slice(2) });
ok(t && t.from === EOA && t.to === EOA2 && t.value === "100", "decodeTransfer non-indexed fallback");
ok(decodeTransfer({ topics: [TOPIC_TRANSFER], data: "0x" }) === null, "decodeTransfer returns null on undecodable log");

// memoWord: layout A — memo in data
const MEMO_HEX = "0x" + Buffer.from("invoice-42").toString("hex").padEnd(64, "0");
ok(memoWord({ topics: [TOPIC_MEMO, pad(EOA)], data: MEMO_HEX }) === MEMO_HEX, "memoWord takes the data word when present");
// layout B — memo indexed (last topic), empty data
ok(memoWord({ topics: [TOPIC_MEMO, pad(EOA), MEMO_HEX], data: "0x" }) === MEMO_HEX, "memoWord falls back to the last topic");
ok(memoWord({ topics: [TOPIC_MEMO], data: "0x" }) === null, "memoWord returns null when no candidate word");

// memoText: printable, binary, all-zero
ok(memoText(MEMO_HEX) === "invoice-42", "memoText decodes printable UTF-8 and trims NUL padding");
ok(memoText("0x" + "00".repeat(32)) === null, "memoText returns null for all-zero memo");
ok(memoText("0x" + "fe".repeat(32)) === null, "memoText returns null for non-UTF-8 bytes");

// logIndexNum
ok(logIndexNum("0x1f") === 31, "logIndexNum parses hex quantities");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-b20-decode.js`
Expected: FAIL — `SyntaxError`/import error: `B20_INTERNALS` is not exported.

- [ ] **Step 3: Write the helpers**

In `src/tools/b20-kit.js`, insert after the `readToken()` function (currently ends line 137) and before `export const B20_TOOLS`:

```js
// --- log-scanning helpers (b20-new-tokens, b20-memos) ------------------------
// CDP published B20 event SIGNATURES but not indexed layouts, so decoding is
// defensive: topic0 filters are layout-independent; fields are located by
// shape (0xb200 prefix; final bytes32 word) rather than assumed position.
const topicOf = (signature) => "0x" + keccak256(signature);
const TOPIC_B20_CREATED = topicOf("B20Created(address,uint8,string,string,uint8,bytes)");
const TOPIC_TRANSFER = topicOf("Transfer(address,address,uint256)");
const TOPIC_MEMO = topicOf("Memo(address,bytes32)");

const logIndexNum = (h) => Number(BigInt(h));

// 32-byte words of a log: indexed topics (minus topic0) then data words.
function logWords(log) {
  const topicWords = (log.topics || []).slice(1).map(hexBody);
  const dataWords = hexBody(log.data).match(/.{64}/g) || [];
  return [...topicWords, ...dataWords];
}

// Locate the new token's address in a B20Created log by its 0xb200 prefix.
// Address-shaped = 12 zero bytes then 20 bytes; the prefix makes it unambiguous.
function findB20Address(log) {
  for (const w of logWords(log)) {
    if (w.length !== 64 || !w.startsWith("0".repeat(24))) continue;
    const addr = "0x" + w.slice(24);
    if (addr.startsWith(TOKEN_PREFIX)) return addr;
  }
  return null;
}

// Canonical ERC-20 Transfer (from/to indexed) with a non-indexed fallback.
function decodeTransfer(log) {
  const t = log.topics || [];
  if (t.length >= 3) {
    const value = decodeUint(log.data);
    if (value == null) return null;
    return { from: "0x" + hexBody(t[1]).slice(24), to: "0x" + hexBody(t[2]).slice(24), value };
  }
  const words = hexBody(log.data).match(/.{64}/g) || [];
  if (words.length >= 3) {
    return { from: "0x" + words[0].slice(24), to: "0x" + words[1].slice(24), value: BigInt("0x" + words[2]).toString() };
  }
  return null;
}

// The memo is the event's only bytes32 payload: prefer the (last) data word,
// fall back to the last topic beyond topic0.
function memoWord(log) {
  const dataWords = hexBody(log.data).match(/.{64}/g) || [];
  if (dataWords.length) return "0x" + dataWords[dataWords.length - 1];
  const t = log.topics || [];
  if (t.length > 1) return "0x" + hexBody(t[t.length - 1]);
  return null;
}

// Best-effort UTF-8: trim NUL padding, require printable, reject replacement chars.
function memoText(hex) {
  try {
    const buf = Buffer.from(hexBody(hex), "hex");
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--;
    if (end === 0) return null;
    const s = buf.subarray(0, end).toString("utf8");
    if (s.includes("�") || /[\x00-\x1f\x7f]/.test(s)) return null;
    return s;
  } catch { return null; }
}

// Test-only export: offline unit tests exercise the decode layer directly.
export const B20_INTERNALS = { TOPIC_B20_CREATED, TOPIC_TRANSFER, TOPIC_MEMO, findB20Address, decodeTransfer, memoWord, memoText, logIndexNum, logWords };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-b20-decode.js`
Expected: PASS — `18 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools/b20-kit.js scripts/test-b20-decode.js
git commit -m "B20 kit: defensive log-decoding helpers with offline unit tests"
```

---

### Task 2: b20-new-tokens tool

**Files:**
- Modify: `src/tools/b20-kit.js` (chunked getLogs helper + new tool object appended to `B20_TOOLS`)
- Modify: `src/pow.js:84` (add slug)
- Modify: `scripts/test-all.js` `NETWORK` set (~line 24 block)

**Interfaces:**
- Consumes: Task 1's `TOPIC_B20_CREATED`, `findB20Address`, `logIndexNum`; existing `rpc()`, `readToken()`, `FACTORY`, `bad()`.
- Produces: `getLogsChunked({address, topics, fromBlock, toBlock}) -> log[]` and `latestBlock() -> number` (Task 3 reuses both); route `GET /api/b20-new-tokens`.

- [ ] **Step 1: Add the shared scan helpers**

In `src/tools/b20-kit.js`, directly under the Task 1 helper block:

```js
async function latestBlock() {
  return Number(BigInt(await rpc("eth_blockNumber", [])));
}

// Chunked eth_getLogs, newest chunk first (<=9k blocks per call: inside
// Alchemy's range cap, small enough for public RPCs). Stops early at maxLogs.
async function getLogsChunked({ address, topics, fromBlock, toBlock, maxLogs = 2000 }) {
  const CHUNK = 9000;
  const out = [];
  for (let hi = toBlock; hi >= fromBlock && out.length < maxLogs; hi -= CHUNK) {
    const lo = Math.max(fromBlock, hi - CHUNK + 1);
    const logs = await rpc("eth_getLogs", [{ address, topics, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) }]);
    if (Array.isArray(logs)) out.push(...logs);
  }
  return out;
}

function windowInput(i, { defBlocks = 50000, maxBlocks = 200000 } = {}) {
  const blocks = Math.floor(Number(i.blocks ?? defBlocks));
  if (!Number.isFinite(blocks) || blocks < 1 || blocks > maxBlocks) throw bad(`blocks must be 1..${maxBlocks}`);
  return blocks;
}
```

- [ ] **Step 2: Append the tool object**

Append to the `B20_TOOLS` array (after the `b20-feature-id` entry):

```js
  {
    route: "GET /api/b20-new-tokens", name: "New B20 tokens", slug: "b20-new-tokens", category: "payments", price: "$0.005",
    description:
      "Recently deployed B20 tokens on Base: scans the factory's B20Created logs over a block window, locates each new token by its 0xB200 address prefix, and enriches it with live name/symbol/decimals eth_calls. ?blocks=50000&limit=25",
    tags: ["b20", "base", "factory", "logs", "discovery", "token-standard"],
    discovery: {
      input: { blocks: 1000 },
      inputSchema: { properties: {
        blocks: { type: "number", description: "lookback window in blocks (default 50000 ≈ 28h, max 200000)" },
        limit: { type: "number", description: "max tokens returned, newest first (default 25, max 100)" },
      } },
      output: { example: { fromBlock: 1, toBlock: 2, count: 0, skipped: 0, tokens: [] } },
    },
    handler: async (i) => {
      const blocks = windowInput(i);
      const limit = Math.min(Math.max(Math.floor(Number(i.limit ?? 25)) || 25, 1), 100);
      const toBlock = await latestBlock();
      const fromBlock = Math.max(0, toBlock - blocks + 1);
      const logs = await getLogsChunked({ address: FACTORY, topics: [TOPIC_B20_CREATED], fromBlock, toBlock });
      logs.sort((a, b) => logIndexNum(b.blockNumber) - logIndexNum(a.blockNumber));
      const seen = new Set();
      let skipped = 0;
      const found = [];
      for (const log of logs) {
        const address = findB20Address(log);
        if (!address) { skipped++; continue; }
        if (seen.has(address)) continue;
        seen.add(address);
        found.push({ address, txHash: log.transactionHash, blockNumber: logIndexNum(log.blockNumber) });
        if (found.length >= limit) break;
      }
      const tokens = await Promise.all(found.map(async (f) => {
        const t = await readToken(f.address).catch(() => null);
        return { ...f, name: t?.name ?? null, symbol: t?.symbol ?? null, decimals: t?.decimals ?? null };
      }));
      return { network: "base", factory: FACTORY, fromBlock, toBlock, count: tokens.length, skipped, tokens };
    },
  },
```

- [ ] **Step 3: Gate the slug**

`src/pow.js` line 84 — extend the B20 line:

```js
  "b20-activation-check", "b20-token-info", "b20-verify", "b20-new-tokens", "b20-memos",
```

(Both new slugs at once — Task 3's slug included now so this file is touched once.)

`scripts/test-all.js` — inside the `NETWORK` set, after the weather-kit block, add:

```js
  // B20 log scans: chunked eth_getLogs against public Base RPCs — flappy in CI.
  "/api/b20-new-tokens", "/api/b20-memos",
```

- [ ] **Step 4: Verify against the live route**

```bash
FREE_MODE=true PORT=3111 node src/server.js &
sleep 3
curl -s "http://localhost:3111/api/b20-new-tokens?blocks=1000&limit=5"
kill %1
```

Expected: JSON with `network:"base"`, numeric `fromBlock`/`toBlock` (recent Base mainnet heights), `tokens` array (likely empty today — valid). A 502 is acceptable only if all public RPCs are down; rerun.

- [ ] **Step 5: Commit**

```bash
git add src/tools/b20-kit.js src/pow.js scripts/test-all.js
git commit -m "B20 kit: b20-new-tokens — factory B20Created scan with 0xB200 self-validation"
```

---

### Task 3: b20-memos tool

**Files:**
- Modify: `src/tools/b20-kit.js` (one tool object appended to `B20_TOOLS`)

**Interfaces:**
- Consumes: Task 1's `TOPIC_TRANSFER`, `TOPIC_MEMO`, `decodeTransfer`, `memoWord`, `memoText`, `logIndexNum`; Task 2's `getLogsChunked`, `latestBlock`, `windowInput`; existing `rpc()`, `bad()`.
- Produces: route `GET /api/b20-memos`.

- [ ] **Step 1: Append the tool object**

Append to `B20_TOOLS` after the Task 2 entry:

```js
  {
    route: "GET /api/b20-memos", name: "B20 payment memos", slug: "b20-memos", category: "payments", price: "$0.005",
    description:
      "Payment memos attached to B20 transfers: pairs each Memo(address,bytes32) log with its Transfer at the previous log index (same tx, same token). Give a tx hash for one transaction, or scan a block window. Returns memoHex always and memoText when printable UTF-8. ?token=0xb200…&tx=0x…|&blocks=50000&address=0x…&limit=50",
    tags: ["b20", "base", "memo", "payments", "logs", "transfer"],
    discovery: {
      input: { token: "0xb200000000000000000000000000000000000001", blocks: 1000 },
      inputSchema: { properties: {
        token: { type: "string", description: "B20 token address (must carry the 0xb200 prefix)" },
        tx: { type: "string", description: "optional: decode memos in this transaction only" },
        address: { type: "string", description: "optional: only transfers where from or to equals this address" },
        blocks: { type: "number", description: "window-scan lookback (default 50000, max 200000; ignored when tx is given)" },
        limit: { type: "number", description: "max memo rows (default 50, max 200)" },
      }, required: ["token"] },
      output: { example: { token: "0xb200…0001", mode: "window", count: 0, memos: [] } },
    },
    handler: async (i) => {
      const token = String(i.token || "").trim().toLowerCase();
      if (!/^0xb200[0-9a-f]{36}$/.test(token)) throw bad("token must be a 0xb200-prefixed B20 token address");
      const limit = Math.min(Math.max(Math.floor(Number(i.limit ?? 50)) || 50, 1), 200);
      const filter = i.address ? normAddress(i.address) : null;

      let logs, mode, window = {};
      if (i.tx) {
        mode = "tx";
        const tx = String(i.tx).trim().toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(tx)) throw bad("tx must be a 0x-prefixed 32-byte transaction hash");
        const receipt = await rpc("eth_getTransactionReceipt", [tx]);
        if (!receipt) throw bad("transaction not found on Base", 404);
        logs = (receipt.logs || []).filter((l) => String(l.address).toLowerCase() === token);
      } else {
        mode = "window";
        const blocks = windowInput(i);
        const toBlock = await latestBlock();
        const fromBlock = Math.max(0, toBlock - blocks + 1);
        window = { fromBlock, toBlock };
        logs = await getLogsChunked({ address: token, topics: [[TOPIC_TRANSFER, TOPIC_MEMO]], fromBlock, toBlock });
      }

      // Index Transfer logs by (txHash, logIndex); each Memo pairs with the
      // Transfer at logIndex - 1 in the same tx (CDP-documented adjacency).
      const transfers = new Map();
      for (const l of logs) {
        if ((l.topics || [])[0] === TOPIC_TRANSFER) transfers.set(`${l.transactionHash}:${logIndexNum(l.logIndex)}`, l);
      }
      const memos = [];
      for (const l of logs) {
        if ((l.topics || [])[0] !== TOPIC_MEMO) continue;
        const t = transfers.get(`${l.transactionHash}:${logIndexNum(l.logIndex) - 1}`);
        if (!t) continue;
        const d = decodeTransfer(t);
        if (!d) continue;
        if (filter && d.from !== filter && d.to !== filter) continue;
        const hex = memoWord(l);
        if (!hex) continue;
        memos.push({ txHash: l.transactionHash, blockNumber: logIndexNum(l.blockNumber), from: d.from, to: d.to, amount: d.value, memoHex: hex, memoText: memoText(hex) });
      }
      memos.sort((a, b) => b.blockNumber - a.blockNumber);
      return { network: "base", token, mode, ...window, count: Math.min(memos.length, limit), memos: memos.slice(0, limit) };
    },
  },
```

Note `topics: [[TOPIC_TRANSFER, TOPIC_MEMO]]` — a nested array is JSON-RPC's OR filter for topic0 (one scan fetches both event types).

- [ ] **Step 2: Verify against the live route**

```bash
FREE_MODE=true PORT=3111 node src/server.js &
sleep 3
curl -s "http://localhost:3111/api/b20-memos?token=0xb200000000000000000000000000000000000001&blocks=1000"
curl -s "http://localhost:3111/api/b20-memos?token=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"   # bad prefix
kill %1
```

Expected: first returns `{network:"base", mode:"window", count:0, memos:[]}` with a real block window; second returns a 400 error mentioning the 0xb200 prefix.

- [ ] **Step 3: Commit**

```bash
git add src/tools/b20-kit.js
git commit -m "B20 kit: b20-memos — Transfer+Memo adjacency pairing, tx and window modes"
```

---

### Task 4: Counts, CI wiring, full local verification

**Files:**
- Modify: `.github/workflows/deploy.yml` (~line 930, next to the util-kit step)
- Modify: ~60 static count surfaces via `node scripts/sync-count.js` (automated)

- [ ] **Step 1: Wire the offline test into CI**

In `.github/workflows/deploy.yml`, after the Util-kit step (line ~930), add:

```yaml
      - name: B20 decode unit tests (offline, synthetic logs in both indexed layouts)
        run: node scripts/test-b20-decode.js
```

- [ ] **Step 2: Sync the tool count**

```bash
node scripts/sync-count.js
node scripts/sync-count.js --check
```

Expected: rewrites the static surfaces to 1,418; `--check` exits 0.

- [ ] **Step 3: Full local test sweep**

```bash
node scripts/test-b20-decode.js
FREE_MODE=true PORT=3000 node src/server.js &
sleep 3
TARGET_URL=http://localhost:3000 node scripts/test-all.js
kill %1
```

Expected: decode tests pass; test-all reports the two new routes as exercised (lenient/NETWORK), zero strict failures, total tool count 1,418.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "B20 fast-follows: CI decode-test wiring + tool count 1,418 across static surfaces"
```

---

### Task 5: Ship

**Files:**
- Modify: `.github/trigger-test`, `.github/trigger-deploy` (timestamp bumps — the CI gate needs marker AND touched trigger path)

- [ ] **Step 1: Bump triggers and make the marker commit**

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" >> .github/trigger-test
date -u +"%Y-%m-%dT%H:%M:%SZ" >> .github/trigger-deploy
git add .github/trigger-test .github/trigger-deploy
git commit -m "B20 fast-follow tools: b20-new-tokens + b20-memos [test][deploy]"
git push origin claude/sweet-brown-i99jl3
```

- [ ] **Step 2: Open a draft PR, strip the session footer**

```bash
gh pr create --draft --title "B20 fast-follows: b20-new-tokens + b20-memos" --body "Two log-scanning B20 tools per docs/superpowers/specs/2026-07-09-b20-fast-follow-tools-design.md: factory B20Created discovery (0xB200 self-validation + eth_call enrichment) and Transfer+Memo adjacency memo reads. Both wallet-only, \$0.005, chunked getLogs, offline decode tests in both indexed layouts. Tool count 1,418."
```

Then remove any auto-appended session-link footer via `gh pr edit <n> --body "<same body>"` (project rule: no session links).

- [ ] **Step 3: Watch CI, merge on green**

`gh run watch` the deploy workflow; test job must pass before deploy runs (`needs: test`). Merge the PR on green. After deploy: dispatch the paid canary (`gh workflow run paid-canary.yml --ref main`) and register the new routes (Bazaar/marketplace flow per repo convention — `.github/trigger-marketplace` + `[marketplace]`, and `.github/trigger-bazaar-register` bump, in a follow-up commit if not bundled here).

- [ ] **Step 4: Post-deploy verification**

```bash
node -e "fetch('https://agent402.tools/health').then(r=>r.json()).then(j=>console.log(j.meta.toolCount))"   # expect 1416
node -e "fetch('https://agent402.tools/api/find?q=b20+memo').then(r=>r.json()).then(j=>console.log(JSON.stringify(j).slice(0,300)))"
```

Expected: count 1,418; find resolves b20-memos.
