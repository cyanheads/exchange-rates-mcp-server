/**
 * @fileoverview fx_get_timeseries — historical daily rates for a currency pair over a date range.
 * @module mcp-server/tools/definitions/fx-get-timeseries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { failureOf, unsupportedCurrencyCodesOf } from '@/services/frankfurter/errors.js';
import {
  ECB_START_DATE,
  getFrankfurterService,
  isIsoDate,
} from '@/services/frankfurter/frankfurter-service.js';
import type { TimeSeriesResult } from '@/services/frankfurter/types.js';

/**
 * Most publication days one inline response carries — roughly two Frankfurter v1 years, ~21 KB
 * serialized across both response surfaces. Rows are date-keyed, so the continuation
 * is the next start_date rather than an offset.
 */
const INLINE_PAGE_SIZE = 500;

/**
 * Column types of a staged series, matching `SeriesRow`. Declared rather than sniffed
 * from the preview: a series whose leading rates are whole numbers (an identity pair
 * is 1 every day) would otherwise stage `rate` as BIGINT.
 */
const SERIES_SCHEMA: ColumnSchema[] = [
  { name: 'date', type: 'VARCHAR', nullable: false },
  { name: 'rate', type: 'DOUBLE', nullable: false },
  { name: 'base_currency', type: 'VARCHAR', nullable: false },
  { name: 'quote_currency', type: 'VARCHAR', nullable: false },
];

export const fxGetTimeseries = tool('fx_get_timeseries', {
  inputAliases: { base: 'base_currency', quote: 'quote_currency' },
  description: `Get historical daily Frankfurter v1 rates for a currency pair over an inclusive date range. Rates use same-date EUR legs without intermediate rounding; only days with both currencies appear, and a self-pair is 1 on actual observation dates. Historical membership includes retired currencies. Empty non-publication windows succeed with a notice. summary covers every observation in the requested interval before paging or staging: unweighted arithmetic mean, extrema with earliest-date ties, endpoints and percentage change, without prescribing accounting policy. Inline rates page at ${INLINE_PAGE_SIZE} observations; continue with next_start_date and the same end_date. Long ranges (>90 days by default) stage when they exceed the 40,000-character preview budget. An explicit canvas_id always stages, including short or empty ranges, and fails if unavailable or unknown. Each registration returns a unique table_name and preserves older tables. spilled=true returns canvas_id and table_name; call fx_dataframe_describe then fx_dataframe_query for SQL. Without DataCanvas, omit canvas_id to page inline.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    base_currency: z
      .string()
      .describe(
        'ISO 4217 base currency code (e.g. USD). Call fx_list_currencies to get valid codes.',
      ),
    quote_currency: z
      .string()
      .describe(
        'ISO 4217 quote currency code (e.g. EUR). Call fx_list_currencies to get valid codes.',
      ),
    start_date: z
      .string()
      .meta({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
      .describe(
        'ISO 8601 start date (YYYY-MM-DD). Frankfurter v1 data starts 1999-01-04. ' +
          'The actual first data point may be later if start_date falls on a weekend/holiday.',
      ),
    end_date: z
      .string()
      .meta({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
      .describe(
        'ISO 8601 end date (YYYY-MM-DD). Must be >= start_date. Future dates are not supported.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Existing canvas ID from a prior call explicitly requesting staging even for short or empty results. Every call creates a uniquely named table. Omit for automatic staging or inline paging.',
    ),
  }),
  output: z.object({
    base_currency: z.string().describe('Base currency code.'),
    quote_currency: z.string().describe('Quote currency code.'),
    start_date: z
      .string()
      .describe(
        'First publication date in the requested range, and the first key in rates. Always inside ' +
          'the requested range — later than the requested start when that day had no Frankfurter v1 fix, and ' +
          'equal to it when the series is empty.',
      ),
    end_date: z
      .string()
      .describe(
        'Last publication date in the requested range. Always inside the requested range — earlier ' +
          'than the requested end when that day had no Frankfurter v1 fix, and equal to it when the series is ' +
          'empty. Later than the last key in rates when truncated is true.',
      ),
    rates: z
      .record(z.string(), z.number())
      .describe(
        'Date → rate map in date order, publication days inside the requested range only. Holds ' +
          `every publication day when truncated is false; otherwise the first ${INLINE_PAGE_SIZE} of an ` +
          'inline page (continue with next_start_date) or the preview of a spilled series (the full ' +
          'series is on the canvas). Empty when the range contains no publication day at all.',
      ),
    rate_count: z
      .number()
      .describe(
        'Total publication days in the requested range (the start_date through end_date passed on ' +
          'this call) — not the number of entries in rates, which is smaller when truncated is true. ' +
          'On a continuation call it counts the days from that start_date onward.',
      ),
    summary: z
      .object({
        mean: z
          .number()
          .describe(
            'Unweighted arithmetic mean of all daily observations in the requested range; not an accounting-policy prescription.',
          ),
        min: z
          .object({
            rate: z.number().describe('Lowest rate.'),
            date: z.string().describe('Earliest date with the lowest rate.'),
          })
          .describe('Minimum observation.'),
        max: z
          .object({
            rate: z.number().describe('Highest rate.'),
            date: z.string().describe('Earliest date with the highest rate.'),
          })
          .describe('Maximum observation.'),
        first: z
          .object({
            rate: z.number().describe('First rate.'),
            date: z.string().describe('First publication date.'),
          })
          .describe('Chronologically first observation.'),
        last: z
          .object({
            rate: z.number().describe('Last rate.'),
            date: z.string().describe('Last publication date.'),
          })
          .describe('Chronologically last observation.'),
        change_pct: z.number().describe('Percentage change from first to last observation.'),
      })
      .optional()
      .describe(
        'Statistics over the full clipped requested range before paging or staging; omitted for empty ranges. Continuations summarize their own requested interval.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when rates holds only part of the series: an inline page (next_start_date continues ' +
          'it) or a spilled preview (spilled is true). False when rates holds every publication day ' +
          'in the requested range.',
      ),
    next_start_date: z
      .string()
      .optional()
      .describe(
        'Present only when an inline page was cut short: the first publication date not in rates. ' +
          'Pass it as start_date with the same end_date to get the next page. Absent on the final page.',
      ),
    rate_type: z
      .string()
      .describe(
        'Always "Daily rate (Frankfurter v1)" — these are reference rates, not tradeable bid/ask.',
      ),
    source: z.string().describe('Always "Frankfurter v1" — the upstream data provider.'),
    spilled: z
      .boolean()
      .describe(
        'True when the complete result was staged on DataCanvas, either explicitly through canvas_id or automatically after exceeding the threshold and preview budget.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID — present when spilled is true. Pass to fx_dataframe_describe to inspect the ' +
          'staged table, then to fx_dataframe_query to run SQL.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'Canvas table name — present when spilled is true. Use it as the FROM target in ' +
          'fx_dataframe_query SQL; fx_dataframe_describe lists its columns.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Explains a result that would otherwise look broken or incomplete: an empty series (no ' +
          'publication day in the range); an inline page cut short (the start_date to continue ' +
          'from, plus why a long range was not staged when DataCanvas is turned off); or a ' +
          'spilled series (the canvas and table it was staged to, and the tools that read it).',
      ),
  },

  errors: [
    {
      reason: 'invalid_date_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date or end_date is not a real calendar date written as YYYY-MM-DD.',
      recovery: 'Pass ISO 8601 calendar dates in YYYY-MM-DD form, for example 2024-06-01.',
    },
    {
      reason: 'unsupported_currency',
      code: JsonRpcErrorCode.ValidationError,
      when: 'base_currency or quote_currency is not available in the current discovery or served historical data.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date is before 1999-01-04 or end_date is in the future.',
      recovery: "Use start_date on or after 1999-01-04 and end_date on or before today's date.",
    },
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date is after end_date.',
      recovery: 'Ensure start_date is before or equal to end_date.',
    },
    {
      reason: 'upstream_no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Both currencies are supported but the Frankfurter v1 published no rates across this range.',
      recovery:
        'Try a more recent range — Frankfurter v1 history starts later for some currencies.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An explicitly supplied canvas_id does not exist or has expired.',
      recovery:
        'Supply an existing canvas ID, or omit canvas_id for automatic staging or inline paging.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'canvas_id requests staging on a deployment with DataCanvas disabled.',
      recovery:
        'Enable DataCanvas with CANVAS_PROVIDER_TYPE=duckdb, or omit canvas_id for inline results.',
    },
  ],

  async handler(input, ctx) {
    const service = getFrankfurterService();
    const config = getServerConfig();
    const today = new Date().toISOString().slice(0, 10);

    /**
     * Format first. Every check below — the Frankfurter v1 epoch bound, the future bound, and
     * the start/end ordering — is a lexicographic string comparison, so a malformed
     * date silently reads as an out-of-range or reversed range instead of a bad date.
     */
    for (const field of ['start_date', 'end_date'] as const) {
      const value = input[field];
      if (!isIsoDate(value)) {
        throw ctx.fail(
          'invalid_date_format',
          `${field} "${value}" is not a valid YYYY-MM-DD calendar date.`,
          { field },
        );
      }
    }

    if (input.start_date < ECB_START_DATE) {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} is before Frankfurter v1 data start ${ECB_START_DATE}.`,
      );
    }
    if (input.end_date > today) {
      throw ctx.fail('date_out_of_range', `end_date ${input.end_date} is in the future.`);
    }
    if (input.start_date > input.end_date) {
      throw ctx.fail(
        'invalid_range',
        `start_date ${input.start_date} is after end_date ${input.end_date}.`,
      );
    }

    // Compute calendar days to decide inline vs spillover
    const msPerDay = 86_400_000;
    const dayCount =
      (new Date(input.end_date).getTime() - new Date(input.start_date).getTime()) / msPerDay + 1;

    let series: TimeSeriesResult;
    try {
      series = await service.getTimeSeries(
        input.base_currency,
        input.quote_currency,
        input.start_date,
        input.end_date,
        ctx.signal,
      );
    } catch (err) {
      ctx.signal.throwIfAborted();
      const failure = failureOf(err);
      if (failure?.reason === 'unsupported_currency') {
        throw ctx.fail('unsupported_currency', (err as Error).message, {
          field: failure.field,
          ...unsupportedCurrencyCodesOf(err),
        });
      }
      if (failure?.reason === 'upstream_no_data') {
        throw ctx.fail(
          'upstream_no_data',
          `Frankfurter v1 returned no ${input.base_currency}/${input.quote_currency} rates between ${input.start_date} and ${input.end_date}.`,
        );
      }
      throw err;
    }

    const { rows, startDate: actualStart, endDate: actualEnd } = series;

    ctx.log.info('Fetched timeseries', {
      base: input.base_currency,
      quote: input.quote_currency,
      start: actualStart,
      end: actualEnd,
      points: rows.length,
      dayCount,
    });

    const canvas = getCanvas();
    const exceedsThreshold = dayCount > config.timeseriesCanvasThresholdDays;
    if (input.canvas_id !== undefined && canvas == null) {
      throw ctx.fail('canvas_unavailable', 'Explicit staging requires DataCanvas on this server.');
    }
    const first = rows[0];
    const summary = (() => {
      if (!first) return;
      let total = 0;
      let min = first;
      let max = first;
      let last = first;
      for (const row of rows) {
        total += row.rate;
        if (row.rate < min.rate) min = row;
        if (row.rate > max.rate) max = row;
        last = row;
      }
      const observation = (row: typeof first) => ({ rate: row.rate, date: row.date });
      return {
        mean: total / rows.length,
        min: observation(min),
        max: observation(max),
        first: observation(first),
        last: observation(last),
        change_pct: ((last.rate - first.rate) / first.rate) * 100,
      };
    })();

    /** Fields every branch below returns identically — only rates/count/paging/spill differ. */
    const envelope = {
      base_currency: input.base_currency.trim().toUpperCase(),
      quote_currency: input.quote_currency.trim().toUpperCase(),
      start_date: actualStart,
      end_date: actualEnd,
      rate_type: 'Daily rate (Frankfurter v1)',
      source: 'Frankfurter v1',
      ...(summary && { summary }),
    };

    if (canvas != null && (exceedsThreshold || input.canvas_id !== undefined)) {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      const tableName = `fx_${envelope.base_currency.toLowerCase()}_${envelope.quote_currency.toLowerCase()}_${crypto.randomUUID().replaceAll('-', '')}`;
      let retained = false;
      try {
        ctx.signal.throwIfAborted();
        if (input.canvas_id !== undefined) {
          const handle = await instance.registerTable(tableName, rows, {
            schema: SERIES_SCHEMA,
            signal: ctx.signal,
          });
          ctx.signal.throwIfAborted();
          const preview = rows.slice(0, INLINE_PAGE_SIZE);
          const truncated = preview.length < rows.length;
          ctx.enrich.notice(
            `Staged ${rows.length} rows to table "${handle.tableName}" on canvas ${instance.canvasId}. Call fx_dataframe_describe to inspect its columns, then fx_dataframe_query to run SQL over the full series. rates holds ${truncated ? 'a preview' : 'every observation'}.`,
          );
          retained = true;
          return {
            ...envelope,
            rates: Object.fromEntries(preview.map((row) => [row.date, row.rate])),
            rate_count: rows.length,
            truncated,
            spilled: true,
            canvas_id: instance.canvasId,
            table_name: handle.tableName,
          };
        }
        const spillResult = await spillover({
          canvas: instance,
          source: rows,
          schema: SERIES_SCHEMA,
          tableName,
          previewChars: 40_000, // ~10k tokens preview
          signal: ctx.signal,
        });
        ctx.signal.throwIfAborted();

        ctx.log.info('Spilled to canvas', {
          canvasId: instance.canvasId,
          tableName,
          rowCount: rows.length,
          spilled: spillResult.spilled,
        });

        if (spillResult.spilled) {
          const { rowCount, tableName: stagedTable } = spillResult.handle;
          ctx.enrich.notice(
            `Staged ${rowCount} rows to table "${stagedTable}" on canvas ${instance.canvasId} — call ` +
              'fx_dataframe_describe to inspect its columns, then fx_dataframe_query to run SQL over the ' +
              'full series. rates holds only a preview.',
          );
          retained = true;
          return {
            ...envelope,
            rates: Object.fromEntries(spillResult.previewRows.map((row) => [row.date, row.rate])),
            rate_count: rowCount,
            truncated: true,
            spilled: true,
            canvas_id: instance.canvasId,
            table_name: stagedTable,
          };
        }
        // Every row fit the preview budget, so nothing was staged — page it inline below.
      } finally {
        if (input.canvas_id !== undefined && !retained) await instance.drop(tableName);
        if (instance.isNew && !retained) await canvas.drop(instance.canvasId, ctx);
      }
    }

    const page = rows.slice(0, INLINE_PAGE_SIZE);
    const nextRow = rows[INLINE_PAGE_SIZE];

    /**
     * An empty series, a page cut short, and a long range that never spilled all look
     * incomplete or broken from the outside. Say which one happened, on both surfaces.
     * The dataframe tools are unregistered without a canvas, so nothing here names them.
     */
    const unstaged =
      exceedsThreshold && canvas == null
        ? `This ${dayCount}-day range is past the ${config.timeseriesCanvasThresholdDays}-day spill threshold, but ` +
          'DataCanvas is not configured on this server, so the series is returned inline and spilled is false. ' +
          'Set CANVAS_PROVIDER_TYPE=duckdb to stage long ranges for SQL instead.'
        : undefined;

    if (rows.length === 0) {
      ctx.enrich.notice(
        `Frankfurter v1 returned no ${envelope.base_currency}/${envelope.quote_currency} observation between ${input.start_date} and ${input.end_date}. Weekends, holidays and currency-specific gaps can leave a valid window empty. Widen the range to look for publication days.`,
      );
    } else if (nextRow) {
      const pageNote =
        `rates holds the first ${page.length} of ${rows.length} publication days ` +
        `(${page[0]?.date} to ${page.at(-1)?.date}). Call fx_get_timeseries again with ` +
        `start_date=${nextRow.date} and end_date=${input.end_date} for the next page.`;
      ctx.enrich.notice(unstaged ? `${pageNote} ${unstaged}` : pageNote);
    } else if (unstaged) {
      ctx.enrich.notice(unstaged);
    }

    return {
      ...envelope,
      rates: Object.fromEntries(page.map((row) => [row.date, row.rate])),
      rate_count: rows.length,
      truncated: nextRow !== undefined,
      ...(nextRow && { next_start_date: nextRow.date }),
      spilled: false,
    };
  },

  format: (result) => {
    const rateEntries = Object.entries(result.rates).sort(([a], [b]) => a.localeCompare(b));
    const lines: string[] = [
      `**${result.base_currency}/${result.quote_currency} time series** — ${result.start_date} to ${result.end_date}`,
      `*${result.rate_count} publication-day data points in range · ${result.rate_type} · ${result.source} · spilled: ${result.spilled}*`,
      `*${rateEntries.length} shown · truncated: ${result.truncated}` +
        (result.next_start_date ? ` · next_start_date: ${result.next_start_date}*` : '*'),
    ];

    if (result.spilled) {
      lines.push(
        `\n📊 **Result staged on DataCanvas**`,
        `Canvas ID: \`${result.canvas_id}\``,
        `Table: \`${result.table_name}\``,
        `Call fx_dataframe_describe with this canvas_id to inspect the table columns, then fx_dataframe_query for SQL over the full series. ${result.truncated ? 'Preview' : 'Complete observations'} (${rateEntries.length} shown):`,
      );
    }

    if (result.summary) {
      const summary = result.summary;
      lines.push(
        `Mean: ${summary.mean} (unweighted arithmetic average of daily observations; not a tax-authority or accounting-policy prescription).`,
        `Min: ${summary.min.rate} on ${summary.min.date}; max: ${summary.max.rate} on ${summary.max.date}.`,
        `First: ${summary.first.rate} on ${summary.first.date}; last: ${summary.last.rate} on ${summary.last.date}; change_pct: ${summary.change_pct}.`,
      );
    }

    if (rateEntries.length > 0) {
      lines.push('');
      for (const [date, rate] of rateEntries) {
        lines.push(`${date}: ${rate}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
