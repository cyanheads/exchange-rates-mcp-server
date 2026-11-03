/**
 * @fileoverview fx_list_currencies — lists all supported ISO 4217 currency codes.
 * @module mcp-server/tools/definitions/fx-list-currencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

export const fxListCurrencies = tool('fx_list_currencies', {
  description:
    'List current Frankfurter v1 currency codes and names with as_of, the latest served rate date. include_retired=true adds historical codes absent from the current set. Optional official ECB start_date/end_date are outer coverage bounds, not uninterrupted availability; a dated end_date does not imply retirement. Metadata outages are disclosed without failing current discovery. Historical availability remains validated from requested v1 data. Use this to disambiguate dollars (USD vs AUD vs CAD).',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    include_retired: z
      .boolean()
      .optional()
      .describe(
        'Include historical codes absent from current v1 discovery, default false. Optional official ECB coverage dates are outer bounds and may contain gaps.',
      ),
  }),
  output: z.object({
    currencies: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 4217 currency code (e.g. USD, EUR, JPY).'),
            name: z.string().describe('Full currency name (e.g. "United States Dollar").'),
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
                'Last covered date in optional official ECB metadata; a date here does not imply retirement.',
              ),
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
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Discloses unavailable optional coverage metadata or incomplete coverage dates.'),
  },

  async handler(input, ctx) {
    const service = getFrankfurterService();
    const { currencies, as_of, notice } = await service.currencyDiscovery(
      ctx.signal,
      input.include_retired ?? false,
    );
    if (notice) ctx.enrich.notice(notice);
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
      `**${result.count} currencies** (${result.source}; as_of: ${result.as_of}; optional coverage dates are outer bounds, not uninterrupted availability)\n`,
      ...result.currencies.map(
        (c) =>
          `**${c.code}** — ${c.name}${c.start_date ? ` · start_date: ${c.start_date}` : ''}${c.end_date ? ` · end_date: ${c.end_date}` : ''}`,
      ),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
