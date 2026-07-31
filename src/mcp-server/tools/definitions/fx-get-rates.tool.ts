/**
 * @fileoverview fx_get_rates — bulk snapshot of all rates for one base currency.
 * @module mcp-server/tools/definitions/fx-get-rates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { failureOf } from '@/services/frankfurter/errors.js';
import {
  ECB_START_DATE,
  getFrankfurterService,
  isIsoDate,
} from '@/services/frankfurter/frankfurter-service.js';
import type { FrankfurterRateResponse } from '@/services/frankfurter/types.js';

export const fxGetRates = tool('fx_get_rates', {
  description:
    'Get all available exchange rates for one base currency in a single snapshot. ' +
    'Useful for bulk comparison and seeding downstream tools. ' +
    'Returns a map of quote currency → rate plus the snapshot date. ' +
    'Optionally filter to a subset of quote currencies via symbols. ' +
    'Listing the base currency itself in symbols is accepted and returns a rate of 1 for it.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    base_currency: z
      .string()
      .describe(
        'ISO 4217 base currency code (e.g. USD). Call fx_list_currencies to get valid codes.',
      ),
    date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 date (YYYY-MM-DD). Omit for the latest available rate. ' +
          'ECB data starts 1999-01-04. Future dates are not supported.',
      ),
    symbols: z
      .array(z.string().describe('ISO 4217 currency code to include in the response.'))
      .optional()
      .describe(
        'Optional list of quote currency codes to filter the response. ' +
          'Omit to return all ~30 supported currencies (the base is not among them). ' +
          'Including base_currency here is valid — it comes back with a rate of 1.',
      ),
  }),
  output: z.object({
    base_currency: z.string().describe('The base currency code.'),
    rate_date: z
      .string()
      .describe(
        'Actual date of the rates. May differ from requested date on weekends/holidays — ' +
          'ECB publishes business days only; the API silently snaps to the prior business day.',
      ),
    rates: z
      .record(z.string(), z.number())
      .describe('Map of quote currency code → exchange rate (units of quote per 1 base).'),
    rate_type: z
      .string()
      .describe(
        'Always "ECB reference (mid-market)" — these are reference rates, not tradeable bid/ask.',
      ),
    source: z.string().describe('Always "ECB via Frankfurter" — the upstream data provider.'),
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
      when: 'base_currency or an entry in symbols is not in the ECB currency set.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date is before 1999-01-04 or in the future.',
      recovery: 'ECB data starts 1999-01-04; omit date for the latest available rate.',
    },
    {
      reason: 'upstream_no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every requested currency is supported but the ECB published no rates for this date.',
      recovery: 'Try a more recent date — ECB history starts later for some currencies.',
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
          { ...ctx.recoveryFor('invalid_date_format'), field: 'date' },
        );
      }
      if (date < ECB_START_DATE) {
        throw ctx.fail(
          'date_out_of_range',
          `Date ${date} is before ECB data start ${ECB_START_DATE}.`,
          {
            ...ctx.recoveryFor('date_out_of_range'),
          },
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (date > today) {
        throw ctx.fail('date_out_of_range', `Date ${date} is in the future.`, {
          ...ctx.recoveryFor('date_out_of_range'),
        });
      }
    }

    let raw: FrankfurterRateResponse;
    try {
      raw = await service.getRates(input.base_currency, date, input.symbols);
    } catch (err) {
      const failure = failureOf(err);
      if (failure?.reason === 'unsupported_currency') {
        /** The service names the offending field and codes — base_currency and symbols are both reachable here. */
        throw ctx.fail('unsupported_currency', (err as Error).message, {
          ...ctx.recoveryFor('unsupported_currency'),
          field: failure.field,
        });
      }
      if (failure?.reason === 'upstream_no_data') {
        throw ctx.fail(
          'upstream_no_data',
          `The ECB published no ${input.base_currency} rates for ${
            date === 'latest' ? 'the latest business day' : date
          }.`,
          { ...ctx.recoveryFor('upstream_no_data') },
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
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };
  },

  format: (result) => {
    const rateLines = Object.entries(result.rates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, rate]) => `**${code}**: ${rate}`);
    return [
      {
        type: 'text',
        text:
          `**${result.base_currency} exchange rates** — ${result.rate_date}\n` +
          `*${result.rate_type} · ${result.source}*\n\n` +
          rateLines.join('\n'),
      },
    ];
  },
});
