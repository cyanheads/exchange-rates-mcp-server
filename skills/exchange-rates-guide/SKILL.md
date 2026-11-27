---
name: exchange-rates-guide
description: Analyze historical FX periods with fx_* tools, discover retired currency coverage, and compare staged series with SQL. Use for period averages, highs/lows, movements, incomplete coverage, or multi-pair analysis; simple conversions and latest snapshots can use the tools directly.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.2"
---

## Scope

Use the rate tools for Frankfurter v1 daily observations and for the irrevocable conversion factors of former euro-area currencies. For a single amount use fx_convert_currency. For a market snapshot use fx_get_rates or fx://rates/latest/{base}. These figures do not establish an executable trade price or a required accounting method.

## Identifiers

Resolve currency names with fx_list_currencies. With include_retired enabled, use the adoption date and statutory factor for a legacy euro currency separately from its historical market coverage. A retired code can still convert after its last publication. A market coverage window can contain gaps. The fx://currencies resource lists current market codes.

Take canvas_id and table_name from a staged fx_get_timeseries response. Each registration creates a unique table name; never construct it from the currency pair. Use fx_dataframe_describe to discover the exact names and column types before SQL.

## Gates

- Establish the direction before comparing: a rate measures quote units per base unit. Keep that direction consistent across periods and SQL results.
- Read the rate source before comparing periods. Market rates follow publication days. Fully statutory periods run on calendar days. In a mixed conversion, the market fix can precede the date on which the statutory factor applies. For historical RON or TRY, check the notice for the units of the amount before converting it.
- Check the missing currencies, dates and available coverage bounds even when truncated is false. A missing observation changes the full-period mean. Truncation limits only the preview.
- Keep the initial requested-range summary for the period question. A continuation summarizes its own remaining interval; do not average page means.
- Check rate_count and summary before interpreting an empty rates map. A summary-only response can contain observations without showing rows; a genuinely empty interval has no summary.
- Use only dataframe tools advertised by the connected deployment. Before dropping a table, obtain the exact name with fx_dataframe_describe and confirm the requested deletion; do not automatically remove caller-owned tables.

## Core chain

For historical analysis, resolve the currency codes and available coverage, then request the complete interval with fx_get_timeseries. Answer from its summary when that resolves the question. Retrieve observations or query staged tables only when the analysis needs them.

## Workflows

**Period summary.** Request zero preview observations for a period average, high, low or endpoint movement. The summary and rate_count still cover every observation in the interval. Each observation receives equal weight, regardless of transaction amount or exposure.

**Observation retrieval.** Follow next_start_date with the original end date to continue inline results. After a zero-limit response, use a positive limit to advance. When spilled is true, query the full staged table rather than treating rates as complete; reducing the preview never removes rows from that table.

With DataCanvas enabled, automatic staging requires both a range over the configured day threshold and observations exceeding the inline preview budget. Take canvas_id from the response and inspect the table with fx_dataframe_describe before querying it. Pass that canvas_id to stage further series alongside it. The tables expire with the canvas.

**Compare series.** Request the first series with stage: true, which stages it on a new canvas even for a short range and returns the canvas_id. Pass that canvas_id, not stage again, to each subsequent fx_get_timeseries call so the other series land beside it; fx_dataframe_query reads one canvas at a time. A guessed canvas ID cannot create a workspace. If automatic staging already supplied a handle, reuse it. With DataCanvas unavailable, stage fails, so continue inline pages.

For monthly comparisons, describe both tables, then replace the quoted placeholders below with their exact returned names. The inner join compares common observation dates; compare its day counts with each series before drawing a full-period conclusion.

```sql
SELECT substr(a.date, 1, 7) AS month,
       count(*) AS common_days,
       avg(a.rate) AS first_pair_mean,
       avg(b.rate) AS second_pair_mean
FROM "FIRST_DESCRIBED_TABLE" AS a
JOIN "SECOND_DESCRIBED_TABLE" AS b ON a.date = b.date
GROUP BY substr(a.date, 1, 7)
ORDER BY month
```

Do not compare the magnitudes of differently denominated rates as performance. Compare movements in a consistent direction. For row retrieval, use deterministic ORDER BY with SQL LIMIT/OFFSET when a query is truncated. If a canvas or table expires, re-stage the required series and describe the new handles before retrying SQL.
