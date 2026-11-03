/**
 * @fileoverview fx://currencies resource — stable reference document for all supported currencies.
 * @module mcp-server/resources/definitions/fx-currencies.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

export const fxCurrenciesResource = resource('fx://currencies', {
  name: 'fx-currencies',
  description:
    'Current Frankfurter v1 currency discovery with full names and the latest served rate date as_of. Historical availability is checked against historical data, including retired currencies.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    currencies: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 4217 currency code.'),
            name: z.string().describe('Full currency name.'),
            start_date: z
              .string()
              .optional()
              .describe(
                'First covered date in optional official ECB metadata; outer bound, not uninterrupted availability.',
              ),
            end_date: z
              .string()
              .optional()
              .describe(
                'Last covered date in optional official ECB metadata; does not imply retirement.',
              ),
          })
          .describe('A single supported currency.'),
      )
      .describe('All supported currencies, sorted alphabetically by code.'),
    count: z.number().describe('Total number of supported currencies.'),
    as_of: z
      .string()
      .describe(
        'Latest served rate date for current discovery; historical availability is checked against historical data.',
      ),
    source: z.string().describe('Always "Frankfurter v1" — the upstream data provider.'),
    notice: z.string().optional().describe('Explains unavailable optional coverage metadata.'),
  }),

  async handler(_params, ctx) {
    const service = getFrankfurterService();
    const { currencies, as_of, notice } = await service.currencyDiscovery(ctx.signal);
    ctx.log.info('Fetched currencies resource', { count: currencies.length });
    return {
      currencies,
      count: currencies.length,
      as_of,
      source: 'Frankfurter v1',
      ...(notice && { notice }),
    };
  },

  list: () => ({
    resources: [
      {
        uri: 'fx://currencies',
        name: 'Supported Currencies',
        mimeType: 'application/json',
        description: 'Current Frankfurter v1 currency discovery with the latest served rate date.',
      },
    ],
  }),
});
