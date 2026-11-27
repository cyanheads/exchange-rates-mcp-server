/**
 * @fileoverview fx_convert_currency — convert an amount between any two currencies.
 * @module mcp-server/tools/definitions/fx-convert-currency.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DATE_SNAPPED_DESCRIPTION,
  dateSnapNote,
  RATE_DATE_DESCRIPTION,
} from '@/mcp-server/tools/date-snap.js';
import {
  fixedRateDateSchema,
  fixedRateFields,
  fixedRatesSchema,
  formatFixedRates,
  RATE_SOURCE_DESCRIPTION,
  RATE_TYPE_DESCRIPTION,
} from '@/mcp-server/tools/statutory-rate-output.js';
import { failureOf, unsupportedCurrencyCodesOf } from '@/services/frankfurter/errors.js';
import {
  ECB_START_DATE,
  getFrankfurterService,
  isIsoDate,
  supportedBeforeV1,
} from '@/services/frankfurter/frankfurter-service.js';
import { redenominationNotice } from '@/services/frankfurter/redenomination.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

const MIN_NORMAL_NUMBER = 2 ** -1022;

export const fxConvertCurrency = tool('fx_convert_currency', {
  inputAliases: {
    base: 'base_currency',
    quote: 'quote_currency',
    from: 'base_currency',
    from_currency: 'base_currency',
    to: 'quote_currency',
    to_currency: 'quote_currency',
  },
  description:
    'Convert an amount between currencies using the latest or a historical rate. Returns the converted amount, rate, effective date and provenance. Legacy euro currencies use statutory factors from their adoption date. Cross-rates are triangulated through EUR without applying an accounting rounding policy.',
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
        'ISO 4217 target currency code (e.g. EUR). The amount will be expressed in this currency. ' +
          'Call fx_list_currencies to get valid codes.',
      ),
    amount: z
      .number()
      .positive()
      .describe('Amount in the base currency to convert. Must be greater than zero.'),
    date: z
      .string()
      .meta({ pattern: '^(?:\\d{4}-\\d{2}-\\d{2}|latest)$' })
      .optional()
      .describe(
        'ISO 8601 date (YYYY-MM-DD) for a historical rate. Omit for the latest available rate. ' +
          'Frankfurter v1 data starts 1999-01-04; fixed-only rates start at euro adoption. Future dates are not supported.',
      ),
  }),
  output: z.object({
    base_currency: z.string().describe('Source currency code.'),
    quote_currency: z.string().describe('Target currency code.'),
    base_amount: z.number().describe('The input amount in the base currency.'),
    quote_amount: z
      .number()
      .describe(
        'Unrounded conversion at JavaScript floating-point precision, without a currency minor-unit rounding policy.',
      ),
    rate: z
      .number()
      .describe('Exchange rate used: units of quote currency per 1 unit of base currency.'),
    rate_date: z.string().describe(RATE_DATE_DESCRIPTION),
    date_snapped: z.boolean().describe(DATE_SNAPPED_DESCRIPTION),
    rate_type: z.string().describe(RATE_TYPE_DESCRIPTION),
    source: z.string().describe(RATE_SOURCE_DESCRIPTION),
    fixed_rates: fixedRatesSchema,
    fixed_rate_date: fixedRateDateSchema,
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Discloses restated units for historical RON or TRY rates.'),
  },

  errors: [
    {
      reason: 'amount_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'amount is too large to produce a finite value at the resolved rate.',
      recovery: 'Pass a smaller amount for this currency pair.',
    },
    {
      reason: 'invalid_date_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date is not a real calendar date written as YYYY-MM-DD.',
      recovery: 'Pass an ISO 8601 calendar date in YYYY-MM-DD form, for example 2024-06-01.',
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
      when: 'date is in the future or precedes 1999-01-04 without an applicable fixed-only rate.',
      recovery: 'Frankfurter v1 data starts 1999-01-04; omit date for the latest available rate.',
    },
    {
      reason: 'upstream_no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Both currencies are supported but Frankfurter v1 has no observation for a requested currency on this date.',
      recovery:
        "Request a date inside the currency's coverage bounds (currency_windows, or fx_list_currencies); bounds can contain gaps, so widen the range with fx_get_timeseries to find observed dates.",
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
      if (
        date < ECB_START_DATE &&
        !supportedBeforeV1(date, input.base_currency, [input.quote_currency])
      ) {
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

    let resolved: ResolvedRate;
    try {
      resolved = await service.getRate(input.base_currency, input.quote_currency, date, ctx.signal);
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
          failure.missing_codes
            ? (err as Error).message
            : `Frankfurter v1 returned no ${input.base_currency.trim().toUpperCase()}/${input.quote_currency.trim().toUpperCase()} rate for ${
                date === 'latest' ? 'the latest published date' : date
              }.`,
          { ...failure },
        );
      }
      throw err;
    }

    let quoteAmount = input.amount * resolved.rate;
    if (resolved.legs && resolved.baseCurrency !== resolved.quoteCurrency) {
      const amountInEur = input.amount / resolved.legs.base;
      // Applying the second leg can magnify precision lost in a subnormal EUR amount.
      if (Number.isFinite(amountInEur) && amountInEur >= MIN_NORMAL_NUMBER) {
        quoteAmount = amountInEur * resolved.legs.quote;
      }
    }
    if (!Number.isFinite(quoteAmount)) {
      throw ctx.fail(
        'amount_out_of_range',
        'The converted amount exceeds the numeric range. Pass a smaller amount.',
        {
          field: 'amount',
        },
      );
    }

    const notice = redenominationNotice(resolved.rateDate, [
      resolved.baseCurrency,
      resolved.quoteCurrency,
    ]);
    if (notice) ctx.enrich.notice(notice);

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
      ...fixedRateFields(resolved.statutory, resolved.rateDate),
    };
  },

  format: (result) => {
    const snapNote = result.date_snapped ? `\n${dateSnapNote(result.rate_date)}` : '';
    return [
      {
        type: 'text',
        text:
          `**${result.base_amount} ${result.base_currency}** = **${result.quote_amount} ${result.quote_currency}**\n` +
          `Rate: ${result.rate} (${result.quote_currency} per ${result.base_currency}) · ${result.rate_date}` +
          snapNote +
          `\n*${result.rate_type} · ${result.source}*` +
          formatFixedRates(result.fixed_rates, result.fixed_rate_date),
      },
    ];
  },
});
