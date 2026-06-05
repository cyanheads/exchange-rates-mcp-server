/**
 * @fileoverview fx_list_currencies — lists all supported ISO 4217 currency codes.
 * @module mcp-server/tools/definitions/fx-list-currencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

export const fxListCurrencies = tool('fx_list_currencies', {
  description:
    'List all supported ISO 4217 currency codes with their full names. ' +
    'Call this before converting to disambiguate "dollars" (USD vs AUD vs CAD vs HKD vs SGD) ' +
    'or to validate a user-supplied currency code. Covers the ~30 ECB reference currencies.',
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
    source: z.string().describe('Always "ECB via Frankfurter" — the upstream data provider.'),
  }),

  async handler(_input, ctx) {
    const service = getFrankfurterService();
    const currencies = await service.listCurrencies();
    ctx.log.info('Listed currencies', { count: currencies.length });
    return {
      currencies,
      count: currencies.length,
      source: 'ECB via Frankfurter',
    };
  },

  format: (result) => {
    const lines = [
      `**${result.count} supported currencies** (${result.source})\n`,
      ...result.currencies.map((c) => `**${c.code}** — ${c.name}`),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
