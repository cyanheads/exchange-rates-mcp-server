/**
 * @fileoverview Fetch-boundary regressions for observed FX data and delivery.
 * @module tests/tools/fx-batch-observations.test
 */
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import {
  getFrankfurterService,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

let http: FetchMockHarness;
const window = {
  base_currency: 'USD',
  quote_currency: 'GBP',
  start_date: '2024-06-01',
  end_date: '2024-06-07',
};
const install = () => {
  http = createFetchMock([
    {
      match: /\/currencies$/,
      respond: Response.json({
        EUR: 'Euro',
        USD: 'US Dollar',
        GBP: 'Pound',
        ISK: 'Krona',
        JPY: 'Yen',
      }),
    },
    {
      match: /2024-06-01\.\.2024-06-07/,
      respond: Response.json({
        rates: {
          '2024-05-31': {},
          '2024-06-03': { USD: 2, GBP: 1 },
          '2024-06-04': { USD: 2 },
          '2024-06-05': {},
          '2024-06-06': { GBP: 1 },
          '2024-06-07': { USD: 2, GBP: 2 },
        },
      }),
    },
    {
      match: /2024-06-03\.\.2024-06-07/,
      respond: Response.json({
        rates: { '2024-06-03': { USD: 2, GBP: 1 }, '2024-06-07': { USD: 2, GBP: 2 } },
      }),
    },
    {
      match: /2024-06-07\.\.2024-06-07/,
      respond: Response.json({ rates: { '2024-06-07': { USD: 2, GBP: 2 } } }),
    },
    {
      match: /2024-06-01\.\.2024-06-01/,
      respond: Response.json({ rates: { '2024-05-31': { USD: 2, GBP: 1 } } }),
    },
    {
      match: /2024-06-04\.\.2024-06-06/,
      respond: Response.json({
        rates: {
          '2024-06-03': { USD: 2, GBP: 1 },
          '2024-06-04': { USD: 2 },
          '2024-06-05': {},
          '2024-06-06': { GBP: 1 },
        },
      }),
    },
    { match: /\/v2\/currencies\?/, respond: new Response(null, { status: 503 }) },
    {
      match: /2012-06-01\?/,
      respond: Response.json({
        amount: 1,
        base: 'EUR',
        date: '2012-06-01',
        rates: { USD: 1.2, GBP: 0.8 },
      }),
    },
    {
      match: /2024-03-15\?/,
      respond: Response.json({
        amount: 1,
        base: 'EUR',
        date: '2024-03-15',
        rates: { JPY: 162.82, USD: 1.0892 },
      }),
    },
  ]);
  http.install();
};
beforeEach(() => {
  resetFrankfurterService();
  install();
});
afterEach(() => http.restore());

describe('observed FX characterization', () => {
  it('clips snapped dates and derives only same-day coexisting EUR legs', async () => {
    const result = await getFrankfurterService().getTimeSeries(
      'USD',
      'GBP',
      window.start_date,
      window.end_date,
    );
    expect(result.rows).toEqual([
      { date: '2024-06-03', rate: 0.5, base_currency: 'USD', quote_currency: 'GBP' },
      { date: '2024-06-07', rate: 1, base_currency: 'USD', quote_currency: 'GBP' },
    ]);
    expect(http.calls).toHaveLength(1);
    const wire = await runToolContract(fxGetTimeseries, window);
    expect(wire.structuredContent).toMatchObject({
      rate_count: 2,
      summary: { mean: 0.75 },
      truncated: false,
    });
    expect(JSON.stringify(wire.content)).toContain('2024-06-03: 0.5');
  });
});

describe('observed FX regressions', () => {
  it('reports missing-leg served days once, excluding clipped dates, on both surfaces', async () => {
    const wire = await runToolContract(fxGetTimeseries, window);
    expect(wire.structuredContent).toMatchObject({
      notice: expect.stringContaining('3 served publication days'),
    });
    const text = JSON.stringify(wire.content);
    expect(text).toContain('2024-06-04 through 2024-06-06');
    expect(text).toContain('observed days only');
    expect(text).not.toContain('2024-05-31');
  });

  it('attributes known missing observations to normalized deduplicated symbols', async () => {
    const wire = await runToolContract(fxGetRates, {
      base_currency: 'USD',
      date: '2012-06-01',
      symbols: [' isk ', 'GBP', 'ISK'],
    });
    expect(wire.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_no_data', field: 'symbols', missing_codes: ['ISK'] } },
    });
    expect(JSON.stringify(wire.content)).toContain('symbols');
    expect(JSON.stringify(wire.content)).toContain('ISK');
  });

  it('preserves small conversion products and quote-per-base units on both surfaces', async () => {
    const wire = await runToolContract(fxConvertCurrency, {
      base_currency: 'JPY',
      quote_currency: 'USD',
      date: '2024-03-15',
      amount: 0.0001,
    });
    expect(wire.structuredContent).toMatchObject({ quote_amount: 6.689595872742907e-7 });
    expect(JSON.stringify(wire.content)).toContain('6.689595872742907e-7');
    expect(JSON.stringify(wire.content)).toContain('USD per JPY');
  });

  it('returns summary-only metadata with a positive-limit continuation instruction', async () => {
    const wire = await runToolContract(fxGetTimeseries, { ...window, limit: 0 });
    expect(wire.isError).toBeFalsy();
    expect(wire.structuredContent).toMatchObject({
      rates: {},
      rate_count: 2,
      summary: { mean: 0.75 },
      truncated: true,
      next_start_date: '2024-06-03',
    });
    expect(JSON.stringify(wire.content)).toContain('positive limit');
    expect(JSON.stringify(wire.content)).toContain('3 served publication days');
  });

  it('advances positive pages and summarizes the narrower continuation through its final page', async () => {
    const first = await runToolContract(fxGetTimeseries, {
      ...window,
      start_date: '2024-06-03',
      limit: 1,
    });
    expect(first.structuredContent).toMatchObject({
      rates: { '2024-06-03': 0.5 },
      rate_count: 2,
      summary: { mean: 0.75 },
      next_start_date: '2024-06-07',
      truncated: true,
    });
    const last = await runToolContract(fxGetTimeseries, {
      ...window,
      start_date: '2024-06-07',
      limit: 1,
    });
    expect(last.structuredContent).toMatchObject({
      rates: { '2024-06-07': 1 },
      rate_count: 1,
      summary: { mean: 1 },
      truncated: false,
    });
    expect(last.structuredContent).not.toHaveProperty('next_start_date');
    expect(JSON.stringify(last.content)).toContain('2024-06-07: 1');
  });

  it('composes over-cap and coverage notices without truncating a complete small series', async () => {
    const result = await runToolContract(fxGetTimeseries, { ...window, limit: 999 });
    expect(result.structuredContent).toMatchObject({
      truncated: false,
      notice: expect.stringContaining('limit=999 was clamped to 500'),
    });
    for (const surface of [result.structuredContent, result.content]) {
      expect(JSON.stringify(surface)).toContain('3 served publication days');
      expect(JSON.stringify(surface)).toContain('clamped to 500');
    }
  });

  it.each([-1, 1.5, 'many', {}])('rejects invalid limit %s before fetching', async (limit) => {
    const result = await runToolContract(fxGetTimeseries, { ...window, limit } as never);
    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
  });

  it('keeps an empty clipped window empty in summary-only mode', async () => {
    const result = await runToolContract(fxGetTimeseries, {
      ...window,
      end_date: '2024-06-01',
      limit: 0,
    });
    expect(result.structuredContent).toMatchObject({ rates: {}, rate_count: 0, truncated: false });
    expect(result.structuredContent).not.toHaveProperty('summary');
    expect(result.structuredContent).not.toHaveProperty('next_start_date');
    expect(JSON.stringify(result.content)).not.toContain('missing either currency leg');
  });

  it('composes coverage, clamp and empty notices when no in-window legs coexist', async () => {
    const wire = await runToolContract(fxGetTimeseries, {
      ...window,
      start_date: '2024-06-04',
      end_date: '2024-06-06',
      limit: 501,
    });
    expect(wire.structuredContent).toMatchObject({ rate_count: 0, rates: {}, truncated: false });
    expect(wire.structuredContent).not.toHaveProperty('summary');
    for (const surface of [wire.structuredContent, wire.content]) {
      expect(JSON.stringify(surface)).toContain('3 served publication days');
      expect(JSON.stringify(surface)).toContain('clamped to 500');
      expect(JSON.stringify(surface)).toContain('Widen the range');
    }
  });

  it('reports all missing requested observations without blaming present symbols', async () => {
    const result = await runToolContract(fxGetRates, {
      base_currency: ' usd ',
      date: '2012-06-01',
      symbols: [' isk ', 'GBP', ' jpy ', 'ISK'],
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { field: 'symbols', missing_codes: ['ISK', 'JPY'] } },
    });
    expect(JSON.stringify(result.content)).toContain('ISK, JPY');
  });

  it.each([
    ['USD', 'USD', 2, '2024-06-05', '2024-06-06'],
    ['GBP', 'GBP', 2, '2024-06-04', '2024-06-05'],
    ['EUR', 'EUR', 0, undefined, undefined],
  ] as const)(
    'counts %s/%s coverage without fabricating identity observations',
    async (base, quote, count, firstDate, lastDate) => {
      const result = await getFrankfurterService().getTimeSeries(
        base,
        quote,
        window.start_date,
        window.end_date,
      );
      expect(result.missingCoverage).toEqual(count ? { count, firstDate, lastDate } : undefined);
      expect(result.rows.every((row) => row.rate === 1)).toBe(true);
    },
  );

  it.each([
    [fxGetRates, { base_currency: 'ISK', date: '2012-06-01', symbols: ['USD'] }, 'base_currency'],
    [
      fxGetRate,
      { base_currency: 'USD', quote_currency: 'ISK', date: '2012-06-01' },
      'quote_currency',
    ],
    [
      fxConvertCurrency,
      { base_currency: 'USD', quote_currency: 'ISK', date: '2012-06-01', amount: 1 },
      'quote_currency',
    ],
    [fxGetTimeseries, { ...window, quote_currency: 'ISK' }, 'quote_currency'],
  ] as const)('retains absent-leg attribution through $0.name', async (tool, input, field) => {
    const wire = await runToolContract(tool as typeof fxGetRate, input as never);
    expect(wire.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'upstream_no_data',
          field,
          missing_codes: ['ISK'],
          recovery: { hint: expect.any(String) },
        },
      },
    });
    expect(JSON.stringify(wire.content)).toContain(field);
    expect(JSON.stringify(wire.content)).toContain('ISK');
  });

  it('preserves unknown-code precedence over a known missing base', async () => {
    const wire = await runToolContract(fxGetRates, {
      base_currency: 'ISK',
      date: '2012-06-01',
      symbols: ['ZZZ'],
    });
    expect(wire.structuredContent).toMatchObject({
      error: {
        data: { reason: 'unsupported_currency', field: 'symbols', rejected_codes: ['ZZZ'] },
      },
    });
    expect(JSON.stringify(wire.content)).toContain('ZZZ');
  });

  it.each([0.00000001, 2.25])(
    'preserves conversion products for amount %s and identity pairs',
    async (amount) => {
      const identity = await runToolContract(fxConvertCurrency, {
        base_currency: 'JPY',
        quote_currency: 'JPY',
        amount,
        date: '2024-03-15',
      });
      expect(identity.structuredContent).toMatchObject({ quote_amount: amount, rate: 1 });
      expect(JSON.stringify(identity.content)).toContain(String(amount));
      const tiny = await runToolContract(fxConvertCurrency, {
        base_currency: 'JPY',
        quote_currency: 'USD',
        amount: 0.00000001,
        date: '2024-03-15',
      });
      expect(tiny.structuredContent).toMatchObject({ quote_amount: 6.689595872742906e-11 });
    },
  );
});
