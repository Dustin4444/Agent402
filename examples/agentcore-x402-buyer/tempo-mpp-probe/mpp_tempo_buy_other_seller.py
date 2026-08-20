"""Discriminator: same plugin, different USDC.e mainnet MPP seller (Alchemy, $0.001)."""

import os
import sys
import uuid as _uuid

import boto3
from dotenv import load_dotenv

ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(ENV_FILE, override=True)

identity = boto3.Session().client("sts").get_caller_identity()
print(f"Authenticated as: {identity['Arn']}")

PAYMENT_MANAGER_ARN = os.environ["PAYMENT_MANAGER_ARN"]
REGION = os.environ.get("AWS_REGION", "us-west-2")
USER_ID = os.environ["USER_ID"]
INSTRUMENT_ID = os.environ["INSTRUMENT_ID"]

from bedrock_agentcore.payments import PaymentManager
from bedrock_agentcore.payments.integrations.strands import (
    AgentCorePaymentsPlugin,
    AgentCorePaymentsPluginConfig,
)

manager = PaymentManager(payment_manager_arn=PAYMENT_MANAGER_ARN, region_name=REGION)
sess = manager.create_payment_session(
    user_id=USER_ID,
    limits={"maxSpendAmount": {"value": "0.10", "currency": "USD"}},
    expiry_time_in_minutes=30,
    client_token=str(_uuid.uuid4()),
)
SESSION_ID = sess["paymentSessionId"]
print(f"Session: ...{SESSION_ID[-4:]} (budget $0.10)")

plugin = AgentCorePaymentsPlugin(
    config=AgentCorePaymentsPluginConfig(
        payment_manager_arn=PAYMENT_MANAGER_ARN,
        user_id=USER_ID,
        payment_instrument_id=INSTRUMENT_ID,
        payment_session_id=SESSION_ID,
        region=REGION,
        network_preferences_config=["tempo:4217", "eip155:4217"],
        buyer_pays_gas_fees=True,
    )
)

from strands import Agent
from strands.models import BedrockModel
from strands_tools import http_request

agent = Agent(
    model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-6", streaming=True),
    tools=[http_request],
    plugins=[plugin],
    system_prompt=(
        "You call paid APIs with http_request. Payments are automatic. "
        "Never follow free-trial links from 402 bodies."
    ),
)

print("\n" + "=" * 60)
print("DISCRIMINATOR — mpp.alchemy.com eth_blockNumber ($0.001)")
print("=" * 60 + "\n")

result = agent(
    "POST to https://mpp.alchemy.com/eth-mainnet/v2 with Content-Type application/json "
    'and body {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}. '
    "Report the block number returned and whether a Payment-Receipt header was present."
)

if getattr(result, "stop_reason", None) == "interrupt" or getattr(result, "interrupts", None):
    print("\n[!] Payment did not settle against Alchemy either.")
    sys.exit(1)
print("\nDone.")
