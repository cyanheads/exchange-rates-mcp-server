/**
 * @fileoverview Historical FX notices through the service and both MCP response surfaces.
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as config from '@/config/server-config.js';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { resetFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

const input = {
  base_currency: 'TRY',
  quote_currency: 'EUR',
  amount: 1_000_000,
  date: '2003-06-02',
};
const range = {
  base_currency: 'USD',
  quote_currency: 'RUB',
  start_date: '2022-03-01',
  end_date: '2022-03-08',
};
const history = {
  '2022-03-01': { USD: 1, RUB: 100 },
  '2022-03-02': { USD: 1 },
  '2022-03-03': { USD: 2, RUB: 204 },
  '2022-03-04': { EUR: 1 },
  '2022-03-07': { RUB: 100 },
  '2022-03-08': { USD: 1 },
};

const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/v2/')) {
    return Response.json([
      { iso_code: 'USD', name: 'US Dollar', start_date: '2022-03-08', end_date: '2022-03-10' },
      { iso_code: 'RUB', name: 'Russian Ruble', start_date: '1999-01-04', end_date: '2022-03-03' },
    ]);
  }
  if (url.endsWith('/currencies')) return Response.json({ EUR: 'Euro', TRY: 'Turkish Lira' });
  const match = /\/v1\/(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?\?base=EUR$/.exec(url);
  if (match?.[2]) {
    const rates = match[1]?.startsWith('2005')
      ? {
          '2005-06-30': { RON: 3.603 },
          '2005-07-01': { RON: 3.603 },
        }
      : history;
    return Response.json({ rates });
  }
  switch (match?.[1]) {
    case '2003-06-02':
      return Response.json({ date: '2003-06-02', rates: { TRY: 1.66, RON: 3.7965, USD: 1.1672 } });
    case '2005-01-01':
      return Response.json({ date: '2004-12-31', rates: { TRY: 1.8362 } });
    case '2005-01-03':
      return Response.json({ date: '2005-01-03', rates: { TRY: 1.815 } });
  }
  throw new Error(`Unexpected request: ${url}`);
});

beforeEach(() => {
  resetFrankfurterService();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preserves conversion arithmetic in returned units and on the served date', async () => {
  const result = await runToolContract(fxConvertCurrency, input);
  expect(result.structuredContent).toMatchObject({
    base_currency: 'TRY',
    quote_amount: 602409.638554217,
    rate_date: '2003-06-02',
  });
  expect(JSON.stringify(result.content)).toContain('602409.638554217 EUR');
});

it('counts only observed rows in the summary before paging and never counts the gap as truncation', async () => {
  const first = await runToolContract(fxGetTimeseries, { ...range, limit: 1 });
  expect(first.structuredContent).toMatchObject({
    rates: { '2022-03-01': 100 },
    rate_count: 2,
    summary: { mean: 101 },
    truncated: true,
    next_start_date: '2022-03-03',
  });
  const second = await runToolContract(fxGetTimeseries, {
    ...range,
    start_date: '2022-03-03',
    limit: 1,
  });
  expect(second.structuredContent).toMatchObject({
    rates: { '2022-03-03': 102 },
    rate_count: 1,
    summary: { mean: 102 },
    truncated: false,
  });
  const pastEnd = await runToolContract(fxGetTimeseries, {
    ...range,
    start_date: '2022-03-09',
    end_date: '2022-03-10',
  });
  expect(pastEnd.structuredContent).toMatchObject({ rates: {}, rate_count: 0, truncated: false });
});

const expectNotice = (result: Awaited<ReturnType<typeof runToolContract>>, phrase: string) => {
  expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(phrase) });
  expect(JSON.stringify(result.content)).toContain(phrase);
};

it('discloses legacy TRY units in conversion output', async () => {
  expectNotice(await runToolContract(fxConvertCurrency, input), '1 TRY = 1,000,000 TRL');
});

it('uses the actual snapped publication date around the TRY boundary', async () => {
  const pair = { base_currency: 'EUR', quote_currency: 'TRY' };
  const old = await runToolContract(fxGetRate, { ...pair, date: '2005-01-01' });
  expect(old.structuredContent).toMatchObject({ rate_date: '2004-12-31', date_snapped: true });
  expectNotice(old, '1 TRY = 1,000,000 TRL');
  const current = await runToolContract(fxGetRate, { ...pair, date: '2005-01-03' });
  expect(current.structuredContent).not.toHaveProperty('notice');
});

it('names both restatements in unfiltered bulk output and respects the selected symbols', async () => {
  const query = { base_currency: 'EUR', date: '2003-06-02' };
  const all = await runToolContract(fxGetRates, query);
  expectNotice(all, '1 TRY = 1,000,000 TRL');
  expectNotice(all, '1 RON = 10,000 ROL');
  const filtered = await runToolContract(fxGetRates, { ...query, symbols: ['USD'] });
  expect(filtered.structuredContent).not.toHaveProperty('notice');
});

it('returns successor guidance while retaining the unsupported_currency error', async () => {
  const result = await runToolContract(fxGetRate, {
    base_currency: 'TRL',
    quote_currency: 'EUR',
    date: '2003-06-02',
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      data: {
        field: 'base_currency',
        reason: 'unsupported_currency',
        rejected_codes: ['TRL'],
        recovery: { hint: 'Call fx_list_currencies to get the list of valid currency codes.' },
      },
      message: expect.stringContaining('1 TRY = 1,000,000 TRL'),
    },
  });
  expect(JSON.stringify(result.content)).toContain('1 TRY = 1,000,000 TRL');
});

it('leaves unverified custom-source values free of restatement claims', async () => {
  vi.spyOn(config, 'getServerConfig').mockReturnValue({
    ...config.getServerConfig(),
    frankfurterBaseUrl: 'https://custom.example/v1',
  });
  const result = await runToolContract(fxConvertCurrency, input);
  expect(result.structuredContent).toMatchObject({ quote_amount: 602409.638554217 });
  expect(result.structuredContent).not.toHaveProperty('notice');
});

it('describes each leg independently on summary-only output through intermittent holes', async () => {
  const result = await runToolContract(fxGetTimeseries, { ...range, limit: 0 });
  expect(result.structuredContent).toMatchObject({ rates: {}, rate_count: 2 });
  expectNotice(result, '4 served publication days from 2022-03-02 through 2022-03-08');
  expectNotice(result, 'RUB, USD');
  expectNotice(result, 'USD (US Dollar) coverage begins 2022-03-08.');
  expectNotice(result, 'bounds can contain gaps.');
  expect(JSON.stringify(result.content)).not.toContain('has no published rate from');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('reports the historical units before clipping delivery, and excludes older rows outside the request', async () => {
  const pair = {
    base_currency: 'EUR',
    quote_currency: 'RON',
    start_date: '2005-06-30',
    end_date: '2005-07-01',
  };
  const summary = await runToolContract(fxGetTimeseries, { ...pair, limit: 0 });
  expect(summary.structuredContent).toMatchObject({
    rates: {},
    rate_count: 2,
    summary: { mean: 3.603 },
  });
  expectNotice(summary, '1 RON = 10,000 ROL');
  const continuation = await runToolContract(fxGetTimeseries, {
    ...pair,
    start_date: '2005-07-01',
  });
  expect(continuation.structuredContent).toMatchObject({ rates: { '2005-07-01': 3.603 } });
  expect(continuation.structuredContent).not.toHaveProperty('notice');
  const empty = await runToolContract(fxGetTimeseries, {
    ...pair,
    start_date: '2005-07-02',
    end_date: '2005-07-03',
  });
  expect(empty.structuredContent).toMatchObject({ rate_count: 0 });
  expect(JSON.stringify(empty.content)).not.toContain('restated units');
});

it('keeps per-code attribution when a metadata row is absent', async () => {
  fetchMock.mockImplementationOnce(async () => Response.json({ rates: history }));
  fetchMock.mockImplementationOnce(async () =>
    Response.json([
      { iso_code: 'USD', name: 'US Dollar', start_date: '2022-03-08', end_date: '2022-03-10' },
    ]),
  );
  const result = await runToolContract(fxGetTimeseries, range);
  expectNotice(result, 'RUB, USD');
  expectNotice(result, 'USD (US Dollar) coverage begins 2022-03-08.');
  expect(JSON.stringify(result.content)).not.toContain('RUB (');
});

it('compares a terminal leg gap with that currency’s end date', async () => {
  const result = await runToolContract(fxGetTimeseries, { ...range, start_date: '2022-03-03' });
  expectNotice(result, 'RUB (Russian Ruble) coverage ends 2022-03-03.');
});
