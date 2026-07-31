/**
 * @fileoverview Tests for fx_get_rates tool.
 * @module tests/tools/fx-get-rates.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { unsupportedCurrency, upstreamNoData } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { FrankfurterRateResponse } from '@/services/frankfurter/types.js';

const mockGetRates = vi.fn<[], Promise<FrankfurterRateResponse>>();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRates: mockGetRates,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

const baseResponse: FrankfurterRateResponse = {
  amount: 1,
  base: 'USD',
  date: '2024-06-04',
  rates: { EUR: 0.92, GBP: 0.79, JPY: 157.2 },
};

describe('fx_get_rates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRates.mockResolvedValue(baseResponse);
  });

  it('returns rates snapshot for USD', async () => {
    const ctx = createMockContext({ errors: fxGetRates.errors });
    const result = await fxGetRates.handler({ base_currency: 'USD' }, ctx);

    expect(result.base_currency).toBe('USD');
    expect(result.rate_date).toBe('2024-06-04');
    expect(result.rates).toMatchObject({ EUR: 0.92, GBP: 0.79 });
    expect(result.rate_type).toBe('ECB reference (mid-market)');
    expect(result.source).toBe('ECB via Frankfurter');
  });

  /**
   * The base is stripped from the upstream `symbols` and answered locally, so the
   * handler must forward the caller's list verbatim and pass the injected rate through.
   */
  it('passes symbols containing the base straight through to the service', async () => {
    mockGetRates.mockResolvedValue({
      amount: 1,
      base: 'USD',
      date: '2024-06-04',
      rates: { EUR: 0.92, USD: 1 },
    });
    const ctx = createMockContext({ errors: fxGetRates.errors });
    const result = await fxGetRates.handler({ base_currency: 'USD', symbols: ['USD', 'EUR'] }, ctx);

    expect(mockGetRates).toHaveBeenCalledWith('USD', 'latest', ['USD', 'EUR']);
    expect(result.rates).toEqual({ EUR: 0.92, USD: 1 });
  });

  it('returns only the identity rate when the base is the sole symbol', async () => {
    mockGetRates.mockResolvedValue({
      amount: 1,
      base: 'USD',
      date: '2024-06-04',
      rates: { USD: 1 },
    });
    const ctx = createMockContext({ errors: fxGetRates.errors });
    const result = await fxGetRates.handler({ base_currency: 'USD', symbols: ['USD'] }, ctx);

    expect(result.rates).toEqual({ USD: 1 });
    expect(result.rate_date).toBe('2024-06-04');
  });

  it('throws date_out_of_range for historical date before ECB start', async () => {
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'USD', date: '1990-01-01' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it('throws unsupported_currency for an unknown base_currency', async () => {
    mockGetRates.mockRejectedValue(unsupportedCurrency('base_currency', ['XYZ']));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(fxGetRates.handler({ base_currency: 'XYZ' }, ctx)).rejects.toMatchObject({
      data: { field: 'base_currency', reason: 'unsupported_currency' },
    });
  });

  it('blames symbols, not the valid base_currency, for an unsupported symbol', async () => {
    mockGetRates.mockRejectedValue(unsupportedCurrency('symbols', ['XYZ']));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    const rejection = fxGetRates.handler({ base_currency: 'USD', symbols: ['XYZ'] }, ctx);

    await expect(rejection).rejects.toMatchObject({
      data: { field: 'symbols', reason: 'unsupported_currency' },
      message: expect.stringContaining('XYZ'),
    });
    await expect(rejection).rejects.toMatchObject({
      message: expect.not.stringContaining('USD'),
    });
  });

  it('names every unsupported symbol when several are bad', async () => {
    mockGetRates.mockRejectedValue(unsupportedCurrency('symbols', ['XYZ', 'ABC']));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'USD', symbols: ['XYZ', 'EUR', 'ABC'] }, ctx),
    ).rejects.toMatchObject({ message: expect.stringContaining('XYZ, ABC') });
  });

  it('throws invalid_date_format for a malformed date, never unsupported_currency', async () => {
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'USD', date: '2024-6-1' }, ctx),
    ).rejects.toMatchObject({
      data: {
        field: 'date',
        reason: 'invalid_date_format',
        recovery: { hint: expect.stringContaining('YYYY-MM-DD') },
      },
    });
    expect(mockGetRates).not.toHaveBeenCalled();
  });

  it('throws upstream_no_data when the ECB published no rates for the date', async () => {
    mockGetRates.mockRejectedValue(upstreamNoData('/2000-01-04?base=ILS'));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'ILS', date: '2000-01-04' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'upstream_no_data' } });
  });

  it('format renders all rate fields', () => {
    const result = {
      base_currency: 'USD',
      rate_date: '2024-06-04',
      rates: { EUR: 0.92, JPY: 157.2 },
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };
    const content = fxGetRates.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('USD');
    expect(text).toContain('EUR');
    expect(text).toContain('0.92');
    expect(text).toContain('2024-06-04');
    expect(text).toContain('ECB reference');
    expect(text).toContain('ECB via Frankfurter');
  });
});
