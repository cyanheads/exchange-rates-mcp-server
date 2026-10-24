/**
 * @fileoverview fx_list_currencies — lists all supported ISO 4217 currency codes.
 * @module mcp-server/tools/definitions/fx-list-currencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

export const fxListCurrencies = tool('fx_list_currencies', {
  description:
    'List currently supported ISO 4217 currency codes with full names and as_of, the latest served rate date. Use this to disambiguate dollars (USD vs AUD vs CAD). Historical availability is checked against the requested historical snapshot or range and can include retired currencies absent from current discovery.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({}),
  output: z.object({
    currencies: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 4217 currency code (e.g. USD, EUR, JPY).'),
            name: z.string().describe('Full currency name (e.g. "United States Dollar").'),
          })
          .describe('A single supported currency.'),
      )
      .describe('All supported currencies, sorted alphabetically by code.'),
    count: z.number().describe('Total number of supported currencies.'),
    as_of: z
      .string()
      .describe(
        'Latest served daily rate date for this current-discovery list; historical availability is checked against historical data.',
      ),
    source: z.string().describe('Always "Frankfurter v1" — the upstream data provider.'),
  }),

  async handler(_input, ctx) {
    const service = getFrankfurterService();
    const { currencies, as_of } = await service.currencyDiscovery(ctx.signal);
    ctx.log.info('Listed currencies', { count: currencies.length });
    return {
      currencies,
      count: currencies.length,
      as_of,
      source: 'Frankfurter v1',
    };
  },

  format: (result) => {
    const lines = [
      `**${result.count} currently supported currencies** (${result.source}; as_of: ${result.as_of})\n`,
      ...result.currencies.map((c) => `**${c.code}** — ${c.name}`),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
