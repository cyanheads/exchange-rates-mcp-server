/**
 * @fileoverview Tests for fx_get_timeseries tool.
 * @module tests/tools/fx-get-timeseries.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';

// Module-level mock for spillover so we can control the canvas spill path
vi.mock('@cyanheads/mcp-ts-core/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/canvas')>();
  return {
    ...actual,
    spillover: vi.fn(),
  };
});

import * as canvasCore from '@cyanheads/mcp-ts-core/canvas';

const mockGetTimeSeries = vi.fn();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getTimeSeries: mockGetTimeSeries,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

const mockGetCanvas = vi.spyOn(canvasModule, 'getCanvas');

const buildSeriesResponse = (
  start: string,
  end: string,
  rows: Array<{ date: string; rate: number }>,
) => ({
  raw: {
    amount: 1,
    base: 'USD',
    start_date: start,
    end_date: end,
    rates: Object.fromEntries(rows.map((r) => [r.date, { EUR: r.rate }])),
  },
  rows: rows.map((r) => ({
    date: r.date,
    rate: r.rate,
    base_currency: 'USD',
    quote_currency: 'EUR',
  })),
});

describe('fx_get_timeseries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCanvas.mockReturnValue(undefined); // canvas disabled by default
  });

  it('returns inline rates for short range (no canvas)', async () => {
    const rows = [
      { date: '2024-06-03', rate: 0.91 },
      { date: '2024-06-04', rate: 0.92 },
    ];
    mockGetTimeSeries.mockResolvedValue(buildSeriesResponse('2024-06-03', '2024-06-04', rows));

    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2024-06-03',
        end_date: '2024-06-04',
      },
      ctx,
    );

    expect(result.spilled).toBe(false);
    expect(result.base_currency).toBe('USD');
    expect(result.quote_currency).toBe('EUR');
    expect(result.start_date).toBe('2024-06-03');
    expect(result.end_date).toBe('2024-06-04');
    expect(result.rates['2024-06-03']).toBe(0.91);
    expect(result.rate_count).toBe(2);
    expect(result.canvas_id).toBeUndefined();
  });

  it('throws date_out_of_range for start before ECB start', async () => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    await expect(
      fxGetTimeseries.handler(
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          start_date: '1990-01-01',
          end_date: '2024-01-01',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'date_out_of_range' } });
  });

  it('throws invalid_range when start is after end', async () => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    await expect(
      fxGetTimeseries.handler(
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          start_date: '2024-06-04',
          end_date: '2024-06-01',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_range' } });
  });

  it('throws unsupported_currency when service returns not found', async () => {
    mockGetTimeSeries.mockRejectedValue(new Error('not found: currency'));
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    await expect(
      fxGetTimeseries.handler(
        {
          base_currency: 'XYZ',
          quote_currency: 'EUR',
          start_date: '2024-01-01',
          end_date: '2024-06-01',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'unsupported_currency' } });
  });

  it('format renders spilled=false correctly', () => {
    const result = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-01',
      end_date: '2024-06-04',
      rates: { '2024-06-03': 0.91, '2024-06-04': 0.92 },
      rate_count: 2,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
      spilled: false,
    };
    const content = fxGetTimeseries.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('USD/EUR');
    expect(text).toContain('2024-06-01');
    expect(text).toContain('spilled: false');
    expect(text).toContain('0.91');
  });

  it('spills to canvas when range exceeds threshold and canvas is enabled', async () => {
    // Build a 130-day series (> default 90-day threshold)
    const rows = Array.from({ length: 130 }, (_, i) => {
      const d = new Date('2023-01-02');
      d.setDate(d.getDate() + i);
      return { date: d.toISOString().slice(0, 10), rate: 0.9 + i * 0.001 };
    });
    mockGetTimeSeries.mockResolvedValue(buildSeriesResponse('2023-01-02', rows[129].date, rows));

    const mockInstance = {
      canvasId: 'abc1234567',
      isNew: true,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: vi.fn(),
    };
    const mockCanvasAcquire = vi.fn().mockResolvedValue(mockInstance);
    mockGetCanvas.mockReturnValue({
      acquire: mockCanvasAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    // Mock spillover to return a spilled result with a handle
    vi.mocked(canvasCore.spillover).mockResolvedValue({
      spilled: true,
      previewRows: rows.slice(0, 5),
      handle: { tableName: 'fx_usd_eur', rowCount: 130 },
      truncated: false,
    } as unknown as Awaited<ReturnType<typeof canvasCore.spillover>>);

    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2023-01-02',
        end_date: rows[129].date,
      },
      ctx,
    );

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('abc1234567');
    expect(result.table_name).toBe('fx_usd_eur');
    expect(result.rate_count).toBe(130);
    expect(mockCanvasAcquire).toHaveBeenCalled();
    expect(canvasCore.spillover).toHaveBeenCalledOnce();
    // Verify that the stable table name is passed to spillover (not left to auto-generate)
    expect(vi.mocked(canvasCore.spillover)).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: 'fx_usd_eur' }),
    );
  });

  it('format renders canvas info when spilled=true', () => {
    const result = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2023-01-01',
      end_date: '2024-06-04',
      rates: { '2023-01-02': 0.93 },
      rate_count: 400,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
      spilled: true,
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
    };
    const content = fxGetTimeseries.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('abc1234567');
    expect(text).toContain('fx_usd_eur');
    expect(text).toContain('spilled: true');
    expect(text).toContain('DataCanvas');
  });
});
