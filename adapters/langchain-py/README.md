# agent402-langchain (Python)

Turn [Agent402](https://agent402.tools)'s catalog — 500 strong: 400 x402
pay-per-call tools + 100 skill packs — into **LangChain** and **CrewAI** tools
for Python agents.

Pure-CPU tools (hashing, encoding, QR, markdown, JSON, readability…) are **free**
via built-in proof-of-work — no wallet, no API keys. Live-data tools (market
data, web search, EDGAR, on-chain) are wallet-only and settle in USDC.

```bash
pip install "agent402-langchain[langchain]"
```

```python
from agent402_langchain import Agent402Toolkit

toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()   # four meta-tools your agent can call
```

It exposes **four meta-tools** rather than 500 individual ones (frameworks and
LLMs both choke on thousands of tools):

| Tool | What it does |
| --- | --- |
| `agent402_find` | Resolve a plain-language task to the best tool (slug, price, schema, example) |
| `agent402_route` | Cross-seller x402 router across the whole ecosystem |
| `agent402_call` | Call a tool by slug — auto-pays via proof-of-work (free) or your x402 fetch (paid) |
| `agent402_about` | The service manifest (identity, payment options, trust signals) |

## Paid (wallet-only) tools

Pass `x402_fetch` — a callable with the `requests`-style signature
`(method, url, **kwargs) -> requests.Response` that signs the USDC payment:

```python
toolkit = Agent402Toolkit(base_url="https://agent402.tools", x402_fetch=my_signed_fetch)
```

Without it, calling a wallet-only tool raises a clear error naming what's needed;
the free proof-of-work tier keeps working regardless.

## Without LangChain

`agent402_tool_specs()` returns the same four entries as framework-agnostic dicts
(`name`, `description`, JSON Schema, and a plain `execute` callable) — no
langchain-core needed.

MIT © Havok Holdings LLC · [github.com/MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402)
