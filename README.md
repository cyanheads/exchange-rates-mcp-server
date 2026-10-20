<div align="center">
  <h1>@cyanheads/exchange-rates-mcp-server</h1>
  <p><b>Convert currencies, get FX rates, and query historical ECB exchange rate data via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Opt-in Tool • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/exchange-rates-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/exchange-rates-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/exchange-rates-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/exchange-rates-mcp-server/releases/latest/download/exchange-rates-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=exchange-rates-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXhjaGFuZ2UtcmF0ZXMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22exchange-rates-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fexchange-rates-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://exchange-rates.caseyjhand.com/mcp](https://exchange-rates.caseyjhand.com/mcp)

</div>

---

## Overview

ECB reference exchange rates via Frankfurter, covering ~30 currencies back to 1999. Convert amounts, disambiguate currency codes, pull point-in-time or historical rates, and run SQL over long time series. No API key required.

### Tools

| Tool | Description |
|:---|:---|
| `fx_list_currencies` | List all ~30 ECB-supported ISO 4217 currencies with full names |
| `fx_get_rates` | Snapshot of all rates for a base currency at latest or a historical date |
| `fx_get_rate` | Exchange rate for a single currency pair at latest or a historical date |
| `fx_convert_currency` | Convert an amount between two currencies at latest or a historical rate |
| `fx_get_timeseries` | Historical daily rates for a currency pair over a date range |
| `fx_dataframe_describe` | List DataCanvas tables and columns staged by a prior `fx_get_timeseries` call |
| `fx_dataframe_query` | Run a read-only SQL SELECT against a staged DataCanvas table |
| `fx_dataframe_drop` | Remove one staged DataCanvas table or view (opt-in, destructive) |

DataCanvas (DuckDB) is on by default. Set `CANVAS_PROVIDER_TYPE=none` to turn it off: the three `fx_dataframe_*` tools then drop out of `tools/list`, and `fx_get_timeseries` returns every range inline. The Claude Desktop bundle (`.mcpb`) ships without DuckDB's native binding, so it runs with DataCanvas off. `fx_dataframe_drop` additionally needs `FX_ENABLE_CANVAS_DROP=true`.

The four rate and conversion tools accept `base` as an alias of `base_currency`; pair tools also accept `quote` for `quote_currency`. Send either spelling for a field, never both. Advertised schemas use the canonical names.

### Resources

| Resource | Description |
|:---|:---|
| `fx://currencies` | All supported currencies as a stable reference document |
| `fx://rates/latest/{base}` | Latest rates snapshot for a base currency as a stable URI |

All resource data is also reachable via tools — use `fx_list_currencies` or `fx_get_rates` for programmatic access.

Cancelling a tool call or resource read stops its upstream fetch, response-body read, and retry backoff. Uncancelled requests retain two retries and a 10-second timeout per attempt.

## Capability reference

### `fx_list_currencies` <sub>tool</sub>

- No input parameters
- Returns `[{ code, name }]` for all ~30 ECB-scoped currencies, sorted alphabetically by code
- ECB coverage shifts as currencies enter or exit scope — call this to validate a user-supplied code rather than hard-coding a list

---

### `fx_get_rates` <sub>tool</sub>

- `base_currency` required; `date` optional (default latest, ECB data from 1999-01-04, no future dates); optional `symbols` array narrows the response and must name at least one code
- Returns a `rates` map (quote code → rate), the actual `rate_date`, and `date_snapped: true` when a weekend/holiday request snapped to the prior business day
- Naming the base currency in `symbols` is valid — answered locally with a rate of 1 rather than sent upstream
- Typed failures: `invalid_date_format`, `unsupported_currency`, `date_out_of_range`, `upstream_no_data`

---

### `fx_get_rate` <sub>tool</sub>

- `base_currency`, `quote_currency` required; `date` optional (default latest, ECB data from 1999-01-04, no future dates)
- Returns `rate`, `rate_date`, and `date_snapped: true` when a weekend/holiday request snapped to the prior business day
- Cross-rates (neither side EUR) triangulate through EUR in one upstream rate call; a same-currency pair returns 1, with its publication date obtained from an upstream proxy quote
- Typed failures: `invalid_date_format`, `unsupported_currency`, `date_out_of_range`, `upstream_no_data`

---

### `fx_convert_currency` <sub>tool</sub>

- `base_currency`, `quote_currency`, `amount` (must be > 0) required; `date` optional (default latest, ECB data from 1999-01-04, no future dates)
- Handles EUR↔any, any↔EUR, and cross-rate pairs (e.g. USD→JPY) in a single upstream call
- Returns `quote_amount` (rounded to 6 decimal places), `rate`, `rate_date`, `date_snapped`, plus `rate_type` and `source` provenance
- Typed failures: `invalid_date_format`, `unsupported_currency`, `date_out_of_range`, `upstream_no_data`

---

### `fx_get_timeseries` <sub>tool</sub>

- `base_currency`, `quote_currency`, `start_date`, `end_date` required (ECB data from 1999-01-04, no future dates, start ≤ end); optional `canvas_id` appends to an existing canvas
- Inline results page at 500 publication days — `rate_count` is always the range total; `truncated: true` plus `next_start_date` continue the page
- Ranges over `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` (default 90 days) are considered for DataCanvas staging. Series over the 40,000-character preview budget return `spilled: true`, `canvas_id`, and `table_name`; smaller series and deployments with `CANVAS_PROVIDER_TYPE=none` page inline
- A same-currency pair returns a rate of 1 on each real ECB publication day in range, not a synthetic Mon–Fri loop
- An empty range (only weekends/holidays) returns `rate_count: 0` with an explanatory `notice`, distinguishable from an error
- Long ranges that fit the inline preview release their newly acquired canvas; failed or cancelled staging does too. A supplied canvas remains available.

---

### `fx_dataframe_describe` <sub>tool</sub>

- `canvas_id` required (from a prior `fx_get_timeseries` call)
- Returns each staged table's `kind`, `row_count`, and column schema (`name`, `type`, `nullable`), plus `expires_at`
- Required first step before `fx_dataframe_query`; unregistered when `CANVAS_PROVIDER_TYPE=none`
- `canvas_not_found` when the ID doesn't exist or has expired

---

### `fx_dataframe_query` <sub>tool</sub>

- `canvas_id` and a read-only SQL `query` required; `row_limit` optional (1–10,000, default 150)
- Supports aggregations, GROUP BY, window functions, and JOINs across tables from multiple `fx_get_timeseries` calls
- Returns at most `row_limit` rows; `truncated: true` plus a `notice` give the `ORDER BY <column> LIMIT <n> OFFSET <m>` shape for the next page — ORDER BY is required for stable paging
- Markdown table cells are escaped so pipes, angle brackets, and line breaks stay inside their cell; `structuredContent` keeps raw values
- Unregistered when `CANVAS_PROVIDER_TYPE=none`; typed failures: `canvas_not_found`, `missing_table`, `invalid_query`

---

### `fx_dataframe_drop` <sub>tool</sub>

- `canvas_id` and exact `table_name` (from `fx_dataframe_describe`) required
- Removes one staged table or view; ECB rate data is untouched and the series can be re-staged via `fx_get_timeseries`
- Returns `dropped: true`/`false` depending on whether the table existed
- Disabled unless `FX_ENABLE_CANVAS_DROP=true` — otherwise absent from `tools/list`, named with its enable hint only in the startup log and the HTTP landing page; also unregistered when `CANVAS_PROVIDER_TYPE=none`

---

### `fx://currencies` <sub>resource</sub>

- No parameters; returns `currencies`, `count`, `source` as `application/json` — the same payload as `fx_list_currencies`
- Listed as a single static resource

---

### `fx://rates/latest/{base}` <sub>resource</sub>

- `base` is an ISO 4217 currency code in the URI
- Returns `base_currency`, `rate_date`, a `rates` map, `rate_type`, and `source` for the latest ECB fix
- Listed with four sample URIs (EUR, USD, GBP, JPY) as discovery hints

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ECB-specific:

- Keyless access via [Frankfurter](https://www.frankfurter.dev/) — a Cloudflare-fronted ECB proxy; no API keys required
- Cross-rate triangulation: any pair works — USD → JPY is one upstream call, cross-rated through EUR on Frankfurter's side
- Weekend/holiday date semantics: `date_snapped` surfaces when the API returns a different date than requested
- Identity rates are computed locally as 1; an upstream proxy quote supplies the actual publication dates for that currency
- Long time-series that exceed the inline preview budget stage on DataCanvas (DuckDB, on by default) for SQL aggregation over the full range

Agent-friendly output:

- Rate provenance on every response — `rate_type`, `source`, `rate_date`, and `date_snapped` so agents can reason about trust and freshness
- Structured error contracts — typed `reason` fields (`unsupported_currency`, `date_out_of_range`, `invalid_query`, …) let callers branch on failure type, not string parsing
- Bounded responses — inline time-series pages continue from `next_start_date`, and SQL results cap at `row_limit`, so no call returns an unbounded payload
- Success-path `notice` enrichment — explains an empty series, where to continue a paged series, or which tools read a staged one, so a legitimate zero-result never reads as a failure

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://exchange-rates.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "exchange-rates-mcp-server": {
      "type": "streamable-http",
      "url": "https://exchange-rates.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

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

DataCanvas (DuckDB) is on by default for long time-series SQL analytics. To turn it off — which also drops `fx_dataframe_describe` and `fx_dataframe_query` from `tools/list` and returns every `fx_get_timeseries` range inline — add `CANVAS_PROVIDER_TYPE=none`:

```json
{
  "mcpServers": {
    "exchange-rates-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/exchange-rates-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "CANVAS_PROVIDER_TYPE": "none"
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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` | Day range above which `fx_get_timeseries` considers DataCanvas staging; series that fit the preview remain inline. | `90` |
| `FX_ENABLE_CANVAS_DROP` | Enable the destructive `fx_dataframe_drop` tool. Off by default: the tool is not registered and is absent from `tools/list`. | `false` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. `duckdb` enables DataCanvas for `fx_get_timeseries` long-range spillover and registers the three `fx_dataframe_*` tools; `none` disables it and skips them from `tools/list`. An empty value takes the default. The `.mcpb` bundle sets `none`. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. The server declares `stateless` in code — no handler here asks the client for input mid-call, so nothing needs a session to resume — and setting this variable overrides that declaration. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_REQUEST_STATE_KEY` | Opt-in key (≥ 32 bytes, the same on every instance) that seals the `requestState` a handler returns between rounds. No tool here returns one. | — |
| `MCP_LOG_LEVEL` | Log level (RFC 5424: `debug`, `info`, `notice`, `warning`, `error`). Also the floor for logs mirrored to the client. | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result (redacted by key name only). | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Per-payload cap for `LOG_TOOL_FAILURE_PAYLOADS`, in UTF-8 bytes. | `16384` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL; traces go to `/v1/traces`, metrics to `/v1/metrics`. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log export (e.g. `http://localhost:4318/v1/logs`); the base endpoint never enables it. | — |

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/exchange-rates-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Production dependencies, DuckDB's native binding included, are cross-installed for the target platform in a separate `deps` stage, so multi-arch builds never run Bun under emulation and the runtime image carries only `node_modules` and `dist/`.

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
| `src/utils/` | Output helpers — Markdown table-cell escaping for `fx_dataframe_query`. |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
