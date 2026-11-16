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
  currencyDiscovery: async () => ({ currencies: await mockListCurrencies(), as_of: '2024-06-03' }),
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

describe('fx_list_currencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCurrencies.mockResolvedValue([
      { code: 'EUR', name: 'Euro', retired: false },
      { code: 'USD', name: 'United States Dollar', retired: false },
      { code: 'GBP', name: 'British Pound Sterling', retired: false },
    ]);
  });

  it('returns sorted currency list', async () => {
    const ctx = createMockContext();
    const result = await fxListCurrencies.handler({}, ctx);

    expect(result.currencies).toHaveLength(3);
    expect(result.count).toBe(3);
    expect(result.as_of).toBe('2024-06-03');
    expect(result.source).toBe('Frankfurter v1');
    expect(result.currencies[0]).toMatchObject({ code: 'EUR', name: 'Euro', retired: false });
  });

  it('declares retired as a required boolean on every row', () => {
    const row = { code: 'EUR', name: 'Euro' };
    const output = { count: 1, as_of: '2024-06-03', source: 'Frankfurter v1' };
    expect(fxListCurrencies.output.safeParse({ ...output, currencies: [row] }).success).toBe(false);
    expect(
      fxListCurrencies.output.safeParse({ ...output, currencies: [{ ...row, retired: false }] })
        .success,
    ).toBe(true);
  });

  it('format renders all currencies', () => {
    const result = {
      currencies: [
        { code: 'EUR', name: 'Euro', retired: false },
        { code: 'USD', name: 'United States Dollar', retired: false },
      ],
      count: 2,
      as_of: '2024-06-03',
      source: 'Frankfurter v1',
    };
    const content = fxListCurrencies.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('EUR');
    expect(text).toContain('USD');
    expect(text).toContain('Euro');
    expect(text).toContain('2');
    expect(text).toContain('2024-06-03');
    expect(text).not.toContain('retired');
  });

  it('format marks retired rows only, after their coverage bounds', () => {
    const content = fxListCurrencies.format!({
      currencies: [
        {
          code: 'BGN',
          name: 'Bulgarian Lev',
          start_date: '2000-07-19',
          end_date: '2025-12-31',
          retired: true,
        },
        {
          code: 'EUR',
          name: 'Euro',
          start_date: '1999-01-04',
          end_date: '2026-11-13',
          retired: false,
        },
      ],
      count: 2,
      as_of: '2026-11-13',
      source: 'Frankfurter v1',
    });
    const lines = (content[0] as { text: string }).text.split('\n');
    expect(lines).toContain(
      '**BGN** — Bulgarian Lev · start_date: 2000-07-19 · end_date: 2025-12-31 · retired',
    );
    expect(lines).toContain('**EUR** — Euro · start_date: 1999-01-04 · end_date: 2026-11-13');
  });

  it('points every retirement description at retired rather than end_date', () => {
    const row = fxListCurrencies.output.shape.currencies.element.shape;
    expect(fxListCurrencies.description).toContain(
      'include_retired=true adds historical codes absent from the current set, each marked retired=true.',
    );
    expect(fxListCurrencies.description).toContain('read retired, not end_date, for retirement.');
    expect(fxListCurrencies.input.shape.include_retired.description).toContain(
      'marked retired=true',
    );
    expect(row.end_date.description).toBe(
      'Last covered date in optional official ECB metadata; retired marks retirement, not this date.',
    );
  });
});
