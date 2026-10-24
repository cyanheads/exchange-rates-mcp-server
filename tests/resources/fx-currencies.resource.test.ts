/**
 * @fileoverview Tests for fx://currencies resource.
 * @module tests/resources/fx-currencies.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxCurrenciesResource } from '@/mcp-server/resources/definitions/fx-currencies.resource.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';

const mockListCurrencies = vi.fn();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  currencyDiscovery: async () => ({ currencies: await mockListCurrencies(), as_of: '2024-06-03' }),
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

describe('fxCurrenciesResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCurrencies.mockResolvedValue([
      { code: 'EUR', name: 'Euro' },
      { code: 'USD', name: 'United States Dollar' },
      { code: 'GBP', name: 'British Pound Sterling' },
    ]);
  });

  it('returns currency list with count and source', async () => {
    const ctx = createMockContext();
    const params = fxCurrenciesResource.params!.parse({});
    const result = await fxCurrenciesResource.handler(params, ctx);

    expect(result.currencies).toHaveLength(3);
    expect(result.count).toBe(3);
    expect(result.as_of).toBe('2024-06-03');
    expect(result.source).toBe('Frankfurter v1');
    expect(result.currencies[0]).toMatchObject({ code: 'EUR', name: 'Euro' });
  });

  it('lists available resources', async () => {
    const listing = await fxCurrenciesResource.list!({} as never);
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    expect(listing.resources[0]).toHaveProperty('uri', 'fx://currencies');
    expect(listing.resources[0]).toHaveProperty('name');
  });
});
