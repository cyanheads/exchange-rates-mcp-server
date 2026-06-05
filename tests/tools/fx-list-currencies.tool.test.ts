/**
 * @fileoverview Tests for fx_list_currencies tool.
 * @module tests/tools/fx-list-currencies.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxListCurrencies } from '@/mcp-server/tools/definitions/fx-list-currencies.tool.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';

const mockListCurrencies = vi.fn();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  listCurrencies: mockListCurrencies,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

describe('fx_list_currencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCurrencies.mockResolvedValue([
      { code: 'EUR', name: 'Euro' },
      { code: 'USD', name: 'United States Dollar' },
      { code: 'GBP', name: 'British Pound Sterling' },
    ]);
  });

  it('returns sorted currency list', async () => {
    const ctx = createMockContext();
    const result = await fxListCurrencies.handler({}, ctx);

    expect(result.currencies).toHaveLength(3);
    expect(result.count).toBe(3);
    expect(result.source).toBe('ECB via Frankfurter');
    expect(result.currencies[0]).toMatchObject({ code: 'EUR', name: 'Euro' });
  });

  it('format renders all currencies', () => {
    const result = {
      currencies: [
        { code: 'EUR', name: 'Euro' },
        { code: 'USD', name: 'United States Dollar' },
      ],
      count: 2,
      source: 'ECB via Frankfurter',
    };
    const content = fxListCurrencies.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('EUR');
    expect(text).toContain('USD');
    expect(text).toContain('Euro');
    expect(text).toContain('2');
  });
});
