# Agent402 as an Amazon Bedrock AgentCore Gateway target

Two ways to put Agent402's catalog in front of an AgentCore agent, both with
the AgentCore CLI (`agentcore`). Commands follow the AgentCore developer
guide's `agentcore add gateway-target` forms.

## 1. MCP server target (discovery + free tier, no credentials)

```bash
agentcore add gateway-target \
  --name Agent402MCP \
  --type mcp-server \
  --endpoint https://agent402.tools/mcp \
  --gateway MyGateway
agentcore deploy
```

The gateway aggregates Agent402's hosted connector (`catalog.search`,
`catalog.find`, `catalog.call`, `payment.info`, the flagship aliases) into its
own MCP server. Discovery and proof-of-work tools need no key.

## 2. OpenAPI target (every HTTP route as a tool)

```bash
curl -sO https://agent402.tools/openapi.json
agentcore add gateway-target \
  --name Agent402API \
  --type open-api-schema \
  --schema ./openapi.json \
  --outbound-auth none \
  --gateway MyGateway
agentcore deploy
```

`openapi.json` is OpenAPI 3.1 with one `operationId` per route and no
`oneOf`/`anyOf`/`allOf`, the shape AgentCore's importer accepts.

## Paying for a tool

A paid route answers a stock x402 `402` challenge. With AgentCore Payments the
agent forwards that payload to `process_payment` (`paymentInput.cryptoX402`),
receives a signed proof, and retries with it in `X-PAYMENT`; nothing on the
Agent402 side needs configuring. Prepaid card credits work too: send
`Authorization: Bearer a402_…` (buy a pack at https://agent402.tools/credits).

Copy-paste blocks for other hosts: https://agent402.tools/guides/agent-hosts
