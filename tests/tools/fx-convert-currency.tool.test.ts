/**
 * @fileoverview Tests for fx_convert_currency tool.
 * @module tests/tools/fx-convert-currency.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { unsupportedCurrency, upstreamNoData } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

const mockGetRate = vi.fn<[], Promise<ResolvedRate>>();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRate: mockGetRate,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

const baseRate: ResolvedRate = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: 0.92,
  rateDate: '2024-06-04',
  dateSnapped: false,
  rateType: 'ECB reference (mid-market)',
  source: 'ECB via Frankfurter',
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

  it('rounds to 6 decimal places', async () => {
    mockGetRate.mockResolvedValue({ ...baseRate, rate: 1.0 / 3.0 });
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    const result = await fxConvertCurrency.handler(
      { base_currency: 'USD', quote_currency: 'EUR', amount: 1 },
      ctx,
    );
    // 1 * (1/3) = 0.333333 rounded to 6 places
    expect(result.quote_amount.toString()).toMatch(/^0\.333333/);
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

  it('throws unsupported_currency naming the offending field', async () => {
    mockGetRate.mockRejectedValue(unsupportedCurrency('base_currency', ['XYZ']));
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    await expect(
      fxConvertCurrency.handler({ base_currency: 'XYZ', quote_currency: 'EUR', amount: 1 }, ctx),
    ).rejects.toMatchObject({
      data: { field: 'base_currency', reason: 'unsupported_currency' },
      message: expect.stringContaining('XYZ'),
    });
  });

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
        recovery: { hint: expect.stringContaining('YYYY-MM-DD') },
      },
    });
    expect(mockGetRate).not.toHaveBeenCalled();
  });

  it('throws upstream_no_data when the ECB published no rate for the date', async () => {
    mockGetRate.mockRejectedValue(upstreamNoData('/2000-01-04?base=ILS&symbols=EUR'));
    const ctx = createMockContext({ errors: fxConvertCurrency.errors });
    await expect(
      fxConvertCurrency.handler(
        { base_currency: 'ILS', quote_currency: 'EUR', amount: 1, date: '2000-01-04' },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_no_data' } });
  });

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
      const schema = z.toJSONSchema(fxConvertCurrency.input) as {
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
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };
    const content = fxConvertCurrency.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('100 USD');
    expect(text).toContain('92 EUR');
    expect(text).toContain('0.92');
  });
});
