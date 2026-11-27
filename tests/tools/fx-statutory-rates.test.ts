/**
 * @fileoverview Statutory euro conversion through the tool contract and real HTTP boundary.
 * @module tests/tools/fx-statutory-rates.test
 */

import { tmpdir } from 'node:os';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import { fxRatesLatestResource } from '@/mcp-server/resources/definitions/fx-rates-latest.resource.js';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { fxListCurrencies } from '@/mcp-server/tools/definitions/fx-list-currencies.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  getFrankfurterService,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

describe('statutory euro rates', () => {
  const oldFix = { amount: 1, base: 'EUR', date: '2025-12-31', rates: { BGN: 1.9558, USD: 1.175 } };
  let upstream: ReturnType<typeof createFetchMock>;
  beforeEach(() => {
    resetFrankfurterService();
    upstream = createFetchMock([
      { match: /\/2025-12-31\?base=EUR$/, respond: () => Response.json(oldFix) },
      { match: /\/2026-01-01\?base=EUR$/, respond: () => Response.json(oldFix) },
      {
        match: /\/2026-03-02\?base=EUR$/,
        respond: () =>
          Response.json({
            amount: 1,
            base: 'EUR',
            date: '2026-03-02',
            rates: { USD: 1.1698, IDR: 19680 },
          }),
      },
      {
        match: /2025-12-31\.\.2025-12-31\?base=EUR$/,
        respond: () =>
          Response.json({
            rates: { '2025-12-30': { BGN: 1.9558 }, '2025-12-31': oldFix.rates },
          }),
      },
      {
        match: /2026-01-01\.\.2026-01-01\?base=EUR$/,
        respond: () =>
          Response.json({
            rates: { '2025-12-31': oldFix.rates },
          }),
      },
      {
        match: /\/v1\/currencies$/,
        respond: () => Response.json({ EUR: 'Euro', USD: 'US Dollar' }),
      },
      {
        match: /\/v1\/latest\?base=EUR$/,
        respond: () =>
          Response.json({
            amount: 1,
            base: 'EUR',
            date: '2026-03-02',
            rates: { USD: 1.1698 },
          }),
      },
      { match: /\/v2\/currencies\?/, respond: () => new Response(null, { status: 503 }) },
    ]);
    upstream.install();
  });
  afterEach(() => {
    upstream.restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the last published BGN fix with v1 provenance', async () => {
    const result = await runToolContract(fxGetRate, {
      base_currency: 'BGN',
      quote_currency: 'EUR',
      date: '2025-12-31',
    });
    expect(result.structuredContent).toMatchObject({
      rate: 0.5112997238981491,
      rate_date: '2025-12-31',
      date_snapped: false,
      source: 'Frankfurter v1',
    });
  });

  it('uses the statutory factor on adoption day and preserves the snapped USD date', async () => {
    const result = await runToolContract(fxGetRate, {
      base_currency: 'BGN',
      quote_currency: 'USD',
      date: '2026-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      rate: 0.6007679604055568,
      rate_date: '2025-12-31',
      date_snapped: true,
      fixed_rate_date: '2026-01-01',
      fixed_rates: [{ code: 'BGN', adoption_date: '2026-01-01', units_per_eur: 1.95583 }],
    });
    expect(JSON.stringify(result.content)).toContain('Council Regulation (EC) No 2866/98');
    expect(JSON.stringify(result.content)).toContain('applied on 2026-01-01');
    expect(upstream.calls).toHaveLength(1);
  });

  it('resolves fixed-only rates, bulk and latest identity without any fetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-02T01:02:03Z'));
    const result = await runToolContract(fxGetRate, {
      base_currency: 'DEM',
      quote_currency: 'EUR',
      date: '1999-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      rate: 0.5112918811962185,
      rate_date: '1999-01-01',
      date_snapped: false,
    });
    expect(result.structuredContent).not.toHaveProperty('fixed_rate_date');
    const identity = await runToolContract(fxGetRate, {
      base_currency: 'BGN',
      quote_currency: 'BGN',
    });
    expect(identity.structuredContent).toMatchObject({
      rate: 1,
      rate_date: '2026-03-02',
      date_snapped: false,
    });
    const bulk = await runToolContract(fxGetRates, {
      base_currency: 'DEM',
      symbols: ['EUR', 'DEM', 'FRF'],
      date: '1999-01-01',
    });
    expect(bulk.structuredContent).toMatchObject({
      rates: { EUR: 0.5112918811962185, DEM: 1, FRF: 3.353854885138279 },
      rate_date: '1999-01-01',
    });
    expect(JSON.stringify(bulk.content)).toContain('FRF 6.55957 per EUR');
    expect(upstream.calls).toHaveLength(0);
  });

  it('combines both types of bulk quotes without changing implicit quote membership', async () => {
    const explicit = await runToolContract(fxGetRates, {
      base_currency: 'EUR',
      symbols: ['BGN', 'USD'],
      date: '2026-03-02',
    });
    expect(explicit.structuredContent).toMatchObject({
      rates: { BGN: 1.95583, USD: 1.1698 },
      source: 'Frankfurter v1 and Council Regulation (EC) No 2866/98 as amended',
    });
    const defaultSymbols = await runToolContract(fxGetRates, {
      base_currency: 'BGN',
      date: '2026-03-02',
    });
    expect(defaultSymbols.structuredContent).toMatchObject({
      rates: { EUR: 0.5112918811962185, USD: 0.5981092426233364 },
    });
    expect(Object.keys((defaultSymbols.structuredContent as { rates: object }).rates)).toEqual([
      'EUR',
      'USD',
      'IDR',
    ]);
    const converted = await runToolContract(fxConvertCurrency, {
      base_currency: 'BGN',
      quote_currency: 'USD',
      date: '2026-03-02',
      amount: 1000,
    });
    expect(converted.structuredContent).toMatchObject({ quote_amount: 598.1092426233363 });
    expect(JSON.stringify(converted.content)).toContain('BGN 1.95583 per EUR');
    expect(upstream.calls.map(({ request }) => request.url)).toEqual(
      Array(3).fill('https://api.frankfurter.dev/v1/2026-03-02?base=EUR'),
    );
  });

  it('leaves invalid dates, pre-v1 market requests and absent market symbols on their declared errors', async () => {
    const args = { base_currency: 'DEM', quote_currency: 'EUR' };
    for (const [date, reason] of [
      ['1999-02-29', 'invalid_date_format'],
      ['1998-12-31', 'date_out_of_range'],
    ]) {
      const result = await runToolContract(fxGetRate, { ...args, date });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      expect(JSON.stringify(result.content)).toContain(date);
    }
    expect(upstream.calls).toHaveLength(0);
    const mixed = await runToolContract(fxGetRates, {
      base_currency: 'EUR',
      symbols: ['BGN', 'ZZZ'],
      date: '2026-03-02',
    });
    expect(mixed.structuredContent).toMatchObject({
      error: {
        data: { reason: 'unsupported_currency', field: 'symbols', rejected_codes: ['ZZZ'] },
      },
    });
    expect((mixed.structuredContent as { error: { data: object } }).error.data).not.toHaveProperty(
      'currency_windows',
    );
    expect(JSON.stringify(mixed.content)).toContain('ZZZ');
  });

  it('keeps discovery and latest resources market-only and advertises statutory rows during coverage failure', async () => {
    const current = await runToolContract(fxListCurrencies, {});
    expect(current.structuredContent).toMatchObject({ count: 2, as_of: '2026-03-02' });
    const all = await runToolContract(fxListCurrencies, { include_retired: true });
    expect(all.structuredContent).toMatchObject({
      count: 23,
      notice: expect.stringContaining('statutory euro rates are preserved'),
      currencies: expect.arrayContaining([
        {
          code: 'DEM',
          name: 'Deutsche Mark',
          retired: true,
          adoption_date: '1999-01-01',
          units_per_eur: 1.95583,
        },
        {
          code: 'BGN',
          name: 'Bulgarian Lev',
          retired: true,
          adoption_date: '2026-01-01',
          units_per_eur: 1.95583,
        },
      ]),
    });
    expect(JSON.stringify(all.content)).toContain('adopted euro 1999-01-01 at 1.95583 per EUR');
    await expect(
      fxRatesLatestResource.handler({ base: 'BGN' }, createMockContext()),
    ).rejects.toMatchObject({
      data: { reason: 'unsupported_currency' },
    });
  });

  it('does not replace a custom source’s rates', async () => {
    const config = serverConfig.getServerConfig();
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...config,
      frankfurterBaseUrl: 'https://custom.example/v1',
    });
    const rate = await getFrankfurterService().getRate('BGN', 'EUR', '2026-01-01');
    expect(rate).toMatchObject({ rate: 0.5112997238981491, source: 'Frankfurter v1' });
    expect(upstream.calls[0]?.request.url).toBe('https://custom.example/v1/2026-01-01?base=EUR');
  });

  it.each(['USD', 'BGN'])(
    'reports an actionable amount-range error for %s to IDR overflow',
    async (base) => {
      const result = await runToolContract(fxConvertCurrency, {
        base_currency: base,
        quote_currency: 'IDR',
        date: '2026-03-02',
        amount: 1e305,
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'amount_out_of_range',
            field: 'amount',
            recovery: { hint: expect.stringContaining('smaller') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('smaller');
    },
  );

  it('keeps the converted amount when the EUR intermediate is subnormal', async () => {
    const result = await runToolContract(fxConvertCurrency, {
      base_currency: 'ITL',
      quote_currency: 'IDR',
      date: '2026-03-02',
      amount: 5e-321,
    });
    expect(result.structuredContent).toMatchObject({ quote_amount: 5.082e-320 });
    expect(JSON.stringify(result.content)).toContain('5.082e-320 IDR');
  });

  it('clips a mixed holiday window to an empty result, and pages a fixed-only range across weekends', async () => {
    const empty = await runToolContract(fxGetTimeseries, {
      base_currency: 'BGN',
      quote_currency: 'USD',
      start_date: '2026-01-01',
      end_date: '2026-01-01',
    });
    expect(empty.structuredContent).toMatchObject({ rate_count: 0, rates: {}, spilled: false });
    const large = await runToolContract(fxGetTimeseries, {
      base_currency: 'DEM',
      quote_currency: 'EUR',
      start_date: '1999-01-01',
      end_date: '2000-05-16',
      limit: 501,
    });
    expect(large.structuredContent).toMatchObject({
      rate_count: 502,
      next_start_date: '2000-05-15',
      truncated: true,
    });
    expect(Object.keys((large.structuredContent as { rates: object }).rates)).toHaveLength(500);
    const final = await runToolContract(fxGetTimeseries, {
      base_currency: 'DEM',
      quote_currency: 'EUR',
      start_date: '2000-05-15',
      end_date: '2000-05-16',
      limit: 5,
    });
    expect(final.structuredContent).toMatchObject({ rate_count: 2, truncated: false });
    expect(final.structuredContent).not.toHaveProperty('next_start_date');
    expect(JSON.stringify(final.content)).toContain('calendar or publication-day data points');
    expect(upstream.calls).toHaveLength(1);
  });

  it('stages only the market prefix from v1 and persists the source of each row', async () => {
    const provider = new DuckdbProvider({
      defaultRowLimit: 100,
      exportRootPath: tmpdir(),
      memoryLimitMb: 256,
      schemaSniffRows: 100,
      tempRootPath: tmpdir(),
    });
    const canvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, {
        ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
        sweeperIntervalMs: 0,
      }),
    );
    setCanvas(canvas);
    try {
      const result = await runToolContract(fxGetTimeseries, {
        base_currency: 'BGN',
        quote_currency: 'EUR',
        start_date: '2025-12-31',
        end_date: '2026-01-03',
        stage: true,
        limit: 0,
      });
      expect(result.structuredContent).toMatchObject({ rate_count: 4, spilled: true, rates: {} });
      expect(JSON.stringify(result.content)).toContain('BGN 1.95583 per EUR');
      const data = result.structuredContent as { canvas_id: string; table_name: string };
      const instance = await canvas.acquire(data.canvas_id, createMockContext());
      expect(
        (await instance.query(`SELECT date, rate, source FROM ${data.table_name} ORDER BY date`))
          .rows,
      ).toEqual([
        { date: '2025-12-31', rate: 0.5112997238981491, source: 'Frankfurter v1' },
        ...['2026-01-01', '2026-01-02', '2026-01-03'].map((date) => ({
          date,
          rate: 0.5112918811962185,
          source: 'Council Regulation (EC) No 2866/98 as amended',
        })),
      ]);
      expect(upstream.calls.map(({ request }) => request.url)).toEqual([
        'https://api.frankfurter.dev/v1/2025-12-31..2025-12-31?base=EUR',
      ]);
    } finally {
      setCanvas(undefined);
      await canvas.shutdown(createMockContext());
    }
  });
});
