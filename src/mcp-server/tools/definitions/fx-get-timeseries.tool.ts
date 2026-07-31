/**
 * @fileoverview fx_get_timeseries — historical daily rates for a currency pair over a date range.
 * @module mcp-server/tools/definitions/fx-get-timeseries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { failureOf } from '@/services/frankfurter/errors.js';
import {
  ECB_START_DATE,
  getFrankfurterService,
  isIsoDate,
} from '@/services/frankfurter/frankfurter-service.js';
import type { TimeSeriesResult } from '@/services/frankfurter/types.js';

export const fxGetTimeseries = tool('fx_get_timeseries', {
  description:
    'Get historical daily exchange rates for a currency pair over a date range. ' +
    'ECB publishes on business days only — weekends and holidays produce no entry, and no date ' +
    'outside the requested range is ever returned, so a range covering only non-publication days ' +
    'comes back with an empty rates map and a notice explaining why. ' +
    'A same-currency pair returns a rate of 1 on each publication day in the range. ' +
    'Short ranges (≤90 days by default) are returned inline as a date→rate map. ' +
    'When DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) long ranges spill to it: the response ' +
    'carries spilled=true, a canvas_id, and a table_name — call fx_dataframe_describe to inspect the ' +
    'staged table, then fx_dataframe_query to run SQL against it. ' +
    'Without DataCanvas long ranges stay inline (spilled=false) and the notice says so.',
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
      .describe(
        'ISO 8601 start date (YYYY-MM-DD). ECB data starts 1999-01-04. ' +
          'The actual first data point may be later if start_date falls on a weekend/holiday.',
      ),
    end_date: z
      .string()
      .describe(
        'ISO 8601 end date (YYYY-MM-DD). Must be >= start_date. Future dates are not supported.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional canvas ID from a prior call. Omit on the first call to start a fresh canvas; ' +
          'pass the returned canvas_id to append tables to an existing canvas.',
      ),
  }),
  output: z.object({
    base_currency: z.string().describe('Base currency code.'),
    quote_currency: z.string().describe('Quote currency code.'),
    start_date: z
      .string()
      .describe(
        'First date in the returned series. Always inside the requested range — later than the ' +
          'requested start when that day had no ECB fix, and equal to it when the series is empty.',
      ),
    end_date: z
      .string()
      .describe(
        'Last date in the returned series. Always inside the requested range — earlier than the ' +
          'requested end when that day had no ECB fix, and equal to it when the series is empty.',
      ),
    rates: z
      .record(z.string(), z.number())
      .describe(
        'Date → rate map for the inline result. Publication days inside the requested range only. ' +
          'Truncated to a preview when the result was spilled to canvas; empty when the range ' +
          'contains no publication day at all.',
      ),
    rate_count: z
      .number()
      .describe('Total number of data points (publication days) inside the requested range.'),
    rate_type: z
      .string()
      .describe(
        'Always "ECB reference (mid-market)" — these are reference rates, not tradeable bid/ask.',
      ),
    source: z.string().describe('Always "ECB via Frankfurter" — the upstream data provider.'),
    spilled: z
      .boolean()
      .describe(
        'True when the full result was staged on the DataCanvas (range exceeded threshold).',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe('Canvas ID — present when spilled is true. Pass to fx_dataframe_query.'),
    table_name: z
      .string()
      .optional()
      .describe('Canvas table name — present when spilled is true. Use in fx_dataframe_query SQL.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Explains a result that would otherwise look broken — an empty series, or a long range ' +
          'that stayed inline because DataCanvas is not configured.',
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
      when: 'base_currency or quote_currency is not in the ECB currency set.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date is before 1999-01-04 or end_date is in the future.',
      recovery: "ECB data starts 1999-01-04; omit end_date or use today's date.",
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
      when: 'Both currencies are supported but the ECB published no rates across this range.',
      recovery: 'Try a more recent range — ECB history starts later for some currencies.',
    },
  ],

  async handler(input, ctx) {
    const service = getFrankfurterService();
    const config = getServerConfig();
    const today = new Date().toISOString().slice(0, 10);

    /**
     * Format first. Every check below — the ECB epoch bound, the future bound, and
     * the start/end ordering — is a lexicographic string comparison, so a malformed
     * date silently reads as an out-of-range or reversed range instead of a bad date.
     */
    for (const field of ['start_date', 'end_date'] as const) {
      const value = input[field];
      if (!isIsoDate(value)) {
        throw ctx.fail(
          'invalid_date_format',
          `${field} "${value}" is not a valid YYYY-MM-DD calendar date.`,
          { ...ctx.recoveryFor('invalid_date_format'), field },
        );
      }
    }

    if (input.start_date < ECB_START_DATE) {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} is before ECB data start ${ECB_START_DATE}.`,
        {
          ...ctx.recoveryFor('date_out_of_range'),
        },
      );
    }
    if (input.end_date > today) {
      throw ctx.fail('date_out_of_range', `end_date ${input.end_date} is in the future.`, {
        ...ctx.recoveryFor('date_out_of_range'),
      });
    }
    if (input.start_date > input.end_date) {
      throw ctx.fail(
        'invalid_range',
        `start_date ${input.start_date} is after end_date ${input.end_date}.`,
        {
          ...ctx.recoveryFor('invalid_range'),
        },
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
      );
    } catch (err) {
      const failure = failureOf(err);
      if (failure?.reason === 'unsupported_currency') {
        throw ctx.fail('unsupported_currency', (err as Error).message, {
          ...ctx.recoveryFor('unsupported_currency'),
          field: failure.field,
        });
      }
      if (failure?.reason === 'upstream_no_data') {
        throw ctx.fail(
          'upstream_no_data',
          `The ECB published no ${input.base_currency}/${input.quote_currency} rates between ${input.start_date} and ${input.end_date}.`,
          { ...ctx.recoveryFor('upstream_no_data') },
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
    const shouldSpill = canvas != null && exceedsThreshold;

    /**
     * An empty series and a long range that never spilled both look like failures
     * from the outside. Say which one happened and why, on both client surfaces.
     */
    if (rows.length === 0) {
      ctx.enrich.notice(
        `The ECB published no ${input.base_currency.toUpperCase()}/${input.quote_currency.toUpperCase()} rate between ` +
          `${input.start_date} and ${input.end_date}. Reference rates are published on TARGET business days ` +
          'only, so a range covering just a weekend or a bank holiday is legitimately empty rather than ' +
          'broken. Widen the range — a window spanning several weekdays will contain a publication day.',
      );
    } else if (exceedsThreshold && canvas == null) {
      ctx.enrich.notice(
        `This ${dayCount}-day range is past the ${config.timeseriesCanvasThresholdDays}-day spill threshold, but ` +
          'DataCanvas is not configured on this server, so the full series is inline and spilled is false. ' +
          'Set CANVAS_PROVIDER_TYPE=duckdb to stage long ranges for SQL instead.',
      );
    }

    /** Fields every branch below returns identically — only rates/count/spill differ. */
    const envelope = {
      base_currency: input.base_currency.toUpperCase(),
      quote_currency: input.quote_currency.toUpperCase(),
      start_date: actualStart,
      end_date: actualEnd,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };

    // Inline path — short range, or long range with no canvas to spill to
    if (!shouldSpill) {
      const rateMap: Record<string, number> = {};
      for (const row of rows) rateMap[row.date] = row.rate;
      return { ...envelope, rates: rateMap, rate_count: rows.length, spilled: false };
    }

    // Canvas spillover path
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const tableName = `fx_${input.base_currency.toLowerCase()}_${input.quote_currency.toLowerCase()}`;

    const spillResult = await spillover({
      canvas: instance,
      source: rows,
      tableName,
      previewChars: 40_000, // ~10k tokens preview
      signal: ctx.signal,
    });

    ctx.log.info('Spilled to canvas', {
      canvasId: instance.canvasId,
      tableName,
      rowCount: rows.length,
      spilled: spillResult.spilled,
    });

    // Build inline rate map from preview rows for the response
    const previewRates: Record<string, number> = {};
    for (const row of spillResult.previewRows) {
      const r = row as { date: string; rate: number };
      previewRates[r.date] = r.rate;
    }

    if (spillResult.spilled) {
      return {
        ...envelope,
        rates: previewRates,
        rate_count: spillResult.handle.rowCount,
        spilled: true,
        canvas_id: instance.canvasId,
        table_name: spillResult.handle.tableName,
      };
    }

    // Fell under budget even at canvas threshold — return inline
    return {
      ...envelope,
      rates: previewRates,
      rate_count: spillResult.previewRows.length,
      spilled: false,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.base_currency}/${result.quote_currency} time series** — ${result.start_date} to ${result.end_date}`,
      `*${result.rate_count} publication-day data points · ${result.rate_type} · ${result.source} · spilled: ${result.spilled}*`,
    ];

    if (result.spilled) {
      lines.push(
        `\n📊 **Result staged on DataCanvas** (large range)`,
        `Canvas ID: \`${result.canvas_id}\``,
        `Table: \`${result.table_name}\``,
        `Use \`fx_dataframe_query\` with this canvas_id to run SQL. Preview (first entries below):`,
      );
    }

    const rateEntries = Object.entries(result.rates)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 20);
    if (rateEntries.length > 0) {
      lines.push('');
      for (const [date, rate] of rateEntries) {
        lines.push(`${date}: ${rate}`);
      }
      if (Object.keys(result.rates).length > 20) {
        lines.push(`... (${Object.keys(result.rates).length - 20} more entries)`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
