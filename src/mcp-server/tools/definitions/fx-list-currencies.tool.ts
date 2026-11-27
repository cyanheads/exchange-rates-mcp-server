/**
 * @fileoverview fx_list_currencies — lists all supported ISO 4217 currency codes.
 * @module mcp-server/tools/definitions/fx-list-currencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';
import { STATUTORY_SOURCE } from '@/services/frankfurter/statutory-euro-rates.js';

export const fxListCurrencies = tool('fx_list_currencies', {
  description:
    'List current Frankfurter v1 currency codes and names with as_of, the latest served rate date. include_retired=true adds historical and statutory euro legacy codes absent from the current set, each marked retired=true. Statutory rows include their euro adoption date and fixed units per EUR. Optional official ECB start_date/end_date are outer market coverage bounds. Metadata outages are disclosed without failing current discovery. Use this to disambiguate dollars (USD vs AUD vs CAD).',
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
        'Include historical codes absent from current v1 discovery, marked retired=true; default false. Optional official ECB coverage dates are outer bounds and may contain gaps.',
      ),
  }),
  output: z.object({
    currencies: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 4217 currency code (e.g. USD, EUR, JPY).'),
            name: z.string().describe('Full currency name (e.g. "United States Dollar").'),
            adoption_date: z
              .string()
              .optional()
              .describe('Date the statutory factor took effect (YYYY-MM-DD).'),
            units_per_eur: z
              .number()
              .optional()
              .describe('Irrevocable legacy currency units per EUR.'),
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
                'Last covered date in optional official ECB metadata; retired marks retirement, not this date.',
              ),
            retired: z
              .boolean()
              .describe(
                'True only for a historical code include_retired added because it is absent from current v1 discovery; false for every current code.',
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
    fixed_rate_source: z
      .string()
      .optional()
      .describe('Legislation setting the statutory factors shown.'),
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
      ...(currencies.some((currency) => currency.adoption_date) && {
        fixed_rate_source: STATUTORY_SOURCE,
      }),
    };
  },

  format: (result) => {
    const lines = [
      `**${result.count} currencies** (${result.source}; as_of: ${result.as_of}; optional coverage dates are outer bounds, not uninterrupted availability)\n`,
      ...(result.fixed_rate_source ? [`Statutory euro factors: ${result.fixed_rate_source}`] : []),
      ...result.currencies.map(
        (c) =>
          `**${c.code}** — ${c.name}${c.start_date ? ` · start_date: ${c.start_date}` : ''}${c.end_date ? ` · end_date: ${c.end_date}` : ''}${c.adoption_date ? ` · adopted euro ${c.adoption_date} at ${c.units_per_eur} per EUR` : ''}${c.retired ? ' · retired' : ''}`,
      ),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
