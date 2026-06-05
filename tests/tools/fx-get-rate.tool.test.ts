/**
 * @fileoverview Tests for fx_get_rate tool.
 * @module tests/tools/fx-get-rate.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

const mockGetRate = vi.fn<[], Promise<ResolvedRate>>();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRate: mockGetRate,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

const baseResolvedRate: ResolvedRate = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: 0.92,
  rateDate: '2024-06-04',
  dateSnapped: false,
  rateType: 'ECB reference (mid-market)',
  source: 'ECB via Frankfurter',
};

describe('fx_get_rate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRate.mockResolvedValue(baseResolvedRate);
  });

  it('returns rate for a valid pair (latest)', async () => {
    const ctx = createMockContext({ errors: fxGetRate.errors });
    const result = await fxGetRate.handler({ base_currency: 'USD', quote_currency: 'EUR' }, ctx);

    expect(result.base_currency).toBe('USD');
    expect(result.quote_currency).toBe('EUR');
    expect(result.rate).toBe(0.92);
    expect(result.rate_date).toBe('2024-06-04');
    expect(result.date_snapped).toBe(false);
    expect(result.rate_type).toBe('ECB reference (mid-market)');
    expect(result.source).toBe('ECB via Frankfurter');
  });

  it('surfaces date_snapped when API returns a different date', async () => {
    mockGetRate.mockResolvedValue({
      ...baseResolvedRate,
      rateDate: '2024-05-31',
      dateSnapped: true,
    });
    const ctx = createMockContext({ errors: fxGetRate.errors });
    const result = await fxGetRate.handler(
      { base_currency: 'USD', quote_currency: 'EUR', date: '2024-06-01' },
      ctx,
    );
    expect(result.date_snapped).toBe(true);
    expect(result.rate_date).toBe('2024-05-31');
  });

  it('throws date_out_of_range for date before ECB start', async () => {
    const ctx = createMockContext({ errors: fxGetRate.errors });
    await expect(
      fxGetRate.handler({ base_currency: 'USD', quote_currency: 'EUR', date: '1990-01-01' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it('throws date_out_of_range for future date', async () => {
    const ctx = createMockContext({ errors: fxGetRate.errors });
    await expect(
      fxGetRate.handler({ base_currency: 'USD', quote_currency: 'EUR', date: '2099-01-01' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it('throws unsupported_currency when service returns not found', async () => {
    mockGetRate.mockRejectedValue(new Error('not found: unsupported'));
    const ctx = createMockContext({ errors: fxGetRate.errors });
    await expect(
      fxGetRate.handler({ base_currency: 'XYZ', quote_currency: 'EUR' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'unsupported_currency' } });
  });

  it('format renders rate without snap note when not snapped', () => {
    const output = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      rate: 0.92,
      rate_date: '2024-06-04',
      date_snapped: false,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };
    const content = fxGetRate.format!(output);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('USD/EUR');
    expect(text).toContain('0.92');
    expect(text).not.toContain('snapped');
  });

  it('format renders snap note when date was snapped', () => {
    const output = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      rate: 0.92,
      rate_date: '2024-05-31',
      date_snapped: true,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };
    const content = fxGetRate.format!(output);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('snapped');
  });
});
