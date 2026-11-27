<div align="center">
  <h1>@cyanheads/exchange-rates-mcp-server</h1>
  <p><b>Query daily Frankfurter rates and convert currencies using fixed euro adoption rates. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Opt-in Tool • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/exchange-rates-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/exchange-rates-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/exchange-rates-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Market rates come from Frankfurter v1, with observations from 1999-01-04. On its official configuration the server also converts 21 former euro-area currencies at irrevocable rates from each adoption date. For example, a BGN/USD conversion on 2026-03-02 uses 1.95583 BGN per EUR and that day’s USD observation. No API key is required.

### Tools

| Tool | Description |
|:---|:---|
| `fx_list_currencies` | Current currency discovery with full names and the latest served rate date |
| `fx_get_rates` | Snapshot of all rates for a base currency at latest or a historical date |
| `fx_get_rate` | Exchange rate for a single currency pair at latest or a historical date |
| `fx_convert_currency` | Convert an amount between two currencies at latest or a historical rate |
| `fx_get_timeseries` | Historical daily rates for a currency pair over a date range |
| `fx_dataframe_describe` | List DataCanvas tables and columns staged by a prior `fx_get_timeseries` call |
| `fx_dataframe_query` | Run a read-only SQL SELECT against a staged DataCanvas table |
| `fx_dataframe_drop` | Remove one staged DataCanvas table or view (opt-in, destructive) |

DataCanvas (DuckDB) is on by default. Set `CANVAS_PROVIDER_TYPE=none` to turn it off: the three `fx_dataframe_*` tools then drop out of `tools/list`, and `fx_get_timeseries` returns ranges inline when `canvas_id` and `stage` are omitted; explicit staging (`canvas_id` or `stage: true`) fails `canvas_unavailable`. The Claude Desktop bundle (`.mcpb`) ships without DuckDB's native binding, so it runs with DataCanvas off. `fx_dataframe_drop` additionally needs `FX_ENABLE_CANVAS_DROP=true`.

The four rate tools accept `base`. Pair tools also accept `quote`, `from_currency` and `to_currency`. For `fx_get_rate` and `fx_convert_currency`, `from` and `to` identify the currencies. `symbol` is a quote alias on `fx_get_rate` and `fx_get_timeseries`. Supply one spelling per field. The advertised schemas use canonical names.

Currency values, including `symbols`, are trimmed and uppercased. Point dates accept `YYYY-MM-DD` or `latest`. Ranges require both ISO dates. Malformed calendar dates return `invalid_date_format`. Historical official rates in RON before 2005-07-01 and TRY before 2005-01-01 use restated units. Convert old amounts first. 10,000 ROL equals 1 RON and 1,000,000 TRL equals 1 TRY.

### Resources

| Resource | Description |
|:---|:---|
| `fx://currencies` | Current Frankfurter currencies as a stable reference document |
| `fx://rates/latest/{base}` | Latest rates snapshot for a base currency as a stable URI |

All resource data is also reachable via tools — use `fx_list_currencies` or `fx_get_rates` for programmatic access.

### Skill

[`exchange-rates-guide`](skills/exchange-rates-guide/SKILL.md) covers historical currency coverage, observed-day summaries, paging and SQL comparisons. It ships with npm, Docker and MCPB installs and is available over MCP at `skill://exchange-rates-guide/SKILL.md`.

Cancelling a tool call or resource read stops its upstream fetch, response-body read, and retry backoff. V1 requests retain two retries and a 10-second timeout per attempt within a 12-second total budget per read. Optional coverage metadata gets one 1-second request without retries.

## Capability reference

### `fx_list_currencies` <sub>tool</sub>

- Optional `include_retired` (default `false`) adds historical codes absent from current v1 discovery; the rows it appends carry `retired: true`
- Each currency has a code, name and `retired` flag. Optional ECB start and end dates describe outer bounds that can contain gaps. Discovery also returns `count`, `source` and `as_of`, the latest served market date.
- Metadata is cached for a day (a failed read is retried after five minutes) and queried only for the default official v1 base. Unavailable metadata leaves current discovery intact with a notice; valid v1 rate requests never depend on metadata.
- With `include_retired: true`, each statutory currency has `adoption_date` and `units_per_eur`. The response names their legal source in `fixed_rate_source`. These factors are available even when optional ECB market coverage metadata is unavailable.

---

### `fx_get_rates` <sub>tool</sub>

- `base_currency` required; `date` optional (default latest, market history from 1999-01-04, no future dates); optional `symbols` array narrows the response and must name at least one code
- Returns a `rates` map (quote code → rate), the actual `rate_date`, and `date_snapped: true` when a weekend, a holiday, or a day whose fix is not yet published snapped to the prior published date
- Naming the base currency in `symbols` is valid — answered locally with a rate of 1 rather than sent upstream
- Missing observations from a served snapshot identify the offending `field` and sorted, deduplicated `missing_codes`, plus `currency_windows` and a sentence naming the bound (coverage begins or ends, or a date or range inside the bounds that can contain gaps) when ECB coverage metadata is available; unknown currencies retain `unsupported_currency` precedence. A response without any snapshot remains an unattributed `upstream_no_data` failure.
- Typed failures: `invalid_date_format`, `unsupported_currency`, `date_out_of_range`, `upstream_no_data`

---

### `fx_get_rate` <sub>tool</sub>

- `base_currency`, `quote_currency` required; `date` optional (default latest, market history from 1999-01-04, no future dates)
- Returns `rate`, `rate_date`, and `date_snapped: true` when a weekend, a holiday, or a day whose fix is not yet published snapped to the prior published date
- Rates divide the quote EUR leg by the base EUR leg without intermediate rounding. A statutory-only pair resolves locally, including an identity pair. A market leg requires a published observation.
- Typed failures: `invalid_date_format`, `unsupported_currency`, `date_out_of_range`, `upstream_no_data`

---

### `fx_convert_currency` <sub>tool</sub>

- `base_currency`, `quote_currency`, `amount` (must be > 0) required; `date` optional (default latest, market history from 1999-01-04, no future dates)
- A mixed conversion combines the market publication with the statutory factor effective on the requested date. `fixed_rates` identifies each affected leg. When the two dates differ, `fixed_rate_date` distinguishes the statutory date from `rate_date`. A fully fixed conversion uses the requested date (today in UTC for `latest`) and needs no upstream call.
- Returns `quote_amount`, `rate`, `rate_date`, `date_snapped`, `rate_type` and `source`. Market conversions use `amount * rate`. Statutory cross-conversions divide by the base units per EUR and multiply by the quote units per EUR. They use `amount * rate` when the EUR intermediate overflows, rounds to zero, or is subnormal. Payment rounding is left to the caller.
- Typed failures include `invalid_date_format`, `unsupported_currency`, `date_out_of_range`, `upstream_no_data` and `amount_out_of_range`. The last indicates the converted amount exceeds the numeric range.

---

### `fx_get_timeseries` <sub>tool</sub>

- `base_currency`, `quote_currency`, `start_date`, `end_date` required (market history from 1999-01-04, no future dates, start ≤ end); optional `canvas_id` appends to an existing canvas
- Optional `stage` (default `false`): `true` stages the complete series on a new canvas whose `canvas_id` is returned, even for short or empty ranges. To stage another series beside it, pass that `canvas_id` rather than `stage: true` again, since `fx_dataframe_query` reads one canvas at a time. `canvas_id` always stages, whatever `stage` says.
- Optional integer `limit` (default 500, minimum 0) bounds returned observations, clamping values above 500 with a notice. `limit: 0` returns summary and metadata with empty `rates`; a nonempty inline result then points `next_start_date` at the first observation. Repeat with a positive limit to advance. Counts, summary, bounds, staging eligibility and complete staged tables are independent of the limit.
- Inline results page at up to 500 observations — `rate_count` is always the range total; `truncated: true` plus `next_start_date` continue the page
- Ranges over `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` (default 90 days) are considered for DataCanvas staging. Series over the 40,000-character preview budget return `spilled: true`, `canvas_id`, and `table_name`; smaller series and deployments with `CANVAS_PROVIDER_TYPE=none` page inline
- Market series follow served publication dates. A pair of wholly fixed legs has one rate per calendar day from adoption. Series that cross an adoption date can contain both kinds of observation. For affected staged tables, the `source` column identifies the provenance of each row.
- A coverage notice names the missing currencies, counts each affected publication day once, and gives first/last affected dates. Where available it adds each currency’s ECB coverage bounds. Paging and staging preserve that notice.
- An empty range (weekends, holidays, a fix not yet published, or currency gaps) returns `rate_count: 0` with an explanatory `notice`, distinguishable from an error
- Whether a long range overflows the preview is measured before any canvas is acquired, so a series that fits inline never acquires one (pending cyanheads/mcp-ts-core#501); a failed or cancelled staging call releases the canvas it acquired. A supplied canvas remains available.
- An explicit `canvas_id` or `stage: true` always stages the complete result, including short and empty ranges, using `rate DOUBLE`. Each table name has a fresh identifier suffix; repeated and concurrent calls preserve all earlier tables. Unknown IDs fail `canvas_not_found`, whose recovery names `stage: true`; disabled DataCanvas fails `canvas_unavailable`. `truncated` is false when the preview includes every observation.
- Nonempty results include `summary: { mean, min: { rate, date }, max: { rate, date }, first: { rate, date }, last: { rate, date }, change_pct }`. It covers all observations in the requested interval before paging or staging; a continuation summarizes its shorter requested interval. Tied extrema select the earliest date; singleton and identity movement is 0. Empty series omit summary. Mean is the unweighted arithmetic average of daily observations, not a tax-authority or accounting-policy prescription.

---

### `fx_dataframe_describe` <sub>tool</sub>

- `canvas_id` required (from a prior `fx_get_timeseries` call)
- Returns each staged table's `kind`, `row_count`, and column schema (`name`, `type`, `nullable`), plus `expires_at`
- Required first step before `fx_dataframe_query`; unregistered when `CANVAS_PROVIDER_TYPE=none`
- `canvas_not_found` when the ID doesn't exist or has expired

---

### `fx_dataframe_query` <sub>tool</sub>

- `canvas_id` and a read-only SQL `query` required; `row_limit` is a positive integer (default 150). Values above the canvas row cap (`CANVAS_DEFAULT_ROW_LIMIT`, 10,000 by default) clamp to it, the default 150 included, with requested/effective values in a notice; clamping and truncation notices coexist and paging guidance uses the effective limit.
- Supports aggregations, GROUP BY, window functions, and JOINs across tables from multiple `fx_get_timeseries` calls
- Returns at most `row_limit` rows; `truncated: true` plus a `notice` give the `ORDER BY <column> LIMIT <n> OFFSET <m>` shape for the next page — ORDER BY is required for stable paging
- Nested SQL results (STRUCT, MAP and LIST) render as JSON in Markdown cells. Table escaping preserves embedded pipes and markup. SQL NULL renders as an empty cell. In DuckDB 2, integer `//` or `%` by zero returns `invalid_query`. Use `TRY(expression)` for SQL NULL.
- Unregistered when `CANVAS_PROVIDER_TYPE=none`; typed failures: `canvas_not_found`, `missing_table`, `invalid_query`

---

### `fx_dataframe_drop` <sub>tool</sub>

- `canvas_id` and exact `table_name` (from `fx_dataframe_describe`) required
- Removes one staged table or view; upstream rate data is untouched and the series can be re-staged via `fx_get_timeseries`
- Returns `dropped: true`/`false` depending on whether the table existed
- Disabled unless `FX_ENABLE_CANVAS_DROP=true` — otherwise absent from `tools/list`, named with its enable hint only in the startup log and the HTTP landing page; also unregistered when `CANVAS_PROVIDER_TYPE=none`

---

### `fx://currencies` <sub>resource</sub>

- No parameters; returns current discovery with optional coverage dates, `count`, `source`, `as_of` and any metadata-unavailability notice as `application/json`. Use `fx_list_currencies` with `include_retired: true` for historical discovery.
- Listed as a single static resource

---

### `fx://rates/latest/{base}` <sub>resource</sub>

- `base` is an ISO 4217 currency code in the URI
- Returns `base_currency`, `rate_date`, a `rates` map, `rate_type`, and `source` for the latest served daily snapshot
- Listed with four sample URIs (EUR, USD, GBP, JPY) as discovery hints

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Rate data:

- Keyless daily data via [Frankfurter v1](https://www.frankfurter.dev/v1/)
- Market cross-rates share one unfiltered EUR snapshot or range. Statutory-only calls resolve locally.
- Date-snap semantics: `date_snapped` surfaces when the API returns a different date than requested, whether the day was a weekend, a holiday, or a day whose fix is not yet published
- A market identity returns 1 on observed publication dates. A wholly statutory identity returns 1 on calendar dates from adoption.
- Long time-series that exceed the inline preview budget stage on DataCanvas (DuckDB, on by default) for SQL aggregation over the full range

Agent-friendly output:

- Rate provenance on every rate response — `rate_type` and `source`, plus `rate_date` and `date_snapped` on point lookups, so agents can reason about trust and freshness
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

DataCanvas (DuckDB) is on by default for long time-series SQL analytics. To turn it off, add `CANVAS_PROVIDER_TYPE=none`: the dataframe tools drop out of `tools/list`, and `fx_get_timeseries` pages inline when `canvas_id` and `stage` are omitted. Explicit staging (`canvas_id` or `stage: true`) fails `canvas_unavailable`.

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

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).
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
| `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` | Day range above which `fx_get_timeseries` considers automatic DataCanvas staging; without `canvas_id` or `stage: true`, series that fit the preview remain inline. Explicit `canvas_id` or `stage: true` always requests staging. | `90` |
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/exchange-rates-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them. Production dependencies, DuckDB's native binding included, are cross-installed for the target platform in a separate `deps` stage, so multi-arch builds never run Bun under emulation and the runtime image carries `node_modules/`, `dist/` and the published `skills/` tree.

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
| `skills/` | Published agent guidance for historical FX analysis. |
| `docs/` | Design document and idea notes. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- Preserve the origin of every rate in `rate_type` and `source`, including calculations that combine a statutory factor with a market observation.

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
