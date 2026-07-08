# Agent402 + CrewAI Starter
# pip install "agent402-langchain[langchain]" crewai
#
# Agent402's 1,413 pay-per-call tools, exposed to CrewAI as four meta-tools
# (find / route / call / about). Pure-CPU tools (hashing, encoding, QR, markdown,
# JSON, readability…) are FREE via built-in proof-of-work — no wallet, no keys.
# Live-data tools (market data, EDGAR, web search, on-chain) are wallet-only:
# pass x402_fetch=<callable> that signs USDC payment. See https://agent402.tools/docs.

from crewai import Agent, Task, Crew
from agent402_langchain import Agent402Toolkit

toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()

analyst = Agent(
    role="Data Analyst",
    goal="Answer questions using Agent402's live tools",
    backstory="You use agent402_find to pick the right tool, then agent402_call to run it.",
    tools=tools,
    verbose=True,
)

# Runs out of the box on the free tier (proof-of-work, no wallet):
task = Task(
    description="Generate a QR code for the URL https://agent402.tools and report the format and size.",
    expected_output="Confirmation the QR code was generated, with its format.",
    agent=analyst,
)
# For a live-market-data run instead — e.g. 'Research NVDA: price, financials,
# recent news' — construct the toolkit with x402_fetch so the wallet-only tools
# can settle in USDC.

crew = Crew(agents=[analyst], tasks=[task], verbose=True)
result = crew.kickoff()
print(result)
