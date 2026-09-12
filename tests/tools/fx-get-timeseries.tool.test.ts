/**
 * @fileoverview Tests for fx_get_timeseries tool.
 * @module tests/tools/fx-get-timeseries.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';
import { unsupportedCurrency, upstreamNoData } from '@/services/frankfurter/errors.js';
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

/**
 * The service clips the series to the requested window before it returns, so
 * the bounds it reports are always inside that window — mirror that here.
 */
const buildSeriesResponse = (
  start: string,
  end: string,
  rows: Array<{ date: string; rate: number }>,
  quote = 'EUR',
) => ({
  rows: rows.map((r) => ({
    date: r.date,
    rate: r.rate,
    base_currency: 'USD',
    quote_currency: quote,
  })),
  startDate: rows[0]?.date ?? start,
  endDate: rows.at(-1)?.date ?? end,
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
    expect(result.truncated).toBe(false);
    expect(result.next_start_date).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('returns an empty series with a notice when the range holds no publication day', async () => {
    // Saturday-only window: the service clips Frankfurter's snap back to 2024-05-31 away.
    mockGetTimeSeries.mockResolvedValue(buildSeriesResponse('2024-06-01', '2024-06-01', []));

    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2024-06-01',
        end_date: '2024-06-01',
      },
      ctx,
    );

    expect(result.rates).toEqual({});
    expect(result.rate_count).toBe(0);
    // The echoed window never leaks the prior business day the upstream snapped to.
    expect(result.start_date).toBe('2024-06-01');
    expect(result.end_date).toBe('2024-06-01');
    expect(getEnrichment(ctx).notice).toContain('TARGET business days');
  });

  it('never echoes a date outside the requested range', async () => {
    // Range opens on a Saturday; only the in-range weekdays survive.
    mockGetTimeSeries.mockResolvedValue(
      buildSeriesResponse('2024-06-01', '2024-06-05', [
        { date: '2024-06-03', rate: 0.91 },
        { date: '2024-06-04', rate: 0.92 },
        { date: '2024-06-05', rate: 0.93 },
      ]),
    );

    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2024-06-01',
        end_date: '2024-06-05',
      },
      ctx,
    );

    for (const date of [result.start_date, result.end_date, ...Object.keys(result.rates)]) {
      expect(date >= '2024-06-01' && date <= '2024-06-05').toBe(true);
    }
    expect(result.rates['2024-05-31']).toBeUndefined();
    expect(result.rate_count).toBe(3);
  });

  it('returns a rate of 1 per publication day for an identity pair', async () => {
    mockGetTimeSeries.mockResolvedValue(
      buildSeriesResponse(
        '2024-06-03',
        '2024-06-05',
        [
          { date: '2024-06-03', rate: 1 },
          { date: '2024-06-04', rate: 1 },
          { date: '2024-06-05', rate: 1 },
        ],
        'USD',
      ),
    );

    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'USD',
        start_date: '2024-06-03',
        end_date: '2024-06-05',
      },
      ctx,
    );

    expect(Object.values(result.rates)).toEqual([1, 1, 1]);
    expect(result.rate_count).toBe(3);
    expect(result.base_currency).toBe('USD');
    expect(result.quote_currency).toBe('USD');
  });

  it('explains an over-threshold range that stayed inline because no canvas is configured', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({
      date: new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10),
      rate: 0.9 + i * 0.001,
    }));
    mockGetTimeSeries.mockResolvedValue(buildSeriesResponse('2023-01-02', rows[129]!.date, rows));
    mockGetCanvas.mockReturnValue(undefined);

    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2023-01-02',
        end_date: rows[129]!.date,
      },
      ctx,
    );

    expect(result.spilled).toBe(false);
    expect(result.rate_count).toBe(130);
    expect(Object.keys(result.rates)).toHaveLength(130);
    expect(result.truncated).toBe(false);
    expect(result.next_start_date).toBeUndefined();
    expect(getEnrichment(ctx).notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(getEnrichment(ctx).notice).not.toContain('fx_dataframe');
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

  it.each([
    ['base_currency', { base_currency: 'XYZ', quote_currency: 'EUR' }],
    ['quote_currency', { base_currency: 'USD', quote_currency: 'XYZ' }],
  ] as const)(
    'throws unsupported_currency naming %s and forwarding both code lists',
    async (field, pair) => {
      const accepted = ['EUR', 'GBP', 'USD'];
      mockGetTimeSeries.mockRejectedValue(unsupportedCurrency(field, ['XYZ'], accepted));
      const ctx = createMockContext({ errors: fxGetTimeseries.errors });
      await expect(
        fxGetTimeseries.handler({ ...pair, start_date: '2024-01-01', end_date: '2024-06-01' }, ctx),
      ).rejects.toMatchObject({
        data: {
          accepted_codes: accepted,
          field,
          reason: 'unsupported_currency',
          recovery: { hint: expect.stringContaining('fx_list_currencies') },
          rejected_codes: ['XYZ'],
        },
        message: `${field} "XYZ" is not supported by the ECB. Accepted: EUR, GBP, USD.`,
      });
    },
  );

  it('throws invalid_date_format for a malformed start_date, never invalid_range', async () => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    await expect(
      fxGetTimeseries.handler(
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          start_date: '2024-6-1',
          end_date: '2024-06-10',
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      data: {
        field: 'start_date',
        reason: 'invalid_date_format',
        recovery: { hint: expect.stringContaining('YYYY-MM-DD') },
      },
    });
    expect(mockGetTimeSeries).not.toHaveBeenCalled();
  });

  it('throws invalid_date_format for a malformed end_date', async () => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    await expect(
      fxGetTimeseries.handler(
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          start_date: '2024-06-01',
          end_date: '2024-06-31',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { field: 'end_date', reason: 'invalid_date_format' } });
  });

  it('throws upstream_no_data when the ECB published no rates across the range', async () => {
    mockGetTimeSeries.mockRejectedValue(upstreamNoData('/2000-01-04..2000-02-04?base=ILS'));
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    await expect(
      fxGetTimeseries.handler(
        {
          base_currency: 'ILS',
          quote_currency: 'EUR',
          start_date: '2000-01-04',
          end_date: '2000-02-04',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_no_data' } });
  });

  it('format renders spilled=false correctly', () => {
    const result = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-03',
      end_date: '2024-06-04',
      rates: { '2024-06-03': 0.91, '2024-06-04': 0.92 },
      rate_count: 2,
      truncated: false,
      rate_type: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
      spilled: false,
    };
    const content = fxGetTimeseries.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('USD/EUR');
    expect(text).toContain('2024-06-03');
    expect(text).toContain('spilled: false');
    expect(text).toContain('truncated: false');
    expect(text).toContain('0.91');
    expect(text).not.toContain('next_start_date');
  });

  it('spills to canvas when range exceeds threshold and canvas is enabled', async () => {
    // Build a 130-day series (> default 90-day threshold)
    const rows = Array.from({ length: 130 }, (_, i) => ({
      date: new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10),
      rate: 0.9 + i * 0.001,
    }));
    mockGetTimeSeries.mockResolvedValue(buildSeriesResponse('2023-01-02', rows[129]!.date, rows));

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
        end_date: rows[129]!.date,
      },
      ctx,
    );

    expect(result.spilled).toBe(true);
    expect(result.canvas_id).toBe('abc1234567');
    expect(result.table_name).toBe('fx_usd_eur');
    expect(result.rate_count).toBe(130);
    expect(Object.keys(result.rates)).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.next_start_date).toBeUndefined();
    expect(mockCanvasAcquire).toHaveBeenCalled();
    expect(canvasCore.spillover).toHaveBeenCalledOnce();
    // Verify that the stable table name is passed to spillover (not left to auto-generate)
    expect(vi.mocked(canvasCore.spillover)).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: 'fx_usd_eur' }),
    );

    /** The pointer travels with the token: both dataframe tools, in call order, plus the handle. */
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('abc1234567');
    expect(notice).toContain('fx_usd_eur');
    expect(notice).toContain('130 rows');
    expect(notice.indexOf('fx_dataframe_describe')).toBeGreaterThan(-1);
    expect(notice.indexOf('fx_dataframe_describe')).toBeLessThan(
      notice.indexOf('fx_dataframe_query'),
    );
  });

  it('names both dataframe tools, describe first, in the canvas_id and table_name descriptions', () => {
    const shape = fxGetTimeseries.output.shape;
    for (const field of [shape.canvas_id, shape.table_name]) {
      const text = field.description ?? '';
      expect(text.indexOf('fx_dataframe_describe')).toBeGreaterThan(-1);
      expect(text).toContain('fx_dataframe_query');
    }
    expect(shape.canvas_id.description!.indexOf('fx_dataframe_describe')).toBeLessThan(
      shape.canvas_id.description!.indexOf('fx_dataframe_query'),
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
      truncated: true,
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
    expect(text.indexOf('fx_dataframe_describe')).toBeGreaterThan(-1);
    expect(text.indexOf('fx_dataframe_describe')).toBeLessThan(text.indexOf('fx_dataframe_query'));
  });
});

/**
 * A 1,250-weekday ECB calendar, Monday 2018-12-31 through Friday 2023-10-13 — long
 * enough to span three inline pages. The mock service honours the requested window
 * the way the real one does, so re-calling with a later start_date narrows the
 * series exactly as a live continuation would.
 */
const WEEKDAY_CALENDAR = (() => {
  const dates: string[] = [];
  for (let day = Date.UTC(2018, 11, 31); dates.length < 1250; day += 86_400_000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates.map((date, i) => ({ date, rate: Number((1.1 + i / 100_000).toFixed(5)) }));
})();
const CALENDAR_END = '2023-10-15'; // Sunday after the last publication day

describe('fx_get_timeseries inline pagination', () => {
  const PAGE = 500;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCanvas.mockReturnValue(undefined);
    mockGetTimeSeries.mockImplementation(
      async (_b: string, _q: string, start: string, end: string) =>
        buildSeriesResponse(
          start,
          end,
          WEEKDAY_CALENDAR.filter((row) => row.date >= start && row.date <= end),
        ),
    );
  });

  const call = async (start_date: string, end_date = CALENDAR_END) => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      { base_currency: 'USD', quote_currency: 'EUR', start_date, end_date },
      ctx,
    );
    const text = (fxGetTimeseries.format!(result)[0] as { text: string }).text;
    return { result, text, notice: getEnrichment(ctx).notice as string | undefined };
  };

  /** The `YYYY-MM-DD: rate` lines content[] renders, in order. */
  const renderedDates = (text: string) =>
    text
      .split('\n')
      .filter((line) => /^\d{4}-\d{2}-\d{2}: /.test(line))
      .map((line) => line.slice(0, 10));

  it('bounds the first page on both surfaces and reports the full-range total', async () => {
    const { result, text, notice } = await call(WEEKDAY_CALENDAR[0]!.date);
    const pageDates = WEEKDAY_CALENDAR.slice(0, PAGE).map((row) => row.date);

    expect(result.spilled).toBe(false);
    expect(result.rate_count).toBe(1250);
    expect(result.truncated).toBe(true);
    expect(result.next_start_date).toBe(WEEKDAY_CALENDAR[PAGE]!.date);
    expect(Object.keys(result.rates)).toEqual(pageDates);
    expect(renderedDates(text)).toEqual(pageDates);
    expect(text).toContain(`next_start_date: ${WEEKDAY_CALENDAR[PAGE]!.date}`);

    // The continuation guidance is on the notice too, and never names a tool this mode hides.
    expect(notice).toContain(`start_date=${WEEKDAY_CALENDAR[PAGE]!.date}`);
    expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(notice).not.toContain('fx_dataframe');
  });

  it('walks every page to exhaustion via next_start_date, then returns an empty page past the end', async () => {
    const seen: string[] = [];
    const totals: number[] = [];
    let start: string | undefined = WEEKDAY_CALENDAR[0]!.date;
    let pages = 0;

    while (start) {
      const { result, text, notice } = await call(start);
      pages += 1;
      totals.push(result.rate_count);
      const keys = Object.keys(result.rates);

      expect(keys.length).toBeLessThanOrEqual(PAGE);
      expect(renderedDates(text)).toEqual(keys);
      expect(result.start_date).toBe(keys[0]);
      expect(result.end_date).toBe(WEEKDAY_CALENDAR.at(-1)!.date);
      expect(notice ?? '').not.toContain('fx_dataframe');
      expect(result.truncated).toBe(result.next_start_date !== undefined);

      seen.push(...keys);
      start = result.next_start_date;
    }

    expect(pages).toBe(3);
    expect(totals).toEqual([1250, 750, 250]);
    expect(seen).toEqual(WEEKDAY_CALENDAR.map((row) => row.date));

    // One call past the last publication day: empty, untruncated, not an error.
    const pastEnd = await call('2023-10-14');
    expect(pastEnd.result.rates).toEqual({});
    expect(pastEnd.result.rate_count).toBe(0);
    expect(pastEnd.result.truncated).toBe(false);
    expect(pastEnd.result.next_start_date).toBeUndefined();
    expect(pastEnd.text).toContain('truncated: false');
    expect(pastEnd.notice).toContain('TARGET business days');
  });

  it('returns a final page of exactly the page size with no continuation', async () => {
    const start = WEEKDAY_CALENDAR[750]!.date;
    const { result } = await call(start);

    expect(result.rate_count).toBe(PAGE);
    expect(Object.keys(result.rates)).toHaveLength(PAGE);
    expect(result.truncated).toBe(false);
    expect(result.next_start_date).toBeUndefined();
  });

  it('pages an over-threshold range that fit the canvas preview instead of spilling', async () => {
    mockGetCanvas.mockReturnValue({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'abc1234567', query: vi.fn() }),
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);
    vi.mocked(canvasCore.spillover).mockImplementation(
      async ({ source }) =>
        ({ spilled: false, previewRows: [...(source as unknown[])] }) as unknown as Awaited<
          ReturnType<typeof canvasCore.spillover>
        >,
    );

    const start = WEEKDAY_CALENDAR[600]!.date;
    const { result, text, notice } = await call(start);

    expect(result.spilled).toBe(false);
    expect(result.rate_count).toBe(650);
    expect(Object.keys(result.rates)).toHaveLength(PAGE);
    expect(renderedDates(text)).toHaveLength(PAGE);
    expect(result.next_start_date).toBe(WEEKDAY_CALENDAR[1100]!.date);
    expect(notice).toContain(`start_date=${WEEKDAY_CALENDAR[1100]!.date}`);
    expect(notice).not.toContain('not configured');
  });
});
