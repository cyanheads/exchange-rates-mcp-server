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

const mockGetRates = vi.fn<(...args: unknown[]) => Promise<FrankfurterRateResponse>>();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRates: mockGetRates,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

/** A trimmed live ECB set — enough to show the accepted list rides along with a rejection. */
const ACCEPTED = ['EUR', 'GBP', 'JPY', 'USD'];

const baseResponse: FrankfurterRateResponse = {
  amount: 1,
  base: 'USD',
  date: '2024-06-04',
  rates: { EUR: 0.92, GBP: 0.79, JPY: 157.2 },
};

const formatText = (result: Parameters<NonNullable<typeof fxGetRates.format>>[0]) =>
  (fxGetRates.format!(result)[0] as { text: string }).text;

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

  describe('symbols schema', () => {
    it('rejects an empty symbols array at the symbols field', () => {
      const parsed = fxGetRates.input.safeParse({ base_currency: 'USD', symbols: [] });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]).toMatchObject({ code: 'too_small', path: ['symbols'] });
    });

    it.each([
      ['omitted', { base_currency: 'USD' }],
      ['a single quote', { base_currency: 'USD', symbols: ['EUR'] }],
      ['only the base', { base_currency: 'USD', symbols: ['USD'] }],
    ])('still accepts symbols %s', (_label, input) => {
      expect(fxGetRates.input.safeParse(input).success).toBe(true);
    });

    it('tells the caller to omit the field rather than send an empty array', () => {
      const description = fxGetRates.input.shape.symbols.description ?? '';

      expect(description).toMatch(/at least one/i);
      expect(description).toMatch(/omit/i);
    });
  });

  describe('date_snapped', () => {
    it('is false for a business-day request that came back on the requested date', async () => {
      mockGetRates.mockResolvedValue({ ...baseResponse, date: '2024-06-03' });
      const ctx = createMockContext({ errors: fxGetRates.errors });
      const result = await fxGetRates.handler({ base_currency: 'USD', date: '2024-06-03' }, ctx);

      expect(mockGetRates).toHaveBeenCalledWith('USD', '2024-06-03', undefined);
      expect(result).toMatchObject({ rate_date: '2024-06-03', date_snapped: false });
    });

    it.each([
      ['a weekend', '2024-06-01', '2024-05-31'],
      ['a TARGET holiday', '2024-12-25', '2024-12-24'],
    ])(
      'is true when %s request snaps to the prior publication day',
      async (_label, requested, actual) => {
        mockGetRates.mockResolvedValue({ ...baseResponse, date: actual });
        const ctx = createMockContext({ errors: fxGetRates.errors });
        const result = await fxGetRates.handler({ base_currency: 'USD', date: requested }, ctx);

        expect(result).toMatchObject({ rate_date: actual, date_snapped: true });
      },
    );

    it('is true for a snapped self-quote, whose date comes from the unfiltered snapshot', async () => {
      mockGetRates.mockResolvedValue({ ...baseResponse, date: '2024-05-31', rates: { USD: 1 } });
      const ctx = createMockContext({ errors: fxGetRates.errors });
      const result = await fxGetRates.handler(
        { base_currency: 'USD', date: '2024-06-01', symbols: ['USD'] },
        ctx,
      );

      expect(result).toMatchObject({ rates: { USD: 1 }, date_snapped: true });
    });

    it('is always false when date is omitted, however old the latest fix is', async () => {
      mockGetRates.mockResolvedValue({ ...baseResponse, date: '2001-01-02' });
      const ctx = createMockContext({ errors: fxGetRates.errors });
      const result = await fxGetRates.handler({ base_currency: 'USD' }, ctx);

      expect(result).toMatchObject({ rate_date: '2001-01-02', date_snapped: false });
    });
  });

  it('throws date_out_of_range for historical date before ECB start', async () => {
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'USD', date: '1990-01-01' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it('throws unsupported_currency for an unknown base_currency, forwarding both code lists', async () => {
    mockGetRates.mockRejectedValue(unsupportedCurrency('base_currency', ['XYZ'], ACCEPTED));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(fxGetRates.handler({ base_currency: 'XYZ' }, ctx)).rejects.toMatchObject({
      message: 'base_currency "XYZ" is not supported by the ECB. Accepted: EUR, GBP, JPY, USD.',
      data: {
        accepted_codes: ACCEPTED,
        field: 'base_currency',
        reason: 'unsupported_currency',
        recovery: { hint: expect.stringContaining('fx_list_currencies') },
        rejected_codes: ['XYZ'],
      },
    });
  });

  /**
   * Attribution is pinned by the leading field name and `data.field`. The valid base
   * cannot be proven absent from the text, since the accepted list inlined after the
   * rejected codes contains it.
   */
  it('blames symbols, not the valid base_currency, for an unsupported symbol', async () => {
    mockGetRates.mockRejectedValue(unsupportedCurrency('symbols', ['XYZ'], ACCEPTED));
    const ctx = createMockContext({ errors: fxGetRates.errors });

    await expect(
      fxGetRates.handler({ base_currency: 'USD', symbols: ['XYZ'] }, ctx),
    ).rejects.toMatchObject({
      data: { field: 'symbols', reason: 'unsupported_currency', rejected_codes: ['XYZ'] },
      message: expect.stringMatching(/^symbols "XYZ" is not supported by the ECB\. Accepted: /),
    });
  });

  it('names every unsupported symbol when several are bad, listing the accepted set once', async () => {
    mockGetRates.mockRejectedValue(unsupportedCurrency('symbols', ['XYZ', 'ABC'], ACCEPTED));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    const error = await Promise.resolve(
      fxGetRates.handler({ base_currency: 'USD', symbols: ['XYZ', 'EUR', 'ABC'] }, ctx),
    ).then(
      () => expect.unreachable('expected the handler to reject'),
      (e: unknown) => e as Error & { data: Record<string, unknown> },
    );

    expect(error.message).toMatch(/^symbols contains codes not supported by the ECB: XYZ, ABC\. /);
    expect(error.message.split('Accepted:')).toHaveLength(2);
    expect(error.data).toMatchObject({
      accepted_codes: ACCEPTED,
      field: 'symbols',
      rejected_codes: ['XYZ', 'ABC'],
    });
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
    mockGetRates.mockRejectedValue(upstreamNoData());
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'ILS', date: '2000-01-04' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'upstream_no_data' } });
  });

  describe('format', () => {
    const output = {
      base_currency: 'USD',
      rate_date: '2024-06-04',
      rates: { EUR: 0.92, JPY: 157.2 },
      date_snapped: false,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };

    it('renders all rate fields', () => {
      const text = formatText(output);
      expect(text).toContain('USD');
      expect(text).toContain('**EUR**: 0.92');
      expect(text).toContain('**JPY**: 157.2');
      expect(text).toContain('2024-06-04');
      expect(text).toContain('ECB reference');
      expect(text).toContain('ECB via Frankfurter');
    });

    it('omits the snap notice when the date was not snapped', () => {
      expect(formatText(output)).not.toContain('snapped');
    });

    it('renders the snap notice naming the actual publication date when snapped', () => {
      const text = formatText({ ...output, rate_date: '2024-05-31', date_snapped: true });

      expect(text).toContain(
        '⚠️ *Requested date snapped to 2024-05-31 (weekend/holiday — ECB publishes business days only)*',
      );
    });
  });
});
