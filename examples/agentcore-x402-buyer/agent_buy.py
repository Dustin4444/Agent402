#!/usr/bin/env python3
"""
Strands agent on AWS Bedrock AgentCore that buys an Agent402 tool over x402.

This is the SHOWCASE: a Strands agent with the AgentCore Payments plugin and an
HTTP tool. You prompt it to call a paid endpoint; when the endpoint returns HTTP
402, the plugin signs the x402 micropayment (from the AgentCore-managed wallet),
retries, and the agent gets the paid result - no payment code in the agent.

Mirrors the AWS quickstart
(docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-getting-started.html),
pointed at an Agent402 tool instead of a sample merchant.

Prereqs: same Payment Manager / Instrument / Session as direct_buy.py (created by
the `agents-pay` skill), plus Bedrock model access for the agent's LLM. Run
direct_buy.py first to confirm the wallet works, then:  python agent_buy.py
"""
import os

from strands import Agent
from strands_tools import http_request
from bedrock_agentcore.payments.integrations.config import AgentCorePaymentsPluginConfig
from bedrock_agentcore.payments.integrations.strands.plugin import AgentCorePaymentsPlugin

REGION = os.environ.get("AWS_REGION", "us-west-2")
PAYMENT_MANAGER_ARN = os.environ["PAYMENT_MANAGER_ARN"]
PAYMENT_INSTRUMENT_ID = os.environ["PAYMENT_INSTRUMENT_ID"]
PAYMENT_SESSION_ID = os.environ["PAYMENT_SESSION_ID"]
USER_ID = os.environ.get("PAYMENT_USER_ID", "agent402-demo-user")

TARGET_URL = os.environ.get("TARGET_URL", "https://agent402.tools/api/hash")

config = AgentCorePaymentsPluginConfig(
    payment_manager_arn=PAYMENT_MANAGER_ARN,
    user_id=USER_ID,
    payment_instrument_id=PAYMENT_INSTRUMENT_ID,
    payment_session_id=PAYMENT_SESSION_ID,
    region=REGION,
)
plugin = AgentCorePaymentsPlugin(config=config)

agent = Agent(
    system_prompt=(
        "You are an assistant that can call paid HTTP APIs. When a request "
        "returns HTTP 402 Payment Required, the payment plugin settles it "
        "automatically - just retry and use the result. Report the JSON you get back."
    ),
    tools=[http_request],
    plugins=[plugin],
)

if __name__ == "__main__":
    prompt = (
        f"POST to {TARGET_URL} with JSON body "
        f'{{"text": "hello world", "algo": "sha256"}} and tell me the "hash" field '
        f"in the response."
    )
    print(f"Prompt: {prompt}\n")
    response = agent(prompt)
    print(response)
