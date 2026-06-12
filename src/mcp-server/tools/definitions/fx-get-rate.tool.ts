/**
 * @fileoverview fx_get_rate — get the exchange rate for a single currency pair.
 * @module mcp-server/tools/definitions/fx-get-rate.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ECB_START_DATE,
  getFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

export const fxGetRate = tool('fx_get_rate', {
  description:
    'Get the exchange rate for a currency pair on a given date (default: latest). ' +
    'Returns the rate, the actual rate date (which may differ from the requested date on ' +
    'weekends/holidays — ECB publishes business days only), and source provenance. ' +
    'Cross-rates are triangulated through EUR automatically. ' +
    'Use fx_convert_currency when you want the converted amount; use this tool when you only need the rate number.',
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
        'ISO 4217 quote currency code (e.g. EUR). The rate is expressed as "how many quote units per 1 base unit".',
      ),
    date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 date (YYYY-MM-DD). Omit for the latest available rate. ' +
          'ECB data starts 1999-01-04. Future dates are not supported.',
      ),
  }),
  output: z.object({
    base_currency: z.string().describe('The base currency code.'),
    quote_currency: z.string().describe('The quote currency code.'),
    rate: z
      .number()
      .describe('Exchange rate: units of quote currency per 1 unit of base currency.'),
    rate_date: z.string().describe('Actual date of the rate returned.'),
    date_snapped: z
      .boolean()
      .describe(
        'True when the API returned a different date than requested — ' +
          'ECB silently snaps weekend/holiday requests to the prior business day.',
      ),
    rate_type: z
      .string()
      .describe(
        'Always "ECB reference (mid-market)" — these are reference rates, not tradeable bid/ask.',
      ),
    source: z.string().describe('Always "ECB via Frankfurter" — the upstream data provider.'),
  }),

  errors: [
    {
      reason: 'unsupported_currency',
      code: JsonRpcErrorCode.ValidationError,
      when: 'base_currency or quote_currency is not in the ECB currency set.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date is before 1999-01-04 or in the future.',
      recovery: 'ECB data starts 1999-01-04; omit date for the latest available rate.',
    },
  ],

  async handler(input, ctx) {
    const service = getFrankfurterService();
    const date = input.date ?? 'latest';

    if (date !== 'latest') {
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

    let resolved: ResolvedRate;
    try {
      resolved = await service.getRate(input.base_currency, input.quote_currency, date);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('not found')) {
        throw ctx.fail(
          'unsupported_currency',
          `Currency pair "${input.base_currency}/${input.quote_currency}" not available from ECB.`,
          { ...ctx.recoveryFor('unsupported_currency') },
        );
      }
      throw err;
    }

    ctx.log.info('Fetched rate', {
      base: resolved.baseCurrency,
      quote: resolved.quoteCurrency,
      rate: resolved.rate,
      date: resolved.rateDate,
      snapped: resolved.dateSnapped,
    });

    return {
      base_currency: resolved.baseCurrency,
      quote_currency: resolved.quoteCurrency,
      rate: resolved.rate,
      rate_date: resolved.rateDate,
      date_snapped: resolved.dateSnapped,
      rate_type: resolved.rateType,
      source: resolved.source,
    };
  },

  format: (result) => {
    const snapNote = result.date_snapped
      ? `\n⚠️ *Requested date snapped to ${result.rate_date} (weekend/holiday — ECB publishes business days only)*`
      : '';
    return [
      {
        type: 'text',
        text:
          `**${result.base_currency}/${result.quote_currency}** — ${result.rate_date}\n` +
          `Rate: **${result.rate}** (${result.quote_currency} per ${result.base_currency})` +
          snapNote +
          `\n*${result.rate_type} · ${result.source}*`,
      },
    ];
  },
});
