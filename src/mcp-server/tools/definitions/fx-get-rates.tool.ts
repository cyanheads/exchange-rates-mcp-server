/**
 * @fileoverview fx_get_rates — bulk snapshot of all rates for one base currency.
 * @module mcp-server/tools/definitions/fx-get-rates.tool
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
import {
  MARKET_PROVENANCE,
  statutoryProvenance,
} from '@/services/frankfurter/statutory-euro-rates.js';
import type { ResolvedSnapshot } from '@/services/frankfurter/types.js';

export const fxGetRates = tool('fx_get_rates', {
  inputAliases: { base: 'base_currency' },
  description:
    'Get exchange rates for one base currency in a single snapshot, with provenance and the actual rate date. Omit symbols for the market snapshot’s available quote codes. Explicit legacy bases and symbols use statutory factors from euro adoption. Listing the base in symbols returns a rate of 1 for it.',
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
          'Frankfurter v1 data starts 1999-01-04; fixed-only rates start at euro adoption. Future dates are not supported.',
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
    rate_date: z.string().describe(RATE_DATE_DESCRIPTION),
    rates: z
      .record(z.string(), z.number())
      .describe('Map of quote currency code → exchange rate (units of quote per 1 base).'),
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
      when: 'date is in the future or precedes 1999-01-04 without an applicable fixed-only rate.',
      recovery: 'Frankfurter v1 data starts 1999-01-04; omit date for the latest available rate.',
    },
    {
      reason: 'upstream_no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every requested currency is supported but Frankfurter v1 has no observation for a requested currency on this date.',
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
        !supportedBeforeV1(date, input.base_currency, input.symbols ?? [])
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

    let raw: ResolvedSnapshot;
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
          failure.missing_codes
            ? (err as Error).message
            : `Frankfurter v1 returned no ${input.base_currency.trim().toUpperCase()} rates for ${
                date === 'latest' ? 'the latest published date' : date
              }.`,
          { ...failure },
        );
      }
      throw err;
    }

    const notice = redenominationNotice(raw.date, [raw.base, ...Object.keys(raw.rates)]);
    if (notice) ctx.enrich.notice(notice);

    ctx.log.info('Fetched rates snapshot', {
      base: input.base_currency,
      date: raw.date,
      count: Object.keys(raw.rates).length,
    });

    const provenance = raw.statutory
      ? statutoryProvenance(raw.statutory.market)
      : MARKET_PROVENANCE;
    return {
      base_currency: raw.base,
      rate_date: raw.date,
      rates: raw.rates,
      date_snapped: date !== 'latest' && raw.date !== date,
      rate_type: provenance.rateType,
      source: provenance.source,
      ...fixedRateFields(raw.statutory, raw.date),
    };
  },

  format: (result) => {
    const rateLines = Object.entries(result.rates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, rate]) => `**${code}**: ${rate}`);
    const snapNote = result.date_snapped ? `\n${dateSnapNote(result.rate_date)}` : '';
    return [
      {
        type: 'text',
        text:
          `**${result.base_currency} exchange rates** — ${result.rate_date}` +
          snapNote +
          `\n*${result.rate_type} · ${result.source}*` +
          formatFixedRates(result.fixed_rates, result.fixed_rate_date) +
          '\n\n' +
          rateLines.join('\n'),
      },
    ];
  },
});
