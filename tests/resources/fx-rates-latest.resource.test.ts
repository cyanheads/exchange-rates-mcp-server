/**
 * @fileoverview Tests for fx://rates/latest/{base} resource.
 * @module tests/resources/fx-rates-latest.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxRatesLatestResource } from '@/mcp-server/resources/definitions/fx-rates-latest.resource.js';
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

describe('fxRatesLatestResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRates.mockResolvedValue(baseResponse);
  });

  it('returns latest rates snapshot for a base currency', async () => {
    const ctx = createMockContext();
    const params = fxRatesLatestResource.params.parse({ base: 'USD' });
    const result = await fxRatesLatestResource.handler(params, ctx);

    expect(result.base_currency).toBe('USD');
    expect(result.rate_date).toBe('2024-06-04');
    expect(result.rates).toMatchObject({ EUR: 0.92, GBP: 0.79 });
    expect(result.rate_type).toBe('ECB reference (mid-market)');
    expect(result.source).toBe('ECB via Frankfurter');
  });

  it('passes base currency to service', async () => {
    const ctx = createMockContext();
    const params = fxRatesLatestResource.params.parse({ base: 'EUR' });
    await fxRatesLatestResource.handler(params, ctx);

    expect(mockGetRates).toHaveBeenCalledWith('EUR', 'latest');
  });

  it('throws ValidationError (-32007) for unsupported base currency', async () => {
    mockGetRates.mockRejectedValue(new Error('not found: {"message":"not found"}'));
    const ctx = createMockContext();
    const params = fxRatesLatestResource.params.parse({ base: 'XYZ' });

    await expect(fxRatesLatestResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/not supported by the ECB/),
    });
    await expect(fxRatesLatestResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringMatching(/fx_list_currencies/),
    });
  });

  it('lists available resources with example URIs', () => {
    const listing = fxRatesLatestResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r.uri).toMatch(/^fx:\/\/rates\/latest\//);
      expect(r).toHaveProperty('name');
    }
  });
});
