<div align="center">
  <h1>@cyanheads/exchange-rates-mcp-server</h1>
  <p><b>Convert currencies, get FX rates, and query historical ECB exchange rate data via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/exchange-rates-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/exchange-rates-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/exchange-rates-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/exchange-rates-mcp-server/releases/latest/download/exchange-rates-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=exchange-rates-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXhjaGFuZ2UtcmF0ZXMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22exchange-rates-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fexchange-rates-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools for working with ECB FX rate data — currency lookup and disambiguation, point-in-time rates and conversions, historical time-series retrieval, and SQL analytics over the DataCanvas workspace that long time-series calls produce:

| Tool | Description |
|:-----|:------------|
| `fx_list_currencies` | List all ~30 ECB-supported ISO 4217 currencies with full names. Use before converting to disambiguate "dollars" (USD vs AUD vs CAD vs HKD vs SGD). |
| `fx_get_rates` | Snapshot of all available rates for a base currency at latest or a historical date. Optional `symbols` filter for smaller responses. |
| `fx_get_rate` | Exchange rate for a single currency pair at latest or a historical date. Surfaces `date_snapped` when a weekend/holiday request returns the prior business-day rate. |
| `fx_convert_currency` | Convert an amount between any two currencies at latest or a historical rate. Cross-rates are triangulated through EUR. Returns converted amount, rate used, rate date, and whether the date was snapped. |
| `fx_get_timeseries` | Historical daily rates for a currency pair over a date range. Short ranges (≤90 days) are returned inline; long ranges spill to DataCanvas with a `canvas_id` for SQL follow-up. |
| `fx_dataframe_describe` | List DataCanvas tables and their columns from a prior `fx_get_timeseries` call. Required first step before `fx_dataframe_query`. |
| `fx_dataframe_query` | Run a read-only SQL SELECT against a DataCanvas table produced by `fx_get_timeseries`. Supports aggregations, GROUP BY, window functions, and JOINs across multiple registered tables. |

### `fx_list_currencies`

Enumerate all supported currencies before converting or querying.

- Returns `[{ code, name }]` for all ~30 ECB-scoped currencies
- ECB coverage fluctuates as currencies enter/exit scope — always call this tool to validate user-supplied codes rather than hard-coding a list

---

### `fx_get_rates`

Full rates snapshot for a base currency in one call.

- Returns all available quote currencies at a given date (default: latest)
- Optional `symbols` parameter narrows the response to specific quote currencies
- Useful for seeding bulk comparison workflows or discovering what's available

---

### `fx_get_rate`

Point-in-time exchange rate for a single pair.

- Returns the rate, the actual rate date, and `date_snapped: true` when the API silently moved a weekend/holiday request to the prior business day
- Cross-rates (neither side EUR) are triangulated in a single API call — no extra round trip
- Use `fx_convert_currency` when you need the converted amount; use this tool when you only need the rate number

---

### `fx_convert_currency`

Convert an amount between any two currencies.

- Handles EUR ↔ any, any ↔ EUR, and cross-rate (USD → JPY via EUR) in one upstream call
- Returns `converted_amount`, `rate`, `rate_date`, `date_snapped`, plus `rate_type` and `source` provenance on every response
- Historical conversions supported back to 1999-01-04 (ECB launch date)

---

### `fx_get_timeseries` + `fx_dataframe_describe` / `fx_dataframe_query`

Historical rate series and DataCanvas SQL analytics.

`fx_get_timeseries` returns a date-keyed series (business days only — ECB publishes once per business day):

- Short ranges (≤ `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS`, default 90 days) → inline `rates` map + metadata
- Long ranges → first N rows inline + `canvas_id`, `table_name`, and `truncated: true` — the full series is registered as a DuckDB-backed table

Once a `canvas_id` is in hand:

1. **`fx_dataframe_describe`** — list the tables and columns on the canvas (required before `fx_dataframe_query`)
2. **`fx_dataframe_query`** — run arbitrary SQL SELECT against the registered table; supports aggregations, GROUP BY, window functions, JOINs across tables from multiple `fx_get_timeseries` calls

The canvas uses a session-scoped TTL. To continue working with a prior series, call `fx_get_timeseries` again with the same parameters to obtain a fresh `canvas_id`.

---

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `fx://currencies` | All supported currencies as a stable reference document. Injectable context for clients that support resources. |
| Resource | `fx://rates/latest/{base}` | Latest rates snapshot for a base currency as a stable URI. |

All resource data is also reachable via tools. Use `fx_list_currencies` or `fx_get_rates` for programmatic access.

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Typed error contracts with recovery hints — `unsupported_currency`, `date_out_of_range`, `canvas_not_found`, `invalid_query`
- Pluggable auth: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

ECB FX–specific:

- Keyless access via [Frankfurter](https://www.frankfurter.dev/) — a Cloudflare-fronted ECB proxy; no API keys required
- Cross-rate triangulation: any pair works (USD → JPY fetches EUR/USD and EUR/JPY in one call, computes JPY/USD ratio)
- Weekend/holiday date semantics: `date_snapped` flag surfaces when the API returns a different date than requested
- ECB data covers ~30 major currencies from 1999-01-04 to present; `fx_list_currencies` always reflects the live set
- DataCanvas integration: `fx_get_timeseries` spills long ranges to DuckDB for aggregations and trend analysis
- Rate provenance on every response: `rate_type: "ECB reference (mid-market)"` and `source: "ECB via Frankfurter"` — explicitly mid-market, not tradeable bid/ask

Agent-friendly output:

- Rate provenance on every response — `rate_type`, `source`, `rate_date`, and `date_snapped` so agents can reason about trust and freshness
- Structured error contracts — typed `reason` fields (`unsupported_currency`, `date_out_of_range`, `invalid_query`, …) let callers branch on failure type, not string parsing
- Discriminated DataCanvas output — `canvas_id` and `truncated: true` signal when a time-series exceeds the inline limit and SQL follow-up is needed

---

## Getting started

No API key required — Frankfurter is keyless. Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "exchange-rates-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/exchange-rates-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "exchange-rates-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/exchange-rates-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "exchange-rates-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/exchange-rates-mcp-server:latest"
      ]
    }
  }
}
```

To enable DataCanvas for long time-series SQL analytics, add `CANVAS_PROVIDER_TYPE=duckdb`:

```json
{
  "mcpServers": {
    "exchange-rates-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/exchange-rates-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "CANVAS_PROVIDER_TYPE": "duckdb"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key — Frankfurter is free and keyless.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/exchange-rates-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd exchange-rates-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env as needed (all vars are optional — no keys required)
```

---

## Configuration

All configuration is validated at startup via Zod schemas. Environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FRANKFURTER_BASE_URL` | Frankfurter API base URL. Override for local testing or a self-hosted instance. | `https://api.frankfurter.dev/v1` |
| `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` | Day range above which `fx_get_timeseries` spills to DataCanvas instead of returning inline. | `90` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. Set to `duckdb` to enable DataCanvas for `fx_get_timeseries` long-range spillover. | `none` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424: `debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides including storage, session, and telemetry vars.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t exchange-rates-mcp-server .
docker run --rm -p 3010:3010 exchange-rates-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/exchange-rates-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. DuckDB native binaries are pre-built in the build stage and copied to production, keeping the production image free of build tools.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, and canvas accessor. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`) — `fx_*` tools. |
| `src/mcp-server/resources/` | Resource definitions — `fx://currencies` and `fx://rates/latest/{base}`. |
| `src/services/frankfurter/` | Frankfurter HTTP client, retry logic, and domain types. |
| `src/services/canvas/` | Module-level DataCanvas accessor for `fx_get_timeseries` spillover. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design document and idea notes. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- ECB rates are mid-market reference rates — preserve the `rate_type` provenance in every response

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
