# exchange-rates-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fx_convert_currency` | Convert an amount between any two currencies at the latest or a historical rate. Returns the converted amount, rate used, rate date, and whether the date was snapped from a weekend/holiday. Cross-rates are triangulated through EUR automatically. The primary tool for agent-driven FX workflows. | `base_currency`, `quote_currency`, `amount`, `date?` | `readOnlyHint: true`, `idempotentHint: true` |
| `fx_get_rate` | Get the exchange rate for a currency pair on a date (default: latest). Returns the rate, the actual rate date (may differ from requested date on weekends/holidays), and source provenance. Use when the agent wants the rate number without doing a conversion. | `base_currency`, `quote_currency`, `date?` | `readOnlyHint: true`, `idempotentHint: true` |
| `fx_get_timeseries` | Historical daily rates for a currency pair over a date range. Returns a date-keyed series for trend analysis or charting. Long ranges (>90 days) spill to DataCanvas. ECB publishes on business days only — weekends and holidays produce no entry (not snapped). | `base_currency`, `quote_currency`, `start_date`, `end_date`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true` |
| `fx_get_rates` | All available rates for one base currency in a single snapshot (default: latest). Useful for bulk comparison and seeding downstream tools. Returns a map of quote currency → rate plus the snapshot date. | `base_currency`, `date?`, `symbols?` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fx_list_currencies` | All supported ISO 4217 currency codes with their full names. Use before converting to disambiguate "dollars" (USD vs AUD vs CAD vs HKD vs SGD) or to validate user-supplied codes. | *(none)* | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fx_dataframe_describe` | List DataCanvas tables and columns from a prior `fx_get_timeseries` call that returned a `canvas_id`. Required first step before `fx_dataframe_query`. | `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fx_dataframe_query` | Run a SQL SELECT against a DataCanvas table produced by `fx_get_timeseries`. Supports aggregations, GROUP BY, and JOINs across multiple registered tables. | `canvas_id`, `query` | `readOnlyHint: true`, `openWorldHint: false` |

### Error Contracts

Domain failures to declare as `errors: [{ reason, code, when }]` on each tool. Baseline errors (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`) bubble automatically and are not listed.

| Tool | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `fx_convert_currency` | `unsupported_currency` | `InvalidParams` | `base_currency` or `quote_currency` is not in the ECB currency set |
| `fx_convert_currency` | `date_out_of_range` | `InvalidParams` | `date` is before 1999-01-04 or in the future |
| `fx_get_rate` | `unsupported_currency` | `InvalidParams` | `base_currency` or `quote_currency` is not in the ECB currency set |
| `fx_get_rate` | `date_out_of_range` | `InvalidParams` | `date` is before 1999-01-04 or in the future |
| `fx_get_rates` | `unsupported_currency` | `InvalidParams` | `base_currency` is not in the ECB currency set |
| `fx_get_rates` | `date_out_of_range` | `InvalidParams` | `date` is before 1999-01-04 or in the future |
| `fx_get_timeseries` | `unsupported_currency` | `InvalidParams` | `base_currency` or `quote_currency` is not in the ECB currency set |
| `fx_get_timeseries` | `date_out_of_range` | `InvalidParams` | `start_date` is before 1999-01-04 or `end_date` is in the future |
| `fx_get_timeseries` | `invalid_range` | `InvalidParams` | `start_date` is after `end_date` |
| `fx_dataframe_describe` | `canvas_not_found` | `NotFound` | `canvas_id` does not exist or has been evicted |
| `fx_dataframe_query` | `canvas_not_found` | `NotFound` | `canvas_id` does not exist or has been evicted |
| `fx_dataframe_query` | `invalid_query` | `InvalidParams` | SQL is not a SELECT, references unknown tables/columns, or has a syntax error |

Recovery hints: `unsupported_currency` → "Call `fx_list_currencies` to get valid codes"; `date_out_of_range` → "ECB data starts 1999-01-04; omit `date` for latest"; `canvas_not_found` → "Re-run `fx_get_timeseries` to obtain a fresh `canvas_id`"; `invalid_query` → "Run `fx_dataframe_describe` first to verify table and column names".

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `fx://currencies` | All supported currencies as a stable reference document. Injectable context for clients that support resources. | None — bounded list (~30 entries) |
| `fx://rates/latest/{base}` | Latest rates snapshot for a base currency as a stable URI. | None |

### Prompts

*(none — purely data/action-oriented server)*

---

## Overview

FX rates and currency conversion anchored on European Central Bank (ECB) reference data, exposed via Frankfurter (`api.frankfurter.dev`) — a keyless, Cloudflare-fronted proxy over the ECB's daily fix. Covers 30 major currencies from 1999-01-04 (ECB launch) to present (set fluctuates as currencies enter/exit ECB scope; call `fx_list_currencies` for the live set).

ECB publishes one rate fix per business day (~16:00 CET). The rates are mid-market reference rates — not tradeable bid/ask, not intraday/live, no spread. The server makes this explicit in every response via a `rate_type: "ECB reference (mid-market)"` field so agents don't present them as dealing rates.

Key value add over a raw curl: cross-rate math (ECB is EUR-base only; USD→JPY requires triangulation through EUR), weekend/holiday date semantics (the API silently snaps to the prior business day — the server flags when this happens), and clean structured output with provenance.

Fills a fleet gap: `coingecko` is crypto, `finnhub` is equities. This is the fiat FX leg. Composes naturally with both: multi-asset portfolio valuation needs all three.

---

## Requirements

- Convert any amount between any two supported currencies at latest or historical rates
- Cross-rate triangulation: any pair works, not just EUR-base pairs
- Historical coverage: 1999-01-04 through yesterday (ECB data lag ~1 business day)
- Time-series retrieval for charting, trend analysis, and rate comparison
- Date semantics: when a requested date has no fix (weekend, holiday), document the actual rate date returned — never silently snap without surfacing it
- Rate provenance in every response: `source`, `rate_date`, `rate_type`
- `fx_list_currencies` for disambiguation before conversion
- DataCanvas integration on `fx_get_timeseries` for ranges >90 days or analytical workflows
- No API key required (Frankfurter is keyless)
- All tools read-only — no writes, no auth scopes needed
- Rate type caveat in responses: ECB mid-market reference, not tradeable rates

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `FrankfurterService` | Frankfurter API (`https://api.frankfurter.dev/v1`) | All `fx_*` tools |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `FRANKFURTER_BASE_URL` | No | Override Frankfurter base URL. Default: `https://api.frankfurter.dev/v1`. Useful for local testing or self-hosted Frankfurter. |
| `FX_TIMESERIES_CANVAS_THRESHOLD_DAYS` | No | Day-count threshold above which `fx_get_timeseries` spills to DataCanvas instead of inline. Default: `90`. |

No API keys required.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema for env vars above
2. **FrankfurterService** — init/accessor, typed response shapes, retry wrapper, `fetchWithTimeout`, error classification
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

**`fx_convert_currency`** (1–2 upstream calls, depending on whether a cross-rate is needed):

| # | Call | Purpose | Note |
|:--|:-----|:--------|:-----|
| 1 | `GET /v1/{date}?base={base}&symbols={quote}` | Fetch the rate for the pair on the requested date | `latest` if no date given |
| — | *(no extra call)* | ECB is EUR-base; when one side is EUR, the rate is direct | base=EUR or quote=EUR: 1 call |
| — | *(triangulation)* | When neither side is EUR, the service computes `base/EUR × EUR/quote` from a single multi-symbol fetch | base≠EUR, quote≠EUR: still 1 call — fetch both EUR/base and EUR/quote in one request |

**`fx_get_timeseries`** (1 upstream call + optional canvas registration):

| # | Call | Purpose | Note |
|:--|:-----|:--------|:-----|
| 1 | `GET /v1/{start}..{end}?base={base}&symbols={quote}` | Fetch the full date range | Single call regardless of range length |
| 2 | Canvas register | Register rows as a DuckDB table | Only when day count > threshold (~90) |

Output schema must include: `base_currency`, `quote_currency`, `start_date` (actual — may differ from requested if the requested start falls on a holiday), `end_date` (actual), `rates` (date → rate map; business days only), `rate_count` (number of entries), `rate_type`, `source`. When canvas spill occurs: `canvas_id` (required for `fx_dataframe_describe`/`fx_dataframe_query`) and `truncated: true` with `inline_rates` being the first N rows rather than the full series. The actual `start_date`/`end_date` from the API response must be surfaced — the API snaps range boundaries to business days silently, and the agent needs to see the actual window returned.

---

## Design Decisions

**Cross-rate math in the service, not the tool.** `fx_convert_currency` and `fx_get_rate` both need cross-rates; putting the triangulation in `FrankfurterService.getRate(base, quote, date)` keeps tool handlers thin and the math testable.

**One call for cross-rates.** When neither side is EUR (e.g., USD→JPY), we don't need two API calls — we fetch `GET /latest?base=EUR&symbols=USD,JPY` in one request and compute `JPY_rate / USD_rate`. This avoids N+1 and respects Frankfurter's reasonable rate limits.

**`fx_get_timeseries` doesn't snap dates.** The ECB publishes on business days; weekends and holidays simply don't appear in the series. The tool returns exactly what the API returns — a sparse series with only business-day keys — and documents this in the output. In contrast, `fx_get_rate` and `fx_convert_currency` (point-in-time) surface the snap because the caller asked for a specific date and got a different one.

**`symbols` optional on `fx_get_rates`.** Returning all ~30 currencies is < 1KB; there's no need to force callers to enumerate what they want for the bulk-snapshot tool. `symbols` is an optional filter for agents that already know which pair they care about and want a smaller response.

**No amount param threading into `fx_get_rate`.** The idea spec draws a clean line: `fx_get_rate` is "what is the rate?", `fx_convert_currency` is "how much do I get?". Conflating them (as the Frankfurter `amount` param allows) would make `fx_get_rate` a fuzzy alias of `fx_convert_currency`. The tools stay focused.

**DataCanvas threshold configurable via env.** The 90-day default keeps time-series inline for quarterly lookups (the most common case), while multi-year pulls (e.g., for charting since 2000) spill to canvas where the agent can aggregate. The threshold is a config knob so it can be tuned without a code change.

**No MirrorService.** The ECB publishes a full-history bulk file (`eurofxref-hist`, ~2MB XML), which is technically mirror-able. However, the live API is fast (< 100ms, Cloudflare-cached), keyless, and reliably returns 200s for all in-range dates. A mirror would add SQLite tooling and a sync scheduler for no user-visible benefit given the data volume and query patterns. Revisit if Frankfurter ever gates behind auth or shows reliability issues.

**`rate_type` in every response.** The ECB rates are mid-market reference rates, not dealing rates — presenting them as "the exchange rate" without qualification could mislead. Every rate-bearing response carries `rate_type: "ECB reference (mid-market)"` and `source: "ECB via Frankfurter"`.

**`fx_list_currencies` as a plain array, not a map.** Returning `[{ code, name }]` rather than `{ USD: "United States Dollar" }` makes it naturally sortable in `format()` and easier for agents to iterate or filter for display. The Frankfurter `/currencies` endpoint returns a flat object, so the service normalizes to an array.

---

## Known Limitations

- **ECB coverage only** (~30 currencies). Exotic pairs (e.g., XOF, DZD, VND) are not available. No fallback to a broader provider is planned in v0.1.0 — the idea spec mentioned exchangerate.host/open.er-api.com but they either require auth or are unreliable; ECB/Frankfurter alone is the cleaner initial bet.
- **Business-day rates only.** No intraday or tick data. ECB publishes once per day after ~16:00 CET; the "latest" rate on a weekday morning is technically the prior day's close.
- **Historical start: 1999-01-04.** Dates before that return `{"message":"not found"}`.
- **Mid-market rates only.** No bid/ask spread, no tradeable rates. Explicitly surfaced in output.
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
