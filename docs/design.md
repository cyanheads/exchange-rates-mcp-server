# exchange-rates-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fx_convert_currency` | Convert an amount between any two currencies at the latest or a historical rate. Returns the converted amount, rate used, rate date, and whether the date was snapped from a weekend/holiday. Cross-rates are triangulated through EUR automatically. The primary tool for agent-driven FX workflows. | `base_currency`, `quote_currency`, `amount`, `date?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `fx_get_rate` | Get the exchange rate for a currency pair on a date (default: latest). Returns the rate, the actual rate date (may differ from requested date on weekends/holidays), and source provenance. Use when the agent wants the rate number without doing a conversion. | `base_currency`, `quote_currency`, `date?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `fx_get_timeseries` | Inclusive daily series with full-range summary. Inline pages contain 500 observations; continue using next_start_date. Long ranges stage when the preview budget is exceeded. Explicit canvas_id always stages, including empty or short results. Every table has a unique suffix and retains prior registrations. | `base_currency`, `quote_currency`, `start_date`, `end_date`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `fx_get_rates` | All available rates for one base currency in a single snapshot (default: latest). Useful for bulk comparison and seeding downstream tools. Returns a map of quote currency → rate, the actual snapshot date, and `date_snapped`. `symbols`, when sent, must be non-empty. | `base_currency`, `date?`, `symbols?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `fx_list_currencies` | Current discovery with full names, count, source and as_of, the latest served daily rate date. Historical availability is checked against historical responses. Cached for a day. | *(none)* | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `fx_dataframe_describe` | List DataCanvas tables and columns from a prior `fx_get_timeseries` call that returned a `canvas_id`. Required first step before `fx_dataframe_query`. | `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fx_dataframe_query` | Run a SQL SELECT against a DataCanvas table produced by `fx_get_timeseries`. Supports aggregations, GROUP BY, and JOINs across multiple registered tables. Returns at most `row_limit` rows (default 150, max 10,000) on both surfaces; a truncated result carries a `notice` with the `ORDER BY … LIMIT … OFFSET …` paging shape. Markdown table cells are escaped. | `canvas_id`, `query`, `row_limit?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fx_dataframe_drop` | Permanently remove one staged table or view from a DataCanvas. Deletes staged analytical data only; upstream rate data is untouched and the series can be re-staged. Opt-in via `FX_ENABLE_CANVAS_DROP`; registered with `disabledTool()` while the flag is off. | `canvas_id`, `table_name` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false` |

### Error Contracts

`base` aliases `base_currency` on all four currency-input tools; `quote` aliases `quote_currency` on the three pair tools. Definition-level `inputAliases` preserves values and canonical advertised schemas. The framework rejects alias/canonical collisions instead of choosing a value.

Domain failures to declare as `errors: [{ reason, code, when }]` on each tool. Baseline errors (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`) bubble automatically and are not listed.

| Tool | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `fx_convert_currency` | `invalid_date_format` | `ValidationError` | `date` is not a real calendar date written as YYYY-MM-DD |
| `fx_convert_currency` | `unsupported_currency` | `ValidationError` | `base_currency` or `quote_currency` is not available in current discovery or the served historical data |
| `fx_convert_currency` | `date_out_of_range` | `ValidationError` | `date` is before 1999-01-04 or in the future |
| `fx_convert_currency` | `upstream_no_data` | `NotFound` | Every currency is supported but Frankfurter v1 returned no rates for this date |
| `fx_get_rate` | `invalid_date_format` | `ValidationError` | `date` is not a real calendar date written as YYYY-MM-DD |
| `fx_get_rate` | `unsupported_currency` | `ValidationError` | `base_currency` or `quote_currency` is not available in current discovery or the served historical data |
| `fx_get_rate` | `date_out_of_range` | `ValidationError` | `date` is before 1999-01-04 or in the future |
| `fx_get_rate` | `upstream_no_data` | `NotFound` | Every currency is supported but Frankfurter v1 returned no rates for this date |
| `fx_get_rates` | `invalid_date_format` | `ValidationError` | `date` is not a real calendar date written as YYYY-MM-DD |
| `fx_get_rates` | `unsupported_currency` | `ValidationError` | `base_currency` or an entry in `symbols` is not available in current discovery or the served historical data |
| `fx_get_rates` | `date_out_of_range` | `ValidationError` | `date` is before 1999-01-04 or in the future |
| `fx_get_rates` | `upstream_no_data` | `NotFound` | Every currency is supported but Frankfurter v1 returned no rates for this date |
| `fx_get_timeseries` | `invalid_date_format` | `ValidationError` | `start_date` or `end_date` is not a real calendar date written as YYYY-MM-DD |
| `fx_get_timeseries` | `unsupported_currency` | `ValidationError` | `base_currency` or `quote_currency` is not available in current discovery or the served historical data |
| `fx_get_timeseries` | `date_out_of_range` | `ValidationError` | `start_date` is before 1999-01-04 or `end_date` is in the future |
| `fx_get_timeseries` | `invalid_range` | `ValidationError` | `start_date` is after `end_date` |
| `fx_get_timeseries` | `upstream_no_data` | `NotFound` | Every currency is supported but Frankfurter v1 returned no rates for this range |
| `fx_get_timeseries` | `canvas_not_found` | `NotFound` | An explicit canvas ID does not exist or has expired |
| `fx_get_timeseries` | `canvas_unavailable` | `ServiceUnavailable` | An explicit canvas ID requests staging with DataCanvas disabled |
| `fx_dataframe_describe` | `canvas_not_found` | `NotFound` | `canvas_id` does not exist or has been evicted |
| `fx_dataframe_query` | `canvas_not_found` | `NotFound` | `canvas_id` does not exist or has been evicted |
| `fx_dataframe_query` | `missing_table` | `NotFound` | The SQL references a table that is not staged on this canvas, or whose TTL expired |
| `fx_dataframe_query` | `invalid_query` | `ValidationError` | SQL is not a SELECT, references unknown tables/columns, or has a syntax error |
| `fx_dataframe_drop` | `canvas_not_found` | `NotFound` | `canvas_id` does not exist or has been evicted |
| `fx_dataframe_drop` | `canvas_unavailable` | `ServiceUnavailable` | DataCanvas is not configured on this deployment |

Every `unsupported_currency` rejection names the input `field` and sorted `accepted_codes` and `rejected_codes`. Latest requests validate against current discovery; historical requests use the union of currencies in raw served EUR data before inclusive clipping. Retired currencies remain available on their observation dates. A currently supported currency absent from historical data is `upstream_no_data`; an unknown code is `unsupported_currency`. No historical currency already returned by an unfiltered snapshot is removed.

Schema-level argument rejections include empty `symbols`, non-positive `amount`, and non-positive, fractional or nonnumeric `row_limit`. Positive integral row limits above 10,000 are accepted and clamped with a notice naming requested/effective values; truncation notices compose with it and SQL paging uses the effective limit. Currency values are trimmed and uppercased. Date patterns are JSON Schema metadata, leaving malformed/blank/impossible calendar dates to typed `invalid_date_format` validation. Point dates allow literal `latest`; required range dates do not. Future-range recovery recommends end_date today or earlier, never omission.

Recovery hints: `unsupported_currency` → "Call `fx_list_currencies` to get valid codes"; `invalid_date_format` → "Pass an ISO 8601 calendar date in YYYY-MM-DD form"; `date_out_of_range` → "History starts 1999-01-04; omit `date` for latest"; `upstream_no_data` → "Try a more recent date — history starts later for some currencies"; `missing_table` → "Call `fx_dataframe_describe` to list the staged tables"; `canvas_not_found` → "Re-run `fx_get_timeseries` to obtain a fresh `canvas_id`" for reads, or "This canvas is absent or expired; no cleanup is needed" for drop; `invalid_query` → "Run `fx_dataframe_describe` first to verify table and column names"; `canvas_unavailable` → "Set `CANVAS_PROVIDER_TYPE=duckdb` to enable DataCanvas".

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `fx://currencies` | All supported currencies as a stable reference document. Injectable context for clients that support resources. | None — bounded list (~30 entries) |
| `fx://rates/latest/{base}` | Latest rates snapshot for a base currency as a stable URI. | None |

### Prompts

*(none — purely data/action-oriented server)*

---

## Overview

Daily FX rates and currency conversion from Frankfurter v1 (`api.frankfurter.dev/v1`), keyless with history from 1999-01-04. Current discovery and historical availability are separate: historical snapshots include retired currencies absent from today's list.

Every rate response identifies `source: "Frankfurter v1"` and `rate_type: "Daily rate (Frankfurter v1)"`. The payload does not identify individual providers, so the server makes no ECB-only or provider-specific claim. Daily observations are not intraday quotes or tradeable bid/ask prices.

Pair rates use local division of same-date EUR legs, avoiding rounded upstream cross-rates. Point tools flag upstream-snapped dates; ranges retain only observations inside the inclusive requested window.

Fills a fleet gap: `coingecko` is crypto, `finnhub` is equities. This is the fiat FX leg. Composes naturally with both: multi-asset portfolio valuation needs all three.

---

## Requirements

- Convert any amount between any two supported currencies at latest or historical rates
- Cross-rate triangulation: any pair works, not just EUR-base pairs
- Historical coverage: 1999-01-04 through the latest served daily snapshot; availability varies by currency
- Time-series retrieval for charting, trend analysis, and rate comparison
- Date semantics: when a requested date has no fix (weekend, holiday), document the actual rate date returned — never silently snap without surfacing it
- Rate provenance in every response: `source`, `rate_date`, `rate_type`
- `fx_list_currencies` for disambiguation before conversion
- DataCanvas integration on `fx_get_timeseries` for ranges >90 days or analytical workflows
- No API key required (Frankfurter is keyless)
- All tools read-only — no writes, no auth scopes needed
- Rate provenance identifies Frankfurter v1 without inferring individual providers

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `FrankfurterService` | Frankfurter API (`https://api.frankfurter.dev/v1`) | Five rate/currency tools and both resources |

Caller cancellation flows through currency validation, fetch, response-body consumption, and retry backoff. Each attempt composes the caller signal with the existing 10-second timeout; the retry policy remains two retries with no separate total deadline. Currency loads are independent in flight, and only completed, uncancelled loads populate the day-long cache.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `FRANKFURTER_BASE_URL` | No | Override Frankfurter base URL. Default: `https://api.frankfurter.dev/v1`. Useful for local testing or self-hosted Frankfurter. |
| `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` | No | Day-count threshold for automatic DataCanvas staging; without `canvas_id`, series within the preview budget remain inline. Explicit `canvas_id` always requests staging. Default: `90`. |
| `FX_ENABLE_CANVAS_DROP` | No | Opt in to staged-table deletion. Default: `false`. Registration reads this field non-throwingly with its schema; setup validates the full server config. |

No API keys required.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema for env vars above
2. **FrankfurterService** — init/accessor, typed response shapes, retry wrapper, abortable fetch with per-attempt timeout, error classification
3. **`fx_list_currencies`** — simplest tool; confirms service wiring
4. **`fx_get_rates`** — bulk snapshot; validates `base` + `symbols` filtering logic
5. **`fx_get_rate`** — single pair; validates cross-rate math + date-snap detection
6. **`fx_convert_currency`** — builds on `fx_get_rate`; adds amount multiplication + snapped-date flag
7. **`fx_get_timeseries`** — date range; DataCanvas integration for long ranges
8. **`fx_dataframe_describe` + `fx_dataframe_query`** — paired canvas tools
9. **Resources** — `fx://currencies`, `fx://rates/latest/{base}`

Each step is independently testable.

---

## Domain Mapping

| Noun | Operations → Tools |
|:-----|:-------------------|
| Currency | list (→ `fx_list_currencies`), validate-code-inline |
| Rate (point-in-time) | get-for-pair (→ `fx_get_rate`), get-all-for-base (→ `fx_get_rates`) |
| Conversion | convert-amount (→ `fx_convert_currency`) |
| Rate series | get-range (→ `fx_get_timeseries`), query-series (→ `fx_dataframe_query`) |

---

## Workflow Analysis

**`fx_convert_currency`** (one rate call, plus a currency-list fetch on a cold cache):

| # | Call | Purpose | Note |
|:--|:-----|:--------|:-----|
| 1 | `GET /v1/{date}?base=EUR` | Fetch all EUR legs and historical membership | `latest` if no date given |
| — | *(no extra call)* | Divide quote leg by base leg locally; EUR = 1 | No intermediate rounding |

**`fx_get_timeseries`** (one range call, a currency-list fetch on a cold cache, and optional canvas registration):

| # | Call | Purpose | Note |
|:--|:-----|:--------|:-----|
| 1 | `GET /v1/{start}..{end}?base=EUR` | Fetch the full unfiltered EUR range | Same-date legs and raw served membership from one response |
| 2 | Canvas register | Register rows as a DuckDB table | Explicit canvas_id always stages; otherwise day count > threshold (~90) and rows exceed the preview budget |

Output includes `base_currency`, `quote_currency`, clipped `start_date`/`end_date` (requested bounds when empty), `rates`, full-range `rate_count`, optional full-range `summary`, `truncated`, optional inline `next_start_date`, `rate_type`, `source` and `spilled`. Staged results also return `canvas_id`, the actual unique `table_name`, and a notice naming `fx_dataframe_describe` then `fx_dataframe_query`. `truncated` is true only when the preview omits observations; complete short/empty explicit previews are false.

**`fx_dataframe_query`** output schema: `rows` (at most the effective `row_limit`), `row_count` (length of `rows`), `truncated` (the query produced more than the effective limit), `canvas_id`, and a `notice` when clamped or truncated. Clamp notices name requested/effective values; truncation notices give the `ORDER BY <column> LIMIT <n> OFFSET <m>` shape for the next page.

---

## Design Decisions

**Local EUR-leg calculation.** Pair, conversion, bulk, resource and series surfaces divide quote leg by base leg from one unfiltered EUR response. This avoids Frankfurter v1's cross-rate rounding. EUR's leg is 1; other legs must coexist on each emitted date. Identity pairs use real availability and return 1.

**One rate-data call per snapshot or range.** The unfiltered response supplies calculation and historical membership. Latest validation uses cached `/currencies`. Discovery tools/resources add `as_of` from a latest EUR snapshot, cached for a day; callers receive copied currency records and cancelled loads never poison another caller's cache.

**Ranges clip after historical membership validation.** Raw served dates prove availability, including an upstream-snapped date before a weekend-only request. Only observations inside the inclusive requested window are emitted. Point tools expose the actual rate date and date_snapped.

**`symbols` optional on `fx_get_rates`.** Omission returns every available quote currency except the base; an explicit filter returns only those currencies, including identity when requested. Historical filtered and unfiltered membership uses the same snapshot.

**No amount param threading into `fx_get_rate`.** The idea spec draws a clean line: `fx_get_rate` is "what is the rate?", `fx_convert_currency` is "how much do I get?". Conflating them (as the Frankfurter `amount` param allows) would make `fx_get_rate` a fuzzy alias of `fx_convert_currency`. The tools stay focused.

**Inline time-series pages continue from `start_date`, not an offset or cursor.** Rows are keyed by publication date and the tool already takes `start_date`, so returning the first unreturned date as `next_start_date` makes paging deterministic with no new input, and a continuation can never drift onto the wrong series the way a stale offset can. The 500-day page is ~21 KB serialized across both surfaces; `rate_count` stays the total for the range each call requested.

**`fx_dataframe_query` defaults `row_limit` to 150.** Every returned row renders on both surfaces — about 125 B/row serialized for the staged `date`/`rate` table — so 150 rows measure ~19 KB on the wire, inside the framework's 24 KB outline budget, where 200 rows measure ~25 KB. The 10,000 maximum is DataCanvas's own materialization ceiling, so raising the limit never exceeds what an unbounded query returned before.

**Automatic and explicit staging.** Without canvas_id, the 90-day threshold and 40,000-character preview budget govern staging and inline-fit acquisitions are released. Explicit canvas_id bypasses both decisions and registers directly with a declared schema, including empty results and rate DOUBLE. Every registration uses a fresh identifier suffix rather than replacing an older pair table; repeated and concurrent registrations retain each handle. Unknown explicit IDs fail canvas_not_found and disabled staging fails canvas_unavailable. Cleanup only targets the attempted new table or a newly acquired unused canvas.

**Full-range statistics precede delivery.** Compute optional summary once over all clipped rows before previewing, paging or staging. It contains mean, min/max/first/last rate/date pairs, and change_pct = (last − first) / first × 100. Equal extrema select the earliest date. Empty results omit summary; singletons and identities have zero movement. A continuation summarizes its own shorter requested interval. The mean is an unweighted arithmetic average of daily observations, not a tax-authority or accounting-policy prescription. Both response surfaces render every statistic and date, and staging notices distinguish complete short/empty previews from partial previews.

**Canvas cleanup follows acquisition ownership.** An inline-fit result, staging failure, or cancellation releases a newly acquired canvas because no usable handle reaches the caller. A successful spill retains it, and a supplied existing canvas is never dropped by this cleanup.

**DataCanvas on by default, except in the MCPB bundle.** `src/index.ts` sets `CANVAS_PROVIDER_TYPE` to `duckdb` when it is unset or empty, after the framework loads `.env`, so npm, Docker, and plugin installs get SQL over long series without configuration and `none` still opts out. The bundle strips DuckDB's native binding to stay portable, so `manifest.json` pins `none`: it starts cleanly and pages long ranges inline instead of failing on the first spill.

**Direct API retrieval.** Frankfurter v1 supplies one unfiltered EUR response per snapshot or range. A separate mirror would add storage and synchronization without serving a required workflow.

**Truthful v1 provenance.** Every rate-bearing response carries `rate_type: "Daily rate (Frankfurter v1)"` and `source: "Frankfurter v1"`, without inventing provider attribution.

**`fx_list_currencies` as a plain array, not a map.** Returning `[{ code, name }]` rather than `{ USD: "United States Dollar" }` makes it naturally sortable in `format()` and easier for agents to iterate or filter for display. The Frankfurter `/currencies` endpoint returns a flat object, so the service normalizes to an array.

---

## Known Limitations

- **Frankfurter v1 coverage only.** Current discovery describes today's currencies; historical availability comes from historical responses. No v2 or provider integration is used.
- **Daily observations only.** No intraday or tick data; latest means the latest served publication date.
- **Historical start: 1999-01-04.** Dates before that return `{"message":"not found"}`.
- **No provider attribution in v1 payloads.** Source remains literally Frankfurter v1; no provider-specific or tradeable-price claim is inferred.
- **BGN was present in 2024 data but absent in 2026 data.** The currency set can change over time as currencies enter/exit ECB scope; `fx_list_currencies` reflects the current set.

---

## API Reference

**Base URL:** `https://api.frankfurter.dev/v1`

| Endpoint | Params | Notes |
|:---------|:-------|:------|
| `GET /currencies` | — | Returns `{ code: name }` map |
| `GET /latest` | `base`, `symbols`, `amount` | Returns latest fix. `date` in response = actual rate date. |
| `GET /{date}` | `base`, `symbols`, `amount` | Date format: `YYYY-MM-DD`. Weekend/holiday snaps silently to prior business day. |
| `GET /{start}..{end}` | `base`, `symbols`, `amount` | Range query. `rates` keyed by date string (business days only). |

**Error shape:** `{ "message": "not found" }` — flat, no code field. HTTP 200 on valid requests; 4xx on malformed routes.

**Weekend/holiday behavior:** Querying a Saturday returns the Friday rate but with `"date": "YYYY-MM-DD"` set to Friday — the API does not indicate the snap. The server detects this by comparing requested date vs returned date.

**Rate limits:** Not documented; Cloudflare-fronted. Observed < 200ms per call. Cache headers: `Cache-Control: public, max-age=86400` on latest; no caching on historical.
