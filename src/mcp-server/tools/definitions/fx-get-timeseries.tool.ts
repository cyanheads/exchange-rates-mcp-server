/**
 * @fileoverview fx_get_timeseries — historical daily rates for a currency pair over a date range.
 * @module mcp-server/tools/definitions/fx-get-timeseries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  ECB_START_DATE,
  getFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

export const fxGetTimeseries = tool('fx_get_timeseries', {
  description:
    'Get historical daily exchange rates for a currency pair over a date range. ' +
    'ECB publishes on business days only — weekends and holidays produce no entry (not snapped). ' +
    'Short ranges (≤90 days by default) are returned inline as a date→rate map. ' +
    'Long ranges spill to DataCanvas: the response carries spilled=true, a canvas_id, and a table_name. ' +
    'Call fx_dataframe_describe to inspect the staged table, then fx_dataframe_query to run SQL against it.',
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
        'Actual first date in the returned series (may differ from requested if that date had no ECB fix).',
      ),
    end_date: z
      .string()
      .describe(
        'Actual last date in the returned series (may differ from requested if that date had no ECB fix).',
      ),
    rates: z
      .record(z.string(), z.number())
      .describe(
        'Date → rate map for the inline result. Business days only. ' +
          'Empty when the result was spilled to canvas.',
      ),
    rate_count: z.number().describe('Total number of data points (business days) in the range.'),
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

  errors: [
    {
      reason: 'unsupported_currency',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'base_currency or quote_currency is not in the ECB currency set.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'start_date is before 1999-01-04 or end_date is in the future.',
      recovery: "ECB data starts 1999-01-04; omit end_date or use today's date.",
    },
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'start_date is after end_date.',
      recovery: 'Ensure start_date is before or equal to end_date.',
    },
  ],

  async handler(input, ctx) {
    const service = getFrankfurterService();
    const config = getServerConfig();
    const today = new Date().toISOString().slice(0, 10);

    // Validate dates
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

    let raw: Awaited<ReturnType<typeof service.getTimeSeries>>['raw'];
    let rows: Awaited<ReturnType<typeof service.getTimeSeries>>['rows'];
    try {
      ({ raw, rows } = await service.getTimeSeries(
        input.base_currency,
        input.quote_currency,
        input.start_date,
        input.end_date,
      ));
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('not found')) {
        throw ctx.fail(
          'unsupported_currency',
          `Currency "${input.base_currency}" or "${input.quote_currency}" not available from ECB.`,
          { ...ctx.recoveryFor('unsupported_currency') },
        );
      }
      throw err;
    }

    const actualStart = raw.start_date;
    const actualEnd = raw.end_date;

    ctx.log.info('Fetched timeseries', {
      base: input.base_currency,
      quote: input.quote_currency,
      start: actualStart,
      end: actualEnd,
      points: rows.length,
      dayCount,
    });

    // Inline path — short range
    const canvas = getCanvas();
    const shouldSpill = canvas != null && dayCount > config.timeseriesCanvasThresholdDays;

    if (!shouldSpill) {
      const rateMap: Record<string, number> = {};
      for (const row of rows) rateMap[row.date] = row.rate;
      return {
        base_currency: input.base_currency.toUpperCase(),
        quote_currency: input.quote_currency.toUpperCase(),
        start_date: actualStart,
        end_date: actualEnd,
        rates: rateMap,
        rate_count: rows.length,
        rate_type: 'ECB reference (mid-market)',
        source: 'ECB via Frankfurter',
        spilled: false,
      };
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
        base_currency: input.base_currency.toUpperCase(),
        quote_currency: input.quote_currency.toUpperCase(),
        start_date: actualStart,
        end_date: actualEnd,
        rates: previewRates,
        rate_count: spillResult.handle.rowCount,
        rate_type: 'ECB reference (mid-market)',
        source: 'ECB via Frankfurter',
        spilled: true,
        canvas_id: instance.canvasId,
        table_name: spillResult.handle.tableName,
      };
    }

    // Fell under budget even at canvas threshold — return inline
    const rateMap: Record<string, number> = {};
    for (const row of spillResult.previewRows) {
      const r = row as { date: string; rate: number };
      rateMap[r.date] = r.rate;
    }
    return {
      base_currency: input.base_currency.toUpperCase(),
      quote_currency: input.quote_currency.toUpperCase(),
      start_date: actualStart,
      end_date: actualEnd,
      rates: rateMap,
      rate_count: spillResult.previewRows.length,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
      spilled: false,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.base_currency}/${result.quote_currency} time series** — ${result.start_date} to ${result.end_date}`,
      `*${result.rate_count} business-day data points · ${result.rate_type} · ${result.source} · spilled: ${result.spilled}*`,
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
