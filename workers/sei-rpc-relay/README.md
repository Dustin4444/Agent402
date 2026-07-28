# sei-rpc-relay

Cloudflare Worker proxying Sei's public EVM JSON-RPC (`evm-rpc.sei-apis.com`)
for the revenue surfaces. Exists because the upstream errors every
`eth_getLogs` from Railway's shared egress IP range while serving residential
clients normally, and the only public alternative archive-gates `getLogs`.

Deliberately narrow: POST-only, single JSON-RPC requests, read-only method
allowlist, Bearer-token gated (`RELAY_TOKEN` Worker secret, mirrored on
Railway as `SEI_RELAY_TOKEN` next to `SEI_RELAY_URL`).

Deploy:

    npx wrangler deploy
    npx wrangler secret put RELAY_TOKEN

`SEI_RELAY_URL` + `SEI_RELAY_TOKEN` on Railway enable it (both must be set;
falls back to direct Sei RPCs if unset).
