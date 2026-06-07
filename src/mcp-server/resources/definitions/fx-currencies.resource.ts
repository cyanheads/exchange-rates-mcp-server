/**
 * @fileoverview fx://currencies resource — stable reference document for all supported currencies.
 * @module mcp-server/resources/definitions/fx-currencies.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

export const fxCurrenciesResource = resource('fx://currencies', {
  name: 'fx-currencies',
  description:
    'All supported ISO 4217 currency codes with full names. Covers the ~30 ECB reference currencies.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    currencies: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 4217 currency code.'),
            name: z.string().describe('Full currency name.'),
          })
          .describe('A single supported currency.'),
      )
      .describe('All supported currencies, sorted alphabetically by code.'),
    count: z.number().describe('Total number of supported currencies.'),
    source: z.string().describe('Always "ECB via Frankfurter" — the upstream data provider.'),
  }),

  async handler(_params, ctx) {
    const service = getFrankfurterService();
    const currencies = await service.listCurrencies();
    ctx.log.info('Fetched currencies resource', { count: currencies.length });
    return { currencies, count: currencies.length, source: 'ECB via Frankfurter' };
  },

  list: () => ({
    resources: [
      {
        uri: 'fx://currencies',
        name: 'Supported Currencies',
        mimeType: 'application/json',
        description: 'All ISO 4217 currency codes supported by ECB/Frankfurter.',
      },
    ],
  }),
});
