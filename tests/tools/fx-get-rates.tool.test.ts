/**
 * @fileoverview Tests for fx_get_rates tool.
 * @module tests/tools/fx-get-rates.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
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

  it('throws date_out_of_range for historical date before ECB start', async () => {
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(
      fxGetRates.handler({ base_currency: 'USD', date: '1990-01-01' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it('throws unsupported_currency when service returns not found', async () => {
    mockGetRates.mockRejectedValue(new Error('not found: unknown base'));
    const ctx = createMockContext({ errors: fxGetRates.errors });
    await expect(fxGetRates.handler({ base_currency: 'XYZ' }, ctx)).rejects.toMatchObject({
      data: { reason: 'unsupported_currency' },
    });
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
