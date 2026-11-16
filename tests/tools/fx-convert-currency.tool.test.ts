/**
 * @fileoverview Tests for fx_convert_currency tool.
 * @module tests/tools/fx-convert-currency.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { unsupportedCurrency, upstreamNoData } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

const mockGetRate = vi.fn<(...args: unknown[]) => Promise<ResolvedRate>>();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRate: mockGetRate,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

/** A trimmed live ECB set — enough to show the accepted list rides along with a rejection. */
const ACCEPTED = ['EUR', 'GBP', 'USD'];

const baseRate: ResolvedRate = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: 0.92,
  rateDate: '2024-06-04',
  dateSnapped: false,
  rateType: 'Daily rate (Frankfurter v1)',
  source: 'Frankfurter v1',
};

describe('fx_convert_currency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRate.mockResolvedValue(baseRate);
  });

  it('converts 100 USD to EUR correctly', async () => {
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    const result = await fxConvertCurrency.handler(
      { base_currency: 'USD', quote_currency: 'EUR', amount: 100 },
      ctx,
    );
    expect(result.base_amount).toBe(100);
    expect(result.quote_amount).toBeCloseTo(92, 2);
    expect(result.rate).toBe(0.92);
    expect(result.base_currency).toBe('USD');
    expect(result.quote_currency).toBe('EUR');
  });

  it('retains JavaScript-number precision without deliberate amount rounding', async () => {
    mockGetRate.mockResolvedValue({ ...baseRate, rate: 1.0 / 3.0 });
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    const result = await fxConvertCurrency.handler(
      { base_currency: 'USD', quote_currency: 'EUR', amount: 1 },
      ctx,
    );
    expect(result.quote_amount).toBe(0.3333333333333333);
  });

  it('surfaces date_snapped flag', async () => {
    mockGetRate.mockResolvedValue({ ...baseRate, dateSnapped: true, rateDate: '2024-05-31' });
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    const result = await fxConvertCurrency.handler(
      { base_currency: 'USD', quote_currency: 'EUR', amount: 10, date: '2024-06-01' },
      ctx,
    );
    expect(result.date_snapped).toBe(true);
  });

  it('throws date_out_of_range before ECB start', async () => {
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    await expect(
      fxConvertCurrency.handler(
        { base_currency: 'USD', quote_currency: 'EUR', amount: 1, date: '1998-01-01' },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it.each([
    ['base_currency', { base_currency: 'XYZ', quote_currency: 'EUR', amount: 1 }],
    ['quote_currency', { base_currency: 'USD', quote_currency: 'XYZ', amount: 1 }],
  ] as const)(
    'throws unsupported_currency naming %s and forwarding both code lists',
    async (field, input) => {
      mockGetRate.mockRejectedValue(unsupportedCurrency(field, ['XYZ'], ACCEPTED));
      const ctx = createMockContext({ errors: fxConvertCurrency.errors });
      await expect(fxConvertCurrency.handler(input, ctx)).rejects.toMatchObject({
        data: {
          accepted_codes: ACCEPTED,
          field,
          reason: 'unsupported_currency',
          rejected_codes: ['XYZ'],
        },
        message: `${field} "XYZ" is not available in this Frankfurter v1 currency set. Accepted: EUR, GBP, USD.`,
      });
    },
  );

  it.each(['base_currency', 'quote_currency'] as const)(
    '%s points at fx_list_currencies for valid codes',
    (field) => {
      expect(fxConvertCurrency.input.shape[field].description).toContain('fx_list_currencies');
    },
  );

  it('throws invalid_date_format for a malformed date, never unsupported_currency', async () => {
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    await expect(
      fxConvertCurrency.handler(
        { base_currency: 'USD', quote_currency: 'EUR', amount: 1, date: '2024-6-1' },
        ctx,
      ),
    ).rejects.toMatchObject({
      data: {
        field: 'date',
        reason: 'invalid_date_format',
      },
    });
    expect(mockGetRate).not.toHaveBeenCalled();
  });

  /** A bodiless 404 names no code, so the tool's message names the pair and date it asked for. */
  it.each([
    {
      when: 'a dated request',
      input: { base_currency: 'ILS', quote_currency: 'EUR', amount: 1, date: '2000-01-04' },
      message: 'Frankfurter v1 returned no ILS/EUR rate for 2000-01-04.',
    },
    {
      when: 'a latest request with padded lowercase codes',
      input: { base_currency: ' ils ', quote_currency: 'eur', amount: 1 },
      message: 'Frankfurter v1 returned no ILS/EUR rate for the latest published date.',
    },
  ])(
    'throws upstream_no_data when the ECB published no rate for $when, naming the pair on both surfaces',
    async ({ input, message }) => {
      mockGetRate.mockRejectedValue(upstreamNoData());
      const result = await runToolContract(fxConvertCurrency, input);
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { message: string; data: Record<string, unknown> } }
      ).error;
      expect(error.message).toBe(message);
      expect(error.data).toMatchObject({ reason: 'upstream_no_data' });
      expect(error.data).not.toHaveProperty('missing_codes');
      expect(result.content.map((block) => (block as { text: string }).text).join('\n')).toContain(
        message,
      );
    },
  );

  describe('amount contract', () => {
    const validInput = { base_currency: 'USD', quote_currency: 'EUR' };

    it('accepts a positive amount', () => {
      expect(fxConvertCurrency.input.safeParse({ ...validInput, amount: 100 }).success).toBe(true);
    });

    it.each([0, -100])('rejects amount %d at schema validation', (amount) => {
      const parsed = fxConvertCurrency.input.safeParse({ ...validInput, amount });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['amount']);
    });

    it('advertises the constraint in the serialized input schema', () => {
      const schema = z.toJSONSchema(fxConvertCurrency.input) as unknown as {
        properties: { amount: { exclusiveMinimum?: number } };
      };
      expect(schema.properties.amount.exclusiveMinimum).toBe(0);
    });
  });

  it('format renders conversion result', () => {
    const result = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      base_amount: 100,
      quote_amount: 92,
      rate: 0.92,
      rate_date: '2024-06-04',
      date_snapped: false,
      rate_type: 'Daily rate (Frankfurter v1)',
      source: 'Frankfurter v1',
    };
    const content = fxConvertCurrency.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('100 USD');
    expect(text).toContain('92 EUR');
    expect(text).toContain('0.92');
    expect(text).not.toContain('snapped');
  });

  it('format renders the snap note naming the published date when snapped', () => {
    const content = fxConvertCurrency.format!({
      base_currency: 'JPY',
      quote_currency: 'USD',
      base_amount: 45000,
      quote_amount: 290.25,
      rate: 0.00645,
      rate_date: '2026-11-13',
      date_snapped: true,
      rate_type: 'Daily rate (Frankfurter v1)',
      source: 'Frankfurter v1',
    });
    const text = (content[0] as { text: string }).text;
    expect(text.split('\n')).toContain(
      "⚠️ *Requested date snapped to 2026-11-13: no rate was published for the requested date (weekend, holiday, or the day's fix not yet released)*",
    );
  });
});
