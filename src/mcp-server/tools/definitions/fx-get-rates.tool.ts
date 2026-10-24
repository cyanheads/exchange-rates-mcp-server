/**
 * @fileoverview fx_get_rates — bulk snapshot of all rates for one base currency.
 * @module mcp-server/tools/definitions/fx-get-rates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { failureOf, unsupportedCurrencyCodesOf } from '@/services/frankfurter/errors.js';
import {
  ECB_START_DATE,
  getFrankfurterService,
  isIsoDate,
} from '@/services/frankfurter/frankfurter-service.js';
import type { FrankfurterRateResponse } from '@/services/frankfurter/types.js';

export const fxGetRates = tool('fx_get_rates', {
  inputAliases: { base: 'base_currency' },
  description:
    'Get all available exchange rates for one base currency in a single snapshot. ' +
    'Useful for bulk comparison and seeding downstream tools. ' +
    'Returns a map of quote currency → rate, the actual snapshot date, and whether a ' +
    'historical date was snapped from a weekend/holiday to the prior business day. ' +
    'Optionally filter to a subset of quote currencies via symbols. ' +
    'Listing the base currency itself in symbols is accepted and returns a rate of 1 for it.',
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
    date: z
      .string()
      .meta({ pattern: '^(?:\\d{4}-\\d{2}-\\d{2}|latest)$' })
      .optional()
      .describe(
        'ISO 8601 date (YYYY-MM-DD). Omit for the latest available rate. ' +
          'Frankfurter v1 data starts 1999-01-04. Future dates are not supported.',
      ),
    symbols: z
      .array(z.string().describe('ISO 4217 currency code to include in the response.'))
      .min(1)
      .optional()
      .describe(
        'Optional list of quote currency codes to filter the response. ' +
          'When provided, must contain at least one currency code — omit the field entirely, ' +
          'not an empty array, to return all ~30 supported currencies (the base is not among them). ' +
          'Including base_currency here is valid — it comes back with a rate of 1.',
      ),
  }),
  output: z.object({
    base_currency: z.string().describe('The base currency code.'),
    rate_date: z
      .string()
      .describe(
        'Actual date of the rates. May differ from requested date on weekends/holidays — ' +
          'daily observations may skip non-publication days; the API silently snaps to the prior business day.',
      ),
    rates: z
      .record(z.string(), z.number())
      .describe('Map of quote currency code → exchange rate (units of quote per 1 base).'),
    date_snapped: z
      .boolean()
      .describe(
        'True when the API returned a different date than requested — ' +
          'Frankfurter v1 snaps weekend/holiday requests to the prior business day. ' +
          'Always false when date is omitted.',
      ),
    rate_type: z
      .string()
      .describe(
        'Always "Daily rate (Frankfurter v1)" — these are reference rates, not tradeable bid/ask.',
      ),
    source: z.string().describe('Always "Frankfurter v1" — the upstream data provider.'),
  }),

  errors: [
    {
      reason: 'invalid_date_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date is not a real calendar date written as YYYY-MM-DD.',
      recovery: 'Pass an ISO 8601 calendar date in YYYY-MM-DD form, for example 2024-06-01.',
    },
    {
      reason: 'unsupported_currency',
      code: JsonRpcErrorCode.ValidationError,
      when: 'base_currency or an entry in symbols is not available in the current discovery or served historical data.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date is before 1999-01-04 or in the future.',
      recovery: 'Frankfurter v1 data starts 1999-01-04; omit date for the latest available rate.',
    },
    {
      reason: 'upstream_no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every requested currency is supported but the Frankfurter v1 published no rates for this date.',
      recovery: 'Try a more recent date — Frankfurter v1 history starts later for some currencies.',
    },
  ],

  async handler(input, ctx) {
    const service = getFrankfurterService();
    const date = input.date ?? 'latest';

    if (date !== 'latest') {
      /** Format first — the range comparisons below are lexicographic and would misread a malformed date. */
      if (!isIsoDate(date)) {
        throw ctx.fail(
          'invalid_date_format',
          `date "${date}" is not a valid YYYY-MM-DD calendar date.`,
          { field: 'date' },
        );
      }
      if (date < ECB_START_DATE) {
        throw ctx.fail(
          'date_out_of_range',
          `Date ${date} is before Frankfurter v1 data start ${ECB_START_DATE}.`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (date > today) {
        throw ctx.fail('date_out_of_range', `Date ${date} is in the future.`);
      }
    }

    let raw: FrankfurterRateResponse;
    try {
      raw = await service.getRates(input.base_currency, date, input.symbols, ctx.signal);
    } catch (err) {
      ctx.signal.throwIfAborted();
      const failure = failureOf(err);
      if (failure?.reason === 'unsupported_currency') {
        /** The service names the offending field and codes — base_currency and symbols are both reachable here. */
        throw ctx.fail('unsupported_currency', (err as Error).message, {
          field: failure.field,
          ...unsupportedCurrencyCodesOf(err),
        });
      }
      if (failure?.reason === 'upstream_no_data') {
        throw ctx.fail(
          'upstream_no_data',
          `Frankfurter v1 returned no ${input.base_currency} rates for ${
            date === 'latest' ? 'the latest business day' : date
          }.`,
        );
      }
      throw err;
    }

    ctx.log.info('Fetched rates snapshot', {
      base: input.base_currency,
      date: raw.date,
      count: Object.keys(raw.rates).length,
    });

    return {
      base_currency: raw.base,
      rate_date: raw.date,
      rates: raw.rates,
      date_snapped: date !== 'latest' && raw.date !== date,
      rate_type: 'Daily rate (Frankfurter v1)',
      source: 'Frankfurter v1',
    };
  },

  format: (result) => {
    const rateLines = Object.entries(result.rates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, rate]) => `**${code}**: ${rate}`);
    const snapNote = result.date_snapped
      ? `\n⚠️ *Requested date snapped to ${result.rate_date} (weekend/holiday — daily observations may skip non-publication days)*`
      : '';
    return [
      {
        type: 'text',
        text:
          `**${result.base_currency} exchange rates** — ${result.rate_date}` +
          snapNote +
          `\n*${result.rate_type} · ${result.source}*\n\n` +
          rateLines.join('\n'),
      },
    ];
  },
});
