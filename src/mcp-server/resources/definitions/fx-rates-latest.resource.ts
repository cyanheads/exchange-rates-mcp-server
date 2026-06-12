/**
 * @fileoverview fx://rates/latest/{base} resource — latest rates snapshot for a base currency.
 * @module mcp-server/resources/definitions/fx-rates-latest.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

export const fxRatesLatestResource = resource('fx://rates/latest/{base}', {
  name: 'fx-rates-latest',
  description:
    'Latest exchange rates snapshot for a base currency as a stable URI. ' +
    'Returns all available quote currencies at the most recent ECB business-day fix.',
  mimeType: 'application/json',
  params: z.object({
    base: z.string().describe('ISO 4217 base currency code (e.g. USD, EUR, GBP).'),
  }),
  output: z.object({
    base_currency: z.string().describe('The base currency code.'),
    rate_date: z.string().describe('Actual date of the rates.'),
    rates: z
      .record(z.string(), z.number())
      .describe(
        'Map of quote currency code → exchange rate (units of quote currency per 1 unit of base).',
      ),
    rate_type: z
      .string()
      .describe(
        'Always "ECB reference (mid-market)" — these are reference rates, not tradeable bid/ask.',
      ),
    source: z.string().describe('Always "ECB via Frankfurter" — the upstream data provider.'),
  }),

  async handler(params, ctx) {
    const service = getFrankfurterService();
    let raw: Awaited<ReturnType<typeof service.getRates>>;
    try {
      raw = await service.getRates(params.base, 'latest');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('not found')) {
        throw validationError(
          `Currency "${params.base}" is not supported by the ECB. Call fx_list_currencies to get valid codes.`,
          { base: params.base },
          { cause: err },
        );
      }
      throw err;
    }
    ctx.log.info('Fetched latest rates resource', {
      base: params.base,
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

  list: () => ({
    resources: [
      { uri: 'fx://rates/latest/EUR', name: 'Latest EUR rates', mimeType: 'application/json' },
      { uri: 'fx://rates/latest/USD', name: 'Latest USD rates', mimeType: 'application/json' },
      { uri: 'fx://rates/latest/GBP', name: 'Latest GBP rates', mimeType: 'application/json' },
      { uri: 'fx://rates/latest/JPY', name: 'Latest JPY rates', mimeType: 'application/json' },
    ],
  }),
});
