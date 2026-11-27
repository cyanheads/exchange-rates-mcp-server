/**
 * @fileoverview Wire descriptions and rendering for statutory euro conversion provenance.
 * @module mcp-server/tools/statutory-rate-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { StatutoryRate } from '@/services/frankfurter/statutory-euro-rates.js';
import type { ResolvedSnapshot } from '@/services/frankfurter/types.js';

export const RATE_TYPE_DESCRIPTION =
  'Identifies Frankfurter v1 reference rates, statutory euro conversion, or a combination.';
export const RATE_SOURCE_DESCRIPTION = 'Source of the factors used in this result.';

/** The statutory fields carry the original legal factors in their published direction. */
export const fixedRatesSchema = z
  .array(
    z
      .object({
        code: z.string().describe('Legacy currency code.'),
        adoption_date: z.string().describe('First date the statutory factor applies (YYYY-MM-DD).'),
        units_per_eur: z.number().describe('Statutory units of this currency per EUR.'),
      })
      .describe('One statutory euro conversion factor.'),
  )
  .optional()
  .describe('Statutory factors used in the result, present only when a fixed leg was used.');

export const fixedRateDateSchema = z
  .string()
  .optional()
  .describe(
    'Date the statutory factors were applied, when different from the served market rate_date.',
  );

/** Include the statutory date only when it differs from the returned rate date. */
export function fixedRateFields(statutory: ResolvedSnapshot['statutory'], rateDate: string) {
  if (!statutory) return {};
  return {
    fixed_rates: statutory.fixedRates,
    ...(statutory.date !== rateDate && { fixed_rate_date: statutory.date }),
  };
}

/** Preserve the distinction between a snapped market date and the statutory as-of date. */
export function formatFixedRates(
  fixedRates: StatutoryRate[] | undefined,
  fixedDate?: string,
): string {
  if (!fixedRates) return '';
  const factors = fixedRates.map(
    ({ code, units_per_eur, adoption_date }) =>
      `${code} ${units_per_eur} per EUR (effective ${adoption_date})`,
  );
  return `\nStatutory factors${fixedDate ? ` applied on ${fixedDate}` : ''}: ${factors.join('; ')}.`;
}
