/**
 * @fileoverview fx_convert_currency — convert an amount between any two currencies.
 * @module mcp-server/tools/definitions/fx-convert-currency.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ECB_START_DATE,
  getFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

export const fxConvertCurrency = tool('fx_convert_currency', {
  description:
    'Convert an amount between any two currencies at the latest or a historical rate. ' +
    'Returns the converted amount, the rate used, the actual rate date, and whether the ' +
    'date was snapped from a weekend/holiday to the prior business day. ' +
    'Cross-rates are triangulated through EUR automatically. ' +
    'The primary tool for agent-driven FX workflows.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    base_currency: z
      .string()
      .describe(
        'ISO 4217 source currency code (e.g. USD). Call fx_list_currencies to get valid codes.',
      ),
    quote_currency: z
      .string()
      .describe(
        'ISO 4217 target currency code (e.g. EUR). The amount will be expressed in this currency.',
      ),
    amount: z
      .number()
      .describe('Amount in the base currency to convert. Must be a positive number.'),
    date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 date (YYYY-MM-DD) for a historical rate. Omit for the latest available rate. ' +
          'ECB data starts 1999-01-04. Future dates are not supported.',
      ),
  }),
  output: z.object({
    base_currency: z.string().describe('Source currency code.'),
    quote_currency: z.string().describe('Target currency code.'),
    base_amount: z.number().describe('The input amount in the base currency.'),
    quote_amount: z
      .number()
      .describe('The converted amount in the quote currency, rounded to 6 decimal places.'),
    rate: z
      .number()
      .describe('Exchange rate used: units of quote currency per 1 unit of base currency.'),
    rate_date: z.string().describe('Actual date of the rate used for conversion.'),
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
      code: JsonRpcErrorCode.InvalidParams,
      when: 'base_currency or quote_currency is not in the ECB currency set.',
      recovery: 'Call fx_list_currencies to get the list of valid currency codes.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
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
          `Currency "${input.base_currency}" or "${input.quote_currency}" is not supported by the ECB.`,
          { ...ctx.recoveryFor('unsupported_currency') },
        );
      }
      throw err;
    }

    const quoteAmount = Math.round(input.amount * resolved.rate * 1_000_000) / 1_000_000;

    ctx.log.info('Converted currency', {
      base: resolved.baseCurrency,
      quote: resolved.quoteCurrency,
      amount: input.amount,
      result: quoteAmount,
      rate: resolved.rate,
      date: resolved.rateDate,
      snapped: resolved.dateSnapped,
    });

    return {
      base_currency: resolved.baseCurrency,
      quote_currency: resolved.quoteCurrency,
      base_amount: input.amount,
      quote_amount: quoteAmount,
      rate: resolved.rate,
      rate_date: resolved.rateDate,
      date_snapped: resolved.dateSnapped,
      rate_type: resolved.rateType,
      source: resolved.source,
    };
  },

  format: (result) => {
    const snapNote = result.date_snapped
      ? `\n⚠️ *Requested date snapped to ${result.rate_date} (weekend/holiday)*`
      : '';
    return [
      {
        type: 'text',
        text:
          `**${result.base_amount} ${result.base_currency}** = **${result.quote_amount} ${result.quote_currency}**\n` +
          `Rate: ${result.rate} (${result.quote_currency}/${result.base_currency}) · ${result.rate_date}` +
          snapNote +
          `\n*${result.rate_type} · ${result.source}*`,
      },
    ];
  },
});
