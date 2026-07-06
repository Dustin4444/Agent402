"""Offline-ish test for agent402-langchain (Python).

Mirrors the JS adapters' test.js: boots nothing itself — point it at a running
FREE_MODE server via AGENT402_BASE_URL (default http://localhost:3091), then
exercises the spec path (no framework deps) and the free proof-of-work call path
end to end. The LangChain-native path is checked only if langchain-core is
installed, so the core test runs with just `requests`.

    AGENT402_BASE_URL=http://localhost:3091 python adapters/langchain-py/test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from agent402_langchain import agent402_tool_specs, Agent402Toolkit  # noqa: E402

BASE = os.environ.get("AGENT402_BASE_URL", "http://localhost:3091")
passed = failed = 0


def ok(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok - {msg}")
    else:
        failed += 1
        print(f"FAIL - {msg}", file=sys.stderr)


specs = agent402_tool_specs(base_url=BASE)
ok(len(specs) == 4, f"four meta-tools ({len(specs)})")
names = {s["name"] for s in specs}
ok(names == {"agent402_find", "agent402_route", "agent402_call", "agent402_about"},
   f"names are find/route/call/about ({sorted(names)})")

by = {s["name"]: s for s in specs}

# find — resolve a task to a tool
res = by["agent402_find"]["execute"](task="sha256 hash of some text", limit=3)
results = res.get("results") or res.get("tools") or []
ok(isinstance(results, list) and len(results) >= 1, f"find returns results ({len(results)})")

# about — service manifest
about = by["agent402_about"]["execute"]()
ok(isinstance(about, dict) and ("x402Version" in about or "payment" in about or "name" in about),
   "about returns the service manifest")

# call — free pure-CPU tool settles via built-in proof-of-work, no wallet
h = by["agent402_call"]["execute"](slug="hash", params={"text": "hello world"})
ok(isinstance(h, dict) and str(h.get("hex", "")).startswith("b94d27b9"),
   f"free PoW call to hash settles and returns the digest ({str(h.get('hex',''))[:12]}…)")

# unknown slug raises a clear, actionable error (not a raw HTTP failure)
try:
    by["agent402_call"]["execute"](slug="no-such-tool-xyz", params={})
    ok(False, "unknown slug should raise")
except ValueError as e:
    ok("unknown tool" in str(e), "unknown slug raises a clear 'unknown tool' error")
except Exception as e:  # noqa: BLE001
    ok(False, f"unknown slug raised the wrong error type: {type(e).__name__}: {e}")

# LangChain-native path — only if the optional dep is installed
try:
    import langchain_core  # noqa: F401
    tools = Agent402Toolkit(base_url=BASE).get_tools()
    ok(len(tools) == 4 and hasattr(tools[0], "name"),
       f"get_tools() returns 4 LangChain StructuredTools ({[t.name for t in tools]})")
except ImportError:
    print("skip - langchain-core not installed; spec path already verified")

print(f"\n{'FAILED' if failed else 'OK'}: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
