// Flagship MCP surface — the small default tools/list agents see first.
//
// Product intent (competitive brief 2026-08): Agent402 wins as the deterministic
// tools layer beside LLM gateways (BlockRun et al.). Default MCP exposure is a
// tight flagship set; the long catalog stays callable via find_tool /
// search_tools / call_tool. Keep this list aligned with mcp/index.js
// DEFAULT_CURATED (stdio package cannot import this file when published).
//
// Chosen from live topPaidTools + front-door thesis (search/answer first):
// search, answer, search-news, render, stock-quote, transcribe, memory-*.
// Exactly 8 catalog flagships so hosted tools/list stays ~15 with meta tools
// (Glama's well-scoped band is 3–15).

export const FLAGSHIP_SLUGS = [
  "search",
  "answer",
  "search-news",
  "render",
  "stock-quote",
  "transcribe",
  "memory-read",
  "memory-write",
];

// verb_noun MCP names (Glama naming-consistency). CallTool also accepts the
// kebab slug and plain snake form.
export const FLAGSHIP_MCP_NAMES = {
  search: "search_web",
  answer: "answer_question",
  "search-news": "search_news",
  render: "render_page",
  "stock-quote": "get_stock_quote",
  transcribe: "transcribe_audio",
  "memory-read": "read_memory",
  "memory-write": "write_memory",
};

/** Open-world / egress tools — honest annotations for directory clients. */
export const FLAGSHIP_OPEN_WORLD = new Set([
  "search", "answer", "search-news", "render", "stock-quote", "transcribe",
]);

/** Tools that mutate durable state (not read-only). */
export const FLAGSHIP_WRITERS = new Set(["memory-write"]);

/**
 * Install one-liners agents can copy without leaving the connector.
 * Hosted URL is parameterized; npm / Claude Code / Cursor / Smithery notes
 * match docs/ecosystem-listings.md + wiki/MCP-Connector.md.
 */
export function mcpInstallHints(baseUrl) {
  const hosted = `${baseUrl}/mcp`;
  return {
    hostedUrl: hosted,
    claudeCodeHosted: `claude mcp add --transport http agent402 ${hosted}`,
    claudeCodeNpm: "claude mcp add agent402 -s user -- npx -y agent402-mcp@latest",
    cursorMcpJson: {
      mcpServers: {
        agent402: { url: hosted },
      },
    },
    cursorNpmMcpJson: {
      mcpServers: {
        agent402: {
          command: "npx",
          args: ["-y", "agent402-mcp"],
          env: { AGENT_KEY: "0xYOUR_PRIVATE_KEY" },
        },
      },
    },
    npm: "npx -y agent402-mcp",
    smithery: "Paste the hosted URL at https://smithery.ai/new (or: smithery mcp publish \"https://agent402.tools/mcp\" -n @MikeyPetrillo/agent402). Submission is external; Agent402 does not auto-publish.",
    maintainer: "Havok Holdings LLC",
  };
}

/**
 * MCP initialize.instructions — orientation for clients that never call
 * about_agent402. Keep tool names listed-only (self-consistency) and lead
 * with search/answer as the front door.
 */
export function mcpInitializeInstructions(baseUrl) {
  const install = mcpInstallHints(baseUrl);
  const hosted = install.hostedUrl;
  return [
    "Agent402 is a deterministic tools layer for AI agents (Havok Holdings LLC).",
    "Front door: call search_web or answer_question for live web search and cited answers.",
    "Also listed: search_news, render_page, get_stock_quote, transcribe_audio, read_memory, write_memory.",
    "Long catalog (500+ tools): call find_tool with your task, or search_tools then call_tool.",
    "Orientation: call about_agent402. Payment rails / wallet setup: call get_payment_info.",
    "Missing a tool: call request_tool. Ecosystem sellers: call top_x402_sellers.",
    `Install (hosted, zero wallet): ${install.claudeCodeHosted}`,
    `Install (npm + wallet for paid flagships): ${install.claudeCodeNpm}`,
    `Cursor mcp.json: { "mcpServers": { "agent402": { "url": "${hosted}" } } }`,
    `Docs: ${baseUrl}/llms.txt · ${baseUrl}/api/find?q=… · status ${baseUrl}/status`,
  ].join("\n");
}
