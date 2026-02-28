# ottoauthMCP

Standalone MCP stdio server that proxies tool calls to Ottoauth HTTP endpoints.

## Features

- Discovers service endpoints from `GET /api/services` docs.
- Registers dynamic MCP tools per endpoint.
- Refreshes discovered tools once every 24 hours.
- Includes a generic passthrough tool: `ottoauth_http_request`.

## Run

```bash
npm install
OTTOAUTH_BASE_URL=http://localhost:3000 npm start
```

## Tests

```bash
npm test
```

Test coverage includes:
- parser and normalization edge cases
- timeout and forwarding behavior
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
