/**
 * @fileoverview Optional official ECB currency coverage, independent of v1 rate availability.
 * @module services/frankfurter/currency-metadata
 */
import { z } from '@cyanheads/mcp-ts-core';
import type { Currency } from './types.js';

const MetadataSchema = z.array(
  z
    .object({
      iso_code: z.string().regex(/^[A-Z]{3}$/),
      name: z.string().min(1),
      start_date: z.iso.date(),
      end_date: z.iso.date(),
    })
    .refine((currency) => currency.start_date <= currency.end_date),
);

/** One short request, including body read, with no retries or caller-shared in-flight state. */
export async function fetchCurrencyMetadata(
  userAgent: string,
  signal?: AbortSignal,
): Promise<Currency[] | undefined> {
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1_000)]);
  let body: unknown;
  try {
    const response = await fetch(
      'https://api.frankfurter.dev/v2/currencies?scope=all&providers=ECB',
      {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        signal: requestSignal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    body = await response.json();
  } catch {
    signal?.throwIfAborted();
    // Only optional upstream I/O degrades; validation and normalization run outside this catch.
    return;
  }
  signal?.throwIfAborted();
  const parsed = MetadataSchema.safeParse(body);
  if (!parsed.success || parsed.data.length === 0) return;
  const currencies = new Map<string, Currency>();
  for (const row of parsed.data) {
    if (currencies.has(row.iso_code)) return;
    currencies.set(row.iso_code, {
      code: row.iso_code,
      name: row.name,
      start_date: row.start_date,
      end_date: row.end_date,
    });
  }
  return [...currencies.values()].sort((a, b) => a.code.localeCompare(b.code));
}
