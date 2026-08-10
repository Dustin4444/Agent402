import { RAILS_PAREN, RAILS_OR } from "./rails.js";
// Remote MCP endpoint (Streamable HTTP) — makes Agent402 an installable
// connector: paste https://agent402.tools/mcp into Claude (Settings >
// Connectors), ChatGPT, or any MCP client that speaks streamable HTTP.
//
// This is the authless free tier. It runs in the same process as the tools and
// lists a FLAGSHIP set (search/answer front door + render/data/STT/memory) plus
// meta discovery tools. Pure-CPU tools still execute free via call_tool /
// find_tool; wallet-only flagships return paid-access setup pointing at the
// npm `agent402-mcp` server with a funded AGENT_KEY. Payment identity can't
// flow through a hosted authless connector, so paid execution stays on the
// stdio package by design.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { findTools, findRelatedSellers, applyFrontDoorTerms } from "./find.js";
import { routableSellerSummaries } from "./x402-index.js";
import { logSafe } from "./log-safe.js";
import { recordWish } from "./wish.js";
import { capturePostHogDiscovery } from "./posthog.js";
import { rankBy as rankLeaderboard } from "./leaderboard.js";
import { SKILL_PACKS, buildPromptMessages, rankSkillPacks } from "./skills.js";
import {
  FLAGSHIP_SLUGS,
  FLAGSHIP_MCP_NAMES,
  FLAGSHIP_OPEN_WORLD,
  FLAGSHIP_WRITERS,
  mcpInstallHints,
  mcpInitializeInstructions,
} from "./mcp-flagship.js";
import {
  createLimiter,
  MAX_CALLS_PER_BURST,
  MAX_CALLS_PER_WINDOW,
} from "./rate-limit.js";

const VERSION = "0.3.0";

// Mirrors server.js's FIND_WEAK_SCORE: an empty result set, or a top score
// below this, reads as "the catalog probably doesn't have this" — the
// trigger for the request_tool hint + a fire-and-forget find-miss wish.
// 3, not 5: a tag or slug-substring match is a SERVED query (see server.js -
// the old 5 recorded a wish for every tag-served query, the minia2a ghost).
const FIND_WEAK_SCORE = 3;
const WISH_HINT_TEXT = "Nothing matched well? Tell us what you needed via POST /api/wish - we cluster demand and build what keeps coming up.";

// Per-IP sliding-window rate limit for tool executions (search/info are free).
// Generous enough for real use of $0.001-grade CPU tools, tight enough that
// the free tier can't be farmed as infrastructure. Limiter implementation +
// policy live in src/rate-limit.js so the direct-HTTP PoW redemption path
// applies the same quota.
const mcpLimiter = createLimiter("mcp");
const rateLimited = (ip) => mcpLimiter.check(ip).limited;

// Outer transport guards (audit R-11). The tool limiter above only fires INSIDE
// call_tool; a flood of initialize/discovery/malformed POSTs would otherwise
// allocate a server + transport per request before any tool limit applies.
// These bound raw POST volume BEFORE server creation:
//   - a per-IP request cap on its OWN bucket, deliberately more generous than
//     the tool limiter so a legit session (one initialize + many tool calls)
//     is never throttled by it;
//   - a global in-flight transport semaphore capping concurrent allocation;
//   - a per-request deadline so a stalled request can't pin a transport.
// All env-tunable; defaults are generous for real clients, tight against floods.
const MCP_REQ_PER_MIN = Number(process.env.AGENT402_MCP_REQ_PER_MIN) || Math.max(60, MAX_CALLS_PER_BURST * 3);
const MCP_REQ_PER_HOUR = Number(process.env.AGENT402_MCP_REQ_PER_HOUR) || Math.max(600, MAX_CALLS_PER_WINDOW * 3);
const mcpReqLimiter = createLimiter("mcp-transport", { perMin: MCP_REQ_PER_MIN, perHour: MCP_REQ_PER_HOUR });
const MCP_MAX_CONCURRENT = Number(process.env.AGENT402_MCP_MAX_CONCURRENT) || 64;
const MCP_REQ_DEADLINE_MS = Number(process.env.AGENT402_MCP_REQ_DEADLINE_MS) || 30_000;
// After the deadline fires (or the client disconnects) we abort + close the
// transport, then wait up to this long for the underlying handler to actually
// terminate before releasing its in-flight slot (audit F14). Bounds a wedged
// handler so it can't hold a slot forever.
const MCP_DRAIN_MS = Number(process.env.AGENT402_MCP_DRAIN_MS) || 5_000;
let mcpInFlight = 0;

/**
 * Mount the MCP endpoint on the express app.
 * `catalog` is the CATALOG map (route -> tool def), `opts.isComputePayable`
 * decides the free set. `opts.onServed(slug, { latencyMs, errored })` feeds
 * both the stats counters and the analytics dashboard with full per-call meta.
 */
export function mountMcp(app, catalog, { baseUrl, isComputePayable, onServed = () => {}, getLeaderboard = null }) {
  // Live per-tool prices for the skill-pack a la carte comparison. Built once
  // from the same catalog this connector serves, so the number an agent sees
  // next to a pack is the price it would actually pay for the steps.
  const packPriceIndex = new Map();
  for (const def of Object.values(catalog)) {
    const n = Number(String(def?.price ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && def?.slug) packPriceIndex.set(String(def.slug).toLowerCase(), n);
  }
  const toolPriceUsd = (slug) => packPriceIndex.get(String(slug).toLowerCase()) ?? null;
  const tools = new Map(); // slug -> { def, free }
  for (const def of Object.values(catalog)) {
    tools.set(def.slug, { def, free: isComputePayable(def) });
  }
  const freeCount = [...tools.values()].filter((t) => t.free).length;
  const freeSlugs = new Set([...tools.entries()].filter(([, t]) => t.free).map(([slug]) => slug));
  const mcpClients = new Map(); // "name@version" -> initialize count since boot

  // Flagship first-class tools: demand SKUs agents should see without a
  // find_tool round-trip (search/answer front door + render/data/STT/memory).
  // Most are wallet-only on this authless connector — calling one returns
  // paid-access setup (same as call_tool on a wallet slug). The long catalog
  // stays behind search_tools / find_tool / call_tool. Total tools/list size
  // stays in Glama's ~3–15 well-scoped band: meta tools + these flagships.
  // Keep FLAGSHIP_SLUGS in sync with mcp/index.js DEFAULT_CURATED.
  const flagshipSet = new Set();
  for (const slug of FLAGSHIP_SLUGS) {
    if (tools.has(slug)) flagshipSet.add(slug);
  }

  const schemaOf = (def) => {
    const s = def.discovery?.inputSchema;
    return s ? { type: "object", ...s } : { type: "object" };
  };

  // MCP tool names are exposed in snake_case so the whole tools/list is one
  // consistent convention (the meta-tools are already snake_case; catalog
  // slugs are kebab). CallTool accepts either form, so no caller breaks.
  const toSnake = (slug) => String(slug).replace(/-/g, "_");
  // verb_noun for flagships (Glama naming-consistency). Meta tools are already
  // verb-first (search_tools / find_tool / call_tool).
  const mcpNameOf = (slug) => FLAGSHIP_MCP_NAMES[slug] || toSnake(slug);
  // Prior free-utility MCP names still route so older clients do not hard-break
  // after the flagship swap (they are no longer listed in tools/list).
  const LEGACY_MCP_ALIASES = {
    generate_hash: "hash", convert_units: "unit-convert", generate_qr: "qr",
    format_json: "json-format", decode_jwt: "jwt-decode", convert_base64: "base64",
    generate_uuid: "uuid", parse_csv: "csv-to-json", convert_timezone: "timezone-convert",
    get_wallet_balances: "wallet-balances", get_wallet_transactions: "wallet-transactions",
    base64_convert: "base64", qr_generate: "qr", uuid_generate: "uuid", hash_generate: "hash",
  };
  // Every accepted spelling of a first-class tool name -> its catalog slug
  // (exposed verb_noun name, plain snake form, raw kebab slug, prior renames).
  const namedToolSlugs = new Map();
  for (const slug of flagshipSet) {
    namedToolSlugs.set(mcpNameOf(slug), slug);
    namedToolSlugs.set(toSnake(slug), slug);
    namedToolSlugs.set(slug, slug);
  }
  for (const [alias, slug] of Object.entries(LEGACY_MCP_ALIASES)) {
    if (tools.has(slug)) {
      namedToolSlugs.set(alias, slug);
      // Also accept the raw kebab / snake slug so older CallTool clients that
      // still send "base64" / "hash" (not listed anymore) keep working.
      namedToolSlugs.set(slug, slug);
      namedToolSlugs.set(toSnake(slug), slug);
    }
  }
  // A concise "Returns { … }" clause from a tool's documented example so every
  // flagship tool advertises its output shape, not just its input.
  const returnsHint = (def) => {
    const ex = def.discovery?.output?.example;
    if (!ex || typeof ex !== "object") return "";
    const keys = Object.keys(ex).slice(0, 8);
    return keys.length ? ` Returns { ${keys.join(", ")} }.` : "";
  };

  // Returns { rows, topScore } — topScore feeds the "did this actually match
  // anything useful" check for the request_tool hint (see search_tools below).
  function searchTools(query, limit = 10) {
    const q = String(query || "");
    const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    applyFrontDoorTerms(terms, q);
    const scored = [];
    for (const { def, free } of tools.values()) {
      const slug = def.slug.toLowerCase();
      const tagSet = new Set((def.tags || []).map((tg) => String(tg).toLowerCase()));
      const hay = `${def.name} ${def.description} ${def.category} ${(def.tags || []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (slug === term) score += 10;
        if (slug.includes(term)) score += 4;
        if (tagSet.has(term)) score += 3;
        if (hay.includes(term)) score += 1;
      }
      if (score > 0) scored.push([score, def, free]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const rows = scored.slice(0, Math.min(Number(limit) || 10, 25)).map(([, def, free]) => ({
      slug: def.slug,
      price: def.price,
      access: free ? "free here (rate-limited)" : "wallet required (USDC via x402 - use the agent402-mcp npm server)",
      description: def.description.length > 200 ? `${def.description.slice(0, 200)}…` : def.description,
      inputSchema: schemaOf(def),
    }));
    return { rows, topScore: scored[0]?.[0] ?? 0 };
  }

  function walletRequiredText(def) {
    return [
      `"${def.slug}" (${def.price}/call) needs per-call USDC payment and is not part of this hosted free tier.`,
      `To use it from Claude/any MCP client: run the npm server with a funded Base wallet -`,
      `npx agent402-mcp with env AGENT_KEY=0x<private key> (USDC on Base/Polygon/Arbitrum, or USDG on Robinhood Chain via AGENT402_NETWORKS=robinhood) and/or SOLANA_AGENT_KEY=<base58 secret> (USDC on Solana); spend caps: AGENT402_MAX_PER_CALL, AGENT402_BUDGET.`,
      `Or call it over HTTP with any x402 client. Docs: ${baseUrl}/tools/${def.slug}`,
    ].join(" ");
  }

  function buildServer(ip, signal) {
    const server = new Server(
      { name: "agent402", version: VERSION },
      { capabilities: { tools: {}, prompts: {} }, instructions: mcpInitializeInstructions(baseUrl) },
    );

    // Skill packs are exposed as MCP prompts: each pack becomes a discoverable
    // prompt the client can render in a slash menu (Claude Desktop, Cursor,
    // etc.). The pack data lives in src/skills.js — same source of truth as
    // the HTML pages at /skills/<slug>. buildPromptMessages does the args
    // substitution + tool-plan rendering, and gets freeSlugs so it can pre-
    // split free vs wallet-only tools for the caller.
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: SKILL_PACKS.map((p) => ({
        name: p.slug,
        title: p.title,
        description: p.tagline,
        arguments: (p.promptArgs || []).map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required ?? true,
        })),
      })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      const pack = SKILL_PACKS.find((p) => p.slug === name);
      if (!pack) throw new Error(`Unknown prompt "${name}". List available with prompts/list.`);
      return buildPromptMessages(pack, args, { freeSlugs });
    });

    // Titles + safety annotations on every tool are required for listing in
    // Anthropic's connector directory. Meta discovery tools are honestly
    // read-only; flagship egress tools set openWorldHint; memory-write writes.
    const SAFE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const OPEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_tools",
          title: "Search the Agent402 tool catalog",
          annotations: { title: "Search the Agent402 tool catalog", ...SAFE },
          description:
            `BROWSE the long catalog behind the flagship set: keyword search over Agent402's 500+ deterministic pay-per-call tools (exact count ${tools.size}). Start with the listed flagships for search/answer/news/render/data/transcribe/memory; use this when you need a long-tail slug. Counterpart find_tool resolves a task to ONE ready-to-run pick - search explores, find decides. ${freeCount} pure-CPU tools run free here (proof-of-work); the rest need a USDC wallet via npx agent402-mcp. Also an OpenAI-compatible LLM gateway at ${baseUrl}/v1 (flat per-call; wallet = account). Returns { results, workflows }; run one with call_tool.`,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: 'What you need, e.g. "search the web for x402", "answer a question with citations", "decode JWT"' },
              limit: { type: "number", description: "Max results (default 10)" },
            },
            required: ["query"],
          },
        },
        {
          name: "find_tool",
          title: "Resolve a task to the one best Agent402 tool",
          annotations: { title: "Resolve a task to the one best Agent402 tool", ...SAFE },
          description:
            "DECIDE, don't browse: resolve a plain-language task to the single best-matching Agent402 tool, returned call-ready - slug, price, input schema, and a worked example (its counterpart search_tools returns a list of candidates to compare - search explores, find decides). Prefer this for anything outside the flagship list. Returns { task, matches } with the top pick first; then run call_tool with the chosen slug + params.",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string", description: 'What you want to do, e.g. "search the web for x402 adoption" or "convert miles to km"' },
              limit: { type: "number", description: "Max results (default 5)" },
            },
            required: ["task"],
          },
        },
        {
          name: "call_tool",
          title: "Run an Agent402 tool",
          annotations: { title: "Run an Agent402 tool", ...SAFE },
          description:
            `Run an Agent402 tool by slug (discover slugs with find_tool or search_tools; params must match that tool's inputSchema). The ${freeCount} pure-CPU tools execute free on this hosted connector (rate-limited, no wallet - proof-of-work covers them) and return the tool's JSON result. Wallet-only tools (live search/answer, browser render, market data, STT, durable memory) return a paid-access setup guide instead - this connector holds no wallet. An unknown slug returns an error pointing back to search_tools.`,
          inputSchema: {
            type: "object",
            properties: {
              slug: { type: "string", description: 'Tool slug, e.g. "search" or "unit-convert"' },
              params: { type: "object", description: "Tool input, matching the tool's inputSchema" },
            },
            required: ["slug"],
          },
        },
        {
          name: "get_payment_info",
          title: "Payment and wallet setup",
          annotations: { title: "Payment and wallet setup", ...SAFE },
          description:
            `How paying for Agent402 tools works and how to manage a wallet. This hosted connector holds NO wallet: ${freeCount} pure-CPU tools run free here (or solve a proof-of-work puzzle), the rest - including search/answer and the /v1 OpenAI-compatible LLM gateway - settle in USDC via x402. Covers: the free vs paid split, how to configure a funded wallet + per-call and budget spend caps, the rails (${RAILS_OR}), and checking a wallet's balance/transaction history via call_tool on wallet-balances / wallet-transactions. Returns { connector, freeTier, pay, spendControls, balanceAndHistory }.`,
          inputSchema: { type: "object", properties: {} },
        },
        // Flagship demand tools — listed first-class so agents see search/answer
        // as the front door without a discovery round-trip. Wallet-only on this
        // authless connector: calling returns paid-access setup.
        ...[...flagshipSet].map((slug) => {
          const { def, free } = tools.get(slug);
          const ann = FLAGSHIP_WRITERS.has(slug) ? WRITE
            : FLAGSHIP_OPEN_WORLD.has(slug) ? OPEN
            : SAFE;
          const access = free
            ? "[free, no wallet]"
            : `[wallet-required, ${def.price}/call]`;
          const walletNote = free
            ? ""
            : " This hosted connector holds no wallet, so calling it here returns paid-access setup; run it with a funded wallet via npx agent402-mcp or any x402 client.";
          return {
            name: mcpNameOf(slug),
            title: def.name,
            annotations: { title: def.name, ...ann },
            description: `${access} ${def.description}${returnsHint(def)}${walletNote}`,
            inputSchema: schemaOf(def),
          };
        }),
        // request_tool is the only meta tool that WRITES (a wish row).
        {
          name: "request_tool",
          title: "Request a tool Agent402 does not have",
          annotations: {
            title: "Request a tool Agent402 does not have",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
          description: `[free] Tell Agent402 about a capability its 500+ tools do not cover (catalog size ${tools.size}). Use it after search_tools or find_tool came back with nothing that fits, instead of giving up: requests are clustered by need, and the ones that keep coming up get built. Records demand only - it never returns a tool or runs anything. Same intake as POST ${baseUrl}/api/wish; aggregate demand is public at ${baseUrl}/api/wishes.`,
          inputSchema: {
            type: "object",
            properties: {
              need: { type: "string", maxLength: 500, description: 'What you needed and could not find, in plain language, e.g. "convert a HEIC image to JPEG" or "look up a UK company by registration number"' },
              context: { type: "string", maxLength: 300, description: "Optional: what you were trying to accomplish, or the input you had - helps disambiguate similar-sounding requests." },
            },
            required: ["need"],
            additionalProperties: false,
          },
        },
        {
          name: "about_agent402",
          title: "About this Agent402 connector",
          annotations: { title: "About this Agent402 connector", ...SAFE },
          description: "[free] What this connector is: flagship-first tools layer (search/answer as the front door), how to install (Claude Code / Cursor / npm), free vs paid tiers, and discovery URLs. Call this first.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        ...(getLeaderboard ? [{
          name: "top_x402_sellers",
          title: "Top x402 sellers",
          annotations: { title: "Top x402 sellers", ...SAFE },
          description: "[free] Ranked x402 sellers from the on-chain settlement leaderboard: settled call counts, USDC totals and distinct buyers per seller. Use it to find other services in the open x402 ecosystem. This host's own wallet is excluded unless include is set to all.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 50, description: "How many sellers to return (default 10)." },
              sort: { type: "string", enum: ["usd", "calls"], description: "Rank by settled USDC (default) or by settled call count." },
              include: { type: "string", enum: ["external", "all"], description: "external (default) hides this host's own wallet; all includes it." },
            },
            additionalProperties: false,
          },
        }] : []),
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      try {
        if (name === "search_tools") {
          // Funnel stage 1 (discovery) — same event the HTTP discovery
          // surfaces emit in server.js; env-gated no-op without PostHog.
          capturePostHogDiscovery({ surface: "mcp:search_tools" });
          const q = args.query ?? "";
          const { rows: results, topScore } = searchTools(q, args.limit);
          // Multi-tool workflows that match the same query — surface them so an
          // agent asking "audit a domain" sees the whole security-audit pack
          // (callable in ONE payment via skill-<slug>, or step-by-step via
          // prompts/get) alongside the tools.
          const workflows = rankSkillPacks(q, { k: 2, baseUrl, toolPriceUsd });
          // Weak/empty match: nudge toward request_tool instead of a dead
          // end. No wish recorded here — search_tools is a looser lexical
          // search than find_tool, not a task-intent signal; the explicit
          // request_tool call (or find_tool's find-miss capture) is the
          // actual demand signal.
          const weak = results.length === 0 || topScore < FIND_WEAK_SCORE;
          return {
            content: [{
              type: "text",
              text: results.length || workflows.length
                ? JSON.stringify({
                    results,
                    ...(workflows.length ? { workflows, workflowsUsage: "One call: call_tool { slug: 'skill-' + workflows[i].slug, params: { …promptArgs } } (or POST workflows[i].route) runs every step for the single price in workflows[i].price. To orchestrate the steps yourself instead: prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } } - that bills each underlying tool separately." } : {}),
                    ...(weak ? { hint: WISH_HINT_TEXT } : {}),
                    usage: 'call_tool {"slug": …, "params": …}',
                  }, null, 2)
                : `No tools matched "${q}". Full catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
            }],
          };
        }
        if (name === "find_tool") {
          capturePostHogDiscovery({ surface: "mcp:find_tool" });
          const taskStr = String(args.task ?? args.query ?? "");
          const r = findTools(catalog, taskStr, { k: args.limit, baseUrl, powSlugs: freeSlugs });
          // Seller bridge (same as /api/find): a seller-name task points at
          // the indexed seller and the router instead of missing silently.
          let relatedSellers;
          try {
            const rel = findRelatedSellers(taskStr, routableSellerSummaries());
            if (rel.length) relatedSellers = rel.map((x) => ({ ...x, sellerInfo: `${baseUrl}/api/index?seller=${encodeURIComponent(x.host)}`, routeAcross: `${baseUrl}/api/route?q=${encodeURIComponent(taskStr)}&include=external` }));
          } catch { /* best-effort */ }
          const results = r.results.map((t) => ({
            slug: t.slug,
            price: t.price,
            access: t.computePayable ? "free here (rate-limited)" : "wallet required (USDC via x402 - use the agent402-mcp npm server)",
            // Discovery up top: same ordering as /api/find — the answer to
            // "how do I call this" (callWith / example / required) should be
            // visible before the verbose description/schema fields. `required`
            // is always an array so callers can scan without a guard.
            callWith: { name: "call_tool", arguments: { slug: t.slug, params: t.example ?? {} } },
            example: t.example,
            required: Array.isArray(t.required) ? t.required : [],
            inputSchema: t.inputSchema,
            description: t.description.length > 200 ? `${t.description.slice(0, 200)}…` : t.description,
          }));
          // Weak/empty match: this IS a task-intent signal (unlike
          // search_tools' looser lexical search), so capture it as a
          // find-miss wish — fire-and-forget, rate-limit exempt, never
          // blocks the response.
          const topScore = r.results[0]?.score ?? 0;
          // A capability gap phrased in English never cleared the score floor,
          // so this signal only ever captured gibberish. The rarest-term check
          // is what makes a genuine miss observable.
          const weak = r.count === 0 || topScore < FIND_WEAK_SCORE || r.rarestTermCovered === false;
          if (weak && taskStr.trim() && !relatedSellers) {
            try { recordWish({ need: taskStr.trim(), source: "find-miss" }); } catch { /* best-effort */ }
          }
          return {
            content: [{
              type: "text",
              text: results.length || r.packs?.length
                ? JSON.stringify({
                    task: r.query,
                    results,
                    ...(r.packs?.length ? { workflows: r.packs, workflowsUsage: "One call: call_tool { slug: 'skill-' + workflows[i].slug, params: { …promptArgs } } (or POST workflows[i].route) runs every step for the single price in workflows[i].price. To orchestrate the steps yourself instead: prompts/get { name: workflows[i].promptName, arguments: { …promptArgs } } - that bills each underlying tool separately." } : {}),
                    ...(relatedSellers ? { relatedSellers } : {}),
                    ...(weak && !relatedSellers ? { hint: WISH_HINT_TEXT } : {}),
                    usage: "Run call_tool with the chosen {slug, params}. Free results execute here; wallet-only need the agent402-mcp npm server.",
                  }, null, 2)
                : `No tool matched "${taskStr}". Browse the catalog: ${baseUrl}/tools. ${WISH_HINT_TEXT}`,
            }],
          };
        }
        if (name === "request_tool") {
          // The other half of the wish loop: an explicit "I needed something
          // you don't have" signal, same recordWish path as POST /api/wish
          // (source "mcp" instead of "api") — rate-limited per-IP/global,
          // clustered by normalized text, surfaced at GET /api/wishes.
          try {
            const result = recordWish({ need: args.need, context: args.context, source: "mcp", ip });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          } catch (err) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
        }
        if (name === "about_agent402") {
          capturePostHogDiscovery({ surface: "mcp:about" });
          const install = mcpInstallHints(baseUrl);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                service: baseUrl,
                connector: "hosted free tier (authless)",
                maintainer: "Havok Holdings LLC",
                // Flagship-first positioning: tools layer beside LLM gateways,
                // search/answer as the default job, evergreen 500+ catalog.
                startHere: {
                  firstJob: "Search the web and answer questions. Call search_web or answer_question directly, or find_tool with your task. Agent402 is the deterministic tools layer beside LLM gateways (e.g. BlockRun): flagship tools first, 500+ long-tail tools via find_tool / search_tools / call_tool.",
                  flagships: [...flagshipSet].map((slug) => ({
                    mcpName: mcpNameOf(slug),
                    slug,
                    price: tools.get(slug).def.price,
                    access: tools.get(slug).free ? "free here" : "wallet required on this hosted connector",
                  })),
                  llmGateway: `OpenAI-compatible LLM gateway at ${baseUrl}/v1 - flat per-call pricing: chat nano $0.003, auto (eval-ranked model routing) $0.01, embeddings $0.002. No API key: a funded wallet IS the account (x402 settles per call). Reach tiers via call_tool (slugs v1-chat-nano, v1-chat-auto, v1-embeddings) on the npm server.`,
                  freeTier: `${freeCount} pure-CPU tools run free right here with no wallet - payable with ~milliseconds of proof-of-work CPU (discover via find_tool / search_tools).`,
                },
                install,
                tools: tools.size,
                toolsEvergreen: "500+",
                freeHere: freeCount,
                walletOnly: tools.size - freeCount,
                rateLimit: `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client`,
                workflows: {
                  count: SKILL_PACKS.length,
                  usage: "prompts/list → prompts/get { name: '<slug>', arguments: { … } } - same slugs as below.",
                  items: SKILL_PACKS.map((p) => ({
                    slug: p.slug,
                    title: p.title,
                    toolCount: (p.toolSlugs || []).length,
                    tagline: p.tagline,
                  })),
                },
                clientsSeenSinceBoot: Object.fromEntries([...mcpClients].sort((a, b) => b[1] - a[1]).slice(0, 20)),
                paidAccess: `Every tool, no rate limit: pay per call in ${RAILS_PAREN} via the x402 protocol - npx agent402-mcp with AGENT_KEY (EVM) and/or SOLANA_AGENT_KEY (Solana), or any x402 HTTP client. No signup, no API key; most tools $0.001–$0.02/call, LLM gateway tiers $0.002–$0.50, multi-tool skill packs up to $1.50.`,
                ...(getLeaderboard ? { ecosystem: "Call top_x402_sellers to see which x402 sellers (any wallet, not just this host) are settling the most USDC (primarily on Base) in the last 24h - discovers the live economy beyond this catalog." } : {}),
                missingATool: "Call request_tool (or POST /api/wish) with what you needed. We cluster and track demand - repeated requests get built.",
                docs: `${baseUrl}/llms.txt`,
              }, null, 2),
            }],
          };
        }
        if (name === "top_x402_sellers" && getLeaderboard) {
          const snap = getLeaderboard() || {};
          const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
          const sort = args.sort === "calls" ? "calls" : "usd";
          const include = args.include === "all" ? "all" : "external";
          // Self-wallet filter: agents asking "who else is on x402?" want the
          // host's own wallet hidden by default. The hosted catalog ranks
          // because of this very tool process, so leaving it in skews the top
          // toward Agent402 itself.
          const self = (process.env.WALLET_ADDRESS || "").toLowerCase();
          let board = Array.isArray(snap.leaderboard) ? snap.leaderboard : [];
          if (include === "external" && self) board = board.filter((r) => (r.wallet || "").toLowerCase() !== self);
          board = rankLeaderboard(board, sort).slice(0, limit);
          // Trim to a token-cheap row shape — full row (origins, endpoints,
          // etc.) is at /api/leaderboard for agents that want it. Round USDC
          // to 4dp to match the HTML page's display precision and keep the
          // JSON compact.
          // F09: a seller's name/homepage is self-reported, external content.
          // Mark every non-self row as untrusted data so a downstream selecting
          // agent never treats seller copy as an instruction. Our own row
          // (matching WALLET_ADDRESS) is trusted and unmarked.
          const rows = board.map((r) => {
            const isSelf = self && (r.wallet || "").toLowerCase() === self;
            return {
              rank: r.rank,
              name: r.name,
              network: r.network,
              wallet: r.wallet,
              homepage: r.homepage || null,
              callsSettled: r.callsSettled || 0,
              totalUsd: Math.round((r.totalUsd || 0) * 10000) / 10000,
              uniqueBuyers: r.uniqueBuyers || 0,
              ...(isSelf ? {} : { untrustedContent: true }),
            };
          });
          const anyExternal = rows.some((r) => r.untrustedContent);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                window: snap.windowLabel || "24h",
                asOf: snap.asOf,
                sort,
                include,
                totalSellers: (snap.leaderboard || []).length,
                results: rows,
                ...(anyExternal ? { containsUntrustedContent: true } : {}),
                ...(snap.warming || snap.scanSkipped ? { note: "Cache is warming - results may be partial. Retry in ~60s." } : {}),
                source: `${baseUrl}/api/leaderboard`,
              }, null, 2),
            }],
          };
        }
        // Curated tools called by name: route to the same handler as
        // call_tool but use `name` as the slug and `args` as params directly.
        if (name === "get_payment_info" || name === "payment_info") {
          return {
            content: [{ type: "text", text: JSON.stringify({
              connector: "hosted free tier - no wallet is held on this connector (authless)",
              freeTier: {
                pureCpuToolsFree: freeCount,
                how: "pure-CPU tools run free here (rate-limited); wallet-only tools return paid-access instructions",
                proofOfWork: "a walletless client can solve a proof-of-work puzzle instead of paying on eligible tools",
              },
              pay: {
                model: "HTTP 402 + x402, settled in USDC on-chain, non-custodial (you hold the key)",
                rails: RAILS_PAREN,
                setup: "run the agent402-mcp npm server: `npx agent402-mcp` with AGENT_KEY=0x<private key> for EVM (USDC on Base/Polygon/Arbitrum, USDG on Robinhood via AGENT402_NETWORKS) and/or SOLANA_AGENT_KEY=<base58 secret> for Solana. No signup, no API key.",
                prices: "most tools $0.001–$0.02 per call, LLM gateway tiers $0.002–$0.50, multi-tool skill packs up to $1.50 - see each tool's exact price in search_tools results",
                llmGateway: `the /v1 OpenAI-compatible endpoints (chat nano $0.003, auto $0.01, embeddings $0.002) settle the same way - point any OpenAI SDK at ${baseUrl}/v1 through an x402-paying fetch; no API key, the wallet is the account`,
              },
              spendControls: { perCall: "AGENT402_MAX_PER_CALL caps any single call", totalBudget: "AGENT402_BUDGET caps cumulative spend for the session" },
              balanceAndHistory: {
                balance: "check a wallet's USDC balance via call_tool with slug wallet-balances (multi-chain) or wallet-balance (single)",
                transactions: "pull a wallet's transaction history via call_tool with slug wallet-transactions",
                note: "these are on-chain read tools - they need a wallet/paid access, or run them on the npm server",
              },
            }, null, 2) }],
          };
        }
        // First-class tools are exposed under their MCP name (mcpNameOf), but
        // the router accepts every historical spelling — exposed name, legacy
        // snake form, raw kebab slug — so no existing caller breaks across
        // renames. Flagships may be free or wallet-only; wallet-only falls
        // through to the paid-access response below (same as call_tool).
        const namedSlug = namedToolSlugs.get(name) ?? namedToolSlugs.get(name.replace(/_/g, "-")) ?? null;
        const isNamed = namedSlug !== null;
        if (name !== "call_tool" && !isNamed) {
          return { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true };
        }
        const resolvedSlug = isNamed ? namedSlug : String(args.slug ?? "");
        const entry = tools.get(resolvedSlug);
        if (!entry) {
          return { content: [{ type: "text", text: `Unknown slug "${resolvedSlug}". Use search_tools to find the right slug.` }], isError: true };
        }
        if (!entry.free) {
          return { content: [{ type: "text", text: walletRequiredText(entry.def) }], isError: true };
        }
        if (rateLimited(ip)) {
          return {
            content: [{ type: "text", text: `Free-tier rate limit reached (${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour). For unmetered access pay per call via x402: npx agent402-mcp with AGENT_KEY. ${baseUrl}/llms.txt` }],
            isError: true,
          };
        }
        // Flagship tools called by name: args IS the params (no envelope).
        // call_tool path: accept params as object, JSON string, or flattened.
        let params;
        if (isNamed) {
          params = args;
        } else {
          // Accept params as an object OR a JSON string — LLM clients (e.g.
          // some Claude Code calls) often stringify object arguments.
          //
          // ALSO: many LLMs ignore the {slug, params} envelope and flatten —
          // e.g. { slug: "whois", domain: "example.com" } instead of
          // { slug: "whois", params: { domain: "example.com" } }. When
          // `params` is missing/invalid, treat the rest of `args` as params.
          params = args.params;
          if (typeof params === "string") {
            const s = params.trim();
            try { params = JSON.parse(s); }
            catch {
              const eq = s.indexOf("=");
              params = eq > 0 ? { [s.slice(0, eq).trim()]: s.slice(eq + 1).trim() } : {};
            }
          }
          if (!params || typeof params !== "object" || Array.isArray(params)) {
            const { slug: _drop, ...rest } = args;
            params = rest && typeof rest === "object" && Object.keys(rest).length ? rest : {};
          }
        }
        // Same contract as the express kit routes; handlers only see input.
        // Time the call so the analytics dispatcher gets accurate latency for
        // MCP traffic (same as the HTTP path). Errors here flow into the
        // catch below and are reported with errored:true.
        const startedAt = Date.now();
        let result;
        try {
          // F14: don't start work for a request already aborted (deadline/
          // disconnect), and hand the signal to the handler so a signal-aware
          // one (or a fetch inside it) can bail early. CPU-bound handlers still
          // run to completion, but the transport is closed and the slot is only
          // released after this promise settles (see the POST /mcp handler).
          if (signal?.aborted) throw Object.assign(new Error("request aborted"), { statusCode: 499 });
          result = await entry.def.handler(params, { headers: {}, query: params, body: params, ip, signal });
        } catch (handlerErr) {
          // statusCode lets the analytics dispatcher split 4xx (bad input) from
          // 5xx (handler/upstream broke). errorMessage flows into the diagnostic
          // log so we can spot patterns like a single bad caller hammering one
          // tool with the wrong field shape.
          onServed(entry.def.slug, {
            latencyMs: Date.now() - startedAt,
            errored: true,
            statusCode: handlerErr.statusCode || 500,
            errorMessage: handlerErr.message,
            inputKeys: params && typeof params === "object" ? Object.keys(params) : [],
          });
          // Self-correction envelope: when the call fails the LLM caller almost
          // always has enough information in the original tool description, but
          // it ignored it. Echo the expected shape + a working example back so
          // the next attempt can fix itself without another search_tools call.
          const hint = {
            error: handlerErr.message,
            tool: entry.def.slug,
            expected: entry.def.discovery?.inputSchema?.properties || {},
            required: entry.def.discovery?.inputSchema?.required || [],
            example: entry.def.discovery?.input || {},
            callWith: {
              name: "call_tool",
              arguments: { slug: entry.def.slug, params: entry.def.discovery?.input || {} },
            },
          };
          return { content: [{ type: "text", text: JSON.stringify(hint, null, 2) }], isError: true };
        }
        onServed(entry.def.slug, { latencyMs: Date.now() - startedAt, errored: false });
        if (result && result.__binary) {
          return { content: [{ type: "image", data: Buffer.from(result.__binary).toString("base64"), mimeType: result.contentType }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Agent402: ${err.message}` }], isError: true };
      }
    });

    return server;
  }

  // Wildcard CORS so browser-based MCP clients (inspector, web agents) work;
  // claude.ai connects server-side and ignores this. This is a deliberate
  // product requirement for a PUBLIC MCP connector (security audit A402-12).
  // It is safe because it is CREDENTIAL-FREE: Access-Control-Allow-Credentials
  // is never set, so browsers won't attach cookies, and the wildcard origin +
  // credentials combination is rejected by the browser anyway. There is no
  // cookie/session authority on /mcp; abuse is bounded by the per-IP/per-minute
  // and per-hour rate limits (AGENT402_MCP_MAX_PER_MIN / _PER_HOUR), not by
  // origin. DO NOT add Access-Control-Allow-Credentials here.
  app.use("/mcp", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // Stateless mode: a fresh server+transport per POST, no session table. Every
  // JSON-RPC message (including initialize) is self-contained, which survives
  // redeploys and needs no sticky routing.
  app.post("/mcp", async (req, res) => {
    // req.ip is derived via the app's "trust proxy" setting, so it's the real
    // client IP (the edge-appended XFF hop) — NOT a spoofable client-supplied
    // X-Forwarded-For value. This is the only abuse control on the free tier,
    // so it must not be bypassable by injecting a header.
    const ip = (req.ip || req.socket.remoteAddress || "?").trim();
    // R-11 outer gate #1: per-IP raw-request cap, BEFORE allocating anything.
    if (mcpReqLimiter.check(ip).limited) {
      return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests to /mcp - slow down and retry shortly." }, id: req.body?.id ?? null });
    }
    // R-11 outer gate #2: global in-flight transport ceiling, BEFORE building
    // the server/transport (bounds allocation under an initialize/malformed flood).
    if (mcpInFlight >= MCP_MAX_CONCURRENT) {
      return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint is at capacity - retry shortly." }, id: req.body?.id ?? null });
    }
    // Adoption telemetry: every MCP session announces its client at
    // initialize (e.g. "claude-ai", "claude-code"). In-memory since boot.
    const ci = req.body?.method === "initialize" ? req.body?.params?.clientInfo : null;
    if (ci?.name && mcpClients.size < 500) {
      // clientInfo is attacker-controlled — sanitize before it lands in the log
      // line OR the in-memory telemetry map (audit F24).
      const key = logSafe(`${ci.name}@${ci.version || "?"}`, 80);
      mcpClients.set(key, (mcpClients.get(key) || 0) + 1);
      console.log(`[mcp] initialize from ${key}`);
    }
    mcpInFlight++;
    let deadlineTimer = null;
    const ac = new AbortController();
    let transport = null;
    let run = null;
    try {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      // Client disconnect: abort in-flight handler work AND close the transport
      // (F14) — not just close the transport while the handler keeps running.
      res.on("close", () => { ac.abort(); try { transport.close(); } catch { /* already closing */ } });
      await buildServer(ip, ac.signal).connect(transport);
      run = transport.handleRequest(req, res, req.body);
      // R-11/F14: per-request deadline. On fire, abort the handler and close the
      // transport so it settles, then (in finally) await that settle before the
      // slot is released — mcpInFlight never undercounts truly-live work.
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          ac.abort();
          try { transport.close(); } catch { /* already closing */ }
          reject(Object.assign(new Error("mcp request deadline exceeded"), { __deadline: true }));
        }, MCP_REQ_DEADLINE_MS);
      });
      await Promise.race([run, deadline]);
    } catch (err) {
      if (!res.headersSent) {
        res.status(err.__deadline ? 504 : 500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: req.body?.id ?? null });
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // F14: release the slot only AFTER the underlying handler has actually
      // terminated (bounded by MCP_DRAIN_MS), not merely when the deadline won
      // the race. Aborting + closing the transport above makes it settle fast.
      if (run) await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, MCP_DRAIN_MS))]);
      mcpInFlight--;
    }
  });

  // Stateless servers have no notification stream or session to manage.
  app.get("/mcp", (_req, res) => res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "This MCP endpoint is stateless: POST JSON-RPC messages to /mcp." },
    id: null,
  }));
  app.delete("/mcp", (_req, res) => res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Stateless endpoint - no session to terminate." },
    id: null,
  }));
}
