/**
 * @fileoverview Tests for fx://rates/latest/{base} resource.
 * @module tests/resources/fx-rates-latest.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxRatesLatestResource } from '@/mcp-server/resources/definitions/fx-rates-latest.resource.js';
import { unsupportedCurrency } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { FrankfurterRateResponse } from '@/services/frankfurter/types.js';

const mockGetRates = vi.fn<(...args: unknown[]) => Promise<FrankfurterRateResponse>>();
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
    const params = fxRatesLatestResource.params!.parse({ base: 'USD' });
    const result = await fxRatesLatestResource.handler(params, ctx);

    expect(result.base_currency).toBe('USD');
    expect(result.rate_date).toBe('2024-06-04');
    expect(result.rates).toMatchObject({ EUR: 0.92, GBP: 0.79 });
    expect(result.rate_type).toBe('ECB reference (mid-market)');
    expect(result.source).toBe('ECB via Frankfurter');
  });

  it('passes base currency to service', async () => {
    const ctx = createMockContext();
    const params = fxRatesLatestResource.params!.parse({ base: 'EUR' });
    await fxRatesLatestResource.handler(params, ctx);

    expect(mockGetRates).toHaveBeenCalledWith('EUR', 'latest');
  });

  it('throws ValidationError (-32007) for unsupported base currency, carrying both code lists', async () => {
    const accepted = ['EUR', 'GBP', 'USD'];
    mockGetRates.mockRejectedValue(unsupportedCurrency('base_currency', ['XYZ'], accepted));
    const ctx = createMockContext();
    const params = fxRatesLatestResource.params!.parse({ base: 'XYZ' });

    const error = await Promise.resolve(fxRatesLatestResource.handler(params, ctx)).then(
      () => expect.unreachable('expected the resource to reject'),
      (e: unknown) => e as McpError,
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        accepted_codes: accepted,
        base: 'XYZ',
        field: 'base_currency',
        reason: 'unsupported_currency',
        rejected_codes: ['XYZ'],
      },
    });
    expect(error.message).toBe(
      'base_currency "XYZ" is not supported by the ECB. Accepted: EUR, GBP, USD. ' +
        'Call fx_list_currencies for the full currency names.',
    );
  });

  it('re-raises an upstream failure it cannot classify', async () => {
    mockGetRates.mockRejectedValue(new Error('Frankfurter API unreachable: ECONNRESET'));
    const ctx = createMockContext();
    const params = fxRatesLatestResource.params!.parse({ base: 'USD' });

    await expect(fxRatesLatestResource.handler(params, ctx)).rejects.toThrow(/ECONNRESET/);
  });

  it('lists available resources with example URIs', async () => {
    const listing = await fxRatesLatestResource.list!({} as never);
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r.uri).toMatch(/^fx:\/\/rates\/latest\//);
      expect(r).toHaveProperty('name');
    }
  });
});
