---
name: exchange-rates-guide
description: Analyze historical FX periods with fx_* tools, discover retired currency coverage, and compare staged series with SQL. Use for period averages, highs/lows, movements, incomplete coverage, or multi-pair analysis; simple conversions and latest snapshots can use the tools directly.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this keyless server for Frankfurter v1 daily reference-rate analysis. For a single converted amount use fx_convert_currency; for a rate use fx_get_rate; for a latest snapshot use fx_get_rates or fx://rates/latest/{base}. These rates do not establish an executable trade price or a required tax or accounting method.

## Identifiers

Resolve ambiguous currency names through fx_list_currencies. Its retired-currency discovery adds historical codes; fx://currencies remains current-only. Coverage dates, when available, are outer bounds: an interior date can still lack a rate. If discovery reports unavailable coverage metadata, leave coverage unknown.

Take canvas_id and table_name from a staged fx_get_timeseries response. Each registration creates a unique table name; never construct it from the currency pair. Use fx_dataframe_describe to discover the exact names and column types before SQL.

## Gates

- Establish the direction before comparing: a rate measures quote units per base unit. Keep that direction consistent across periods and SQL results.
- Before calling an average a full-period result, inspect the returned observation bounds and coverage notice. Missing currency legs on served publication days reduce coverage; weekends and holidays are not missing observations. Report the observed interval and any coverage shortfall instead of filling gaps.
- Treat truncated as a delivery flag, not proof of complete currency coverage. Read coverage notices even when truncated is false.
- Keep the initial requested-range summary for the period question. A continuation summarizes its own remaining interval; do not average page means.
- Check rate_count and summary before interpreting an empty rates map. A summary-only response can contain observations without showing rows; a genuinely empty interval has no summary.
- Use only dataframe tools advertised by the connected deployment. Before dropping a table, obtain the exact name with fx_dataframe_describe and confirm the requested deletion; do not automatically remove caller-owned tables.

## Core chain

For historical analysis, resolve the currency codes and available coverage, then request the complete interval with fx_get_timeseries. Answer from its summary when that resolves the question. Retrieve observations or query staged tables only when the analysis needs them.

## Workflows

**Period summary.** For an average, high, low, or endpoint movement, request zero preview observations with fx_get_timeseries. The summary and rate_count still cover every observed day in the requested interval. An arithmetic daily mean weights observations equally; it does not weight calendar days, transaction amounts, or exposure.

**Observation retrieval.** Follow next_start_date with the original end date to continue inline results. After a zero-limit response, use a positive limit to advance. When spilled is true, query the full staged table rather than treating rates as complete; reducing the preview never removes rows from that table.

With DataCanvas enabled, results too large to return inline are staged as a DataCanvas table, and the response carries a canvas_id. Call fx_dataframe_describe with it for the staged table and column names before writing SQL, then fx_dataframe_query with a read-only query. Pass the same canvas_id back to stage further results beside the first; the tables expire with the canvas.

**Compare series.** Once a response supplies a real canvas handle, pass it to subsequent fx_get_timeseries calls to stage the other series beside the first, including short ranges. A guessed canvas ID cannot create a workspace. If automatic staging has not supplied a handle, use inline observations for the comparison. With DataCanvas unavailable, continue inline pages.

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
