# ottoauthMCP

Standalone MCP stdio server that proxies tool calls to Ottoauth HTTP endpoints.

## Features

- Discovers service endpoints from `GET /api/services` docs.
- Registers dynamic MCP tools per endpoint.
- Refreshes discovered tools once every hour.
- Includes a generic passthrough tool: `ottoauth_http_request`.
- Runs an Ottoauth webhook receiver and relays incoming events to an agent gateway with retries.

## Run

```bash
npm install
OTTOAUTH_BASE_URL=http://localhost:3000 npm start
```

Webhook receiver defaults:
- host: `127.0.0.1`
- port: `3789`
- path: `/webhooks/ottoauth`

Important env vars:
- `OTTOAUTH_WEBHOOK_SECRET` (recommended; validates `x-ottoauth-signature`)
- `OTTOAUTH_WEBHOOK_ALLOW_UNSIGNED=1` (dev only)
- `OTTOAUTH_WEBHOOK_PORT` / `OTTOAUTH_WEBHOOK_HOST` / `OTTOAUTH_WEBHOOK_PATH`
- `AGENT_GATEWAY_URL` (relay destination)
- `AGENT_GATEWAY_AUTH_TOKEN` (optional bearer token to gateway)
- `WEBHOOK_RETRY_BASE_MS` (default `2000`)
- `WEBHOOK_RETRY_MAX` (default `8`)
- `WEBHOOK_EVENT_STORE_PATH` (defaults to `.ottoauth-webhook-events.json` in cwd)

## Tests

```bash
npm test
```

Test coverage includes:
- parser and normalization edge cases
- timeout and forwarding behavior
- webhook signature, dedupe, retries, dead-letter
- MCP stdio end-to-end flow
- integration test using simple demo agent script from neighboring `autoauth` repo

## MCP client config example

```json
{
  "mcpServers": {
    "ottoauth": {
      "command": "node",
      "args": ["/absolute/path/to/ottoauthMCP/src/index.mjs"],
      "env": {
        "OTTOAUTH_BASE_URL": "https://your-ottoauth-domain.com"
      }
    }
  }
}
```
