/**
 * @fileoverview Tests for the Frankfurter service — the date validation gate, the
 * range clipping that keeps snapped upstream dates out of a response, and the
 * identity-pair paths, which answer 1 locally but still read their date off a
 * proxy quote instead of echoing the caller's.
 * @module tests/services/frankfurter-service.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getFrankfurterService,
  isIsoDate,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

/** The ECB reference set, as `/currencies` returns it — trimmed to what these cases touch. */
const CURRENCIES = { EUR: 'Euro', GBP: 'British Pound', USD: 'US Dollar' };

/** Route the service's fetches by URL, recording each one so callers can assert on them. */
const stubFetch = (routes: Array<[RegExp, unknown]>) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const match = routes.find(([pattern]) => pattern.test(url));
      if (!match) throw new Error(`unstubbed fetch: ${url}`);
      return { ok: true, json: async () => match[1] } as unknown as Response;
    }),
  );
  return calls;
};

describe('isIsoDate', () => {
  it.each(['1999-01-04', '2024-06-01', '2024-02-29', '2026-12-31'])(
    'accepts the real calendar date %s',
    (value) => {
      expect(isIsoDate(value)).toBe(true);
    },
  );

  it.each([
    ['2024-6-1', 'unpadded month and day'],
    ['24-06-01', 'two-digit year'],
    ['2024/06/01', 'slash separators'],
    ['June 1 2024', 'prose'],
    ['2024-06-01T00:00:00Z', 'a full timestamp'],
    ['', 'an empty string'],
  ])('rejects %s (%s)', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it.each(['2024-02-31', '2023-02-29', '2024-13-01', '2024-00-10', '2024-06-00'])(
    'rejects the impossible date %s that still matches the YYYY-MM-DD shape',
    (value) => {
      expect(isIsoDate(value)).toBe(false);
    },
  );
});

describe('getRate', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(() => vi.unstubAllGlobals());

  it('dates an identity rate to the ECB publication day, flagging the snap like any other pair', async () => {
    const calls = stubFetch([
      [/\/currencies$/, CURRENCIES],
      // Saturday request; Frankfurter answers with Friday's fix.
      [/\/2024-06-01\?/, { amount: 1, base: 'USD', date: '2024-05-31', rates: { EUR: 0.92149 } }],
    ]);

    const result = await getFrankfurterService().getRate('usd', 'usd', '2024-06-01');

    // The self-pair never reaches the API — USD is quoted against EUR instead.
    expect(calls.some((url) => url.includes('symbols=EUR'))).toBe(true);
    expect(calls.some((url) => url.includes('symbols=USD'))).toBe(false);
    expect(result).toMatchObject({ rate: 1, rateDate: '2024-05-31', dateSnapped: true });
  });

  it('quotes an EUR identity pair against USD, since EUR against itself is the same 422', async () => {
    const calls = stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, { amount: 1, base: 'EUR', date: '2024-06-04', rates: { USD: 1.09 } }],
    ]);

    const result = await getFrankfurterService().getRate('EUR', 'EUR', 'latest');

    expect(calls.some((url) => url.includes('symbols=USD'))).toBe(true);
    expect(result).toMatchObject({ rate: 1, rateDate: '2024-06-04', dateSnapped: false });
  });

  it('fails an identity pair on a date the ECB never published for that currency', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        /\/currencies$/.test(url)
          ? ({ ok: true, json: async () => CURRENCIES } as unknown as Response)
          : ({ ok: false, status: 404 } as unknown as Response),
      ),
    );

    await expect(getFrankfurterService().getRate('USD', 'USD', '1999-01-01')).rejects.toMatchObject(
      { data: { reason: 'upstream_no_data' } },
    );
  });
});

describe('getTimeSeries', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(() => vi.unstubAllGlobals());

  it('drops the prior business day Frankfurter snapped to when the range opens on a weekend', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [
        /2024-06-01\.\.2024-06-05/,
        {
          amount: 1,
          base: 'USD',
          // Frankfurter widens the window backwards to the last publication day.
          start_date: '2024-05-31',
          end_date: '2024-06-05',
          rates: {
            '2024-05-31': { EUR: 0.92149 },
            '2024-06-03': { EUR: 0.91 },
            '2024-06-05': { EUR: 0.93 },
          },
        },
      ],
    ]);

    const result = await getFrankfurterService().getTimeSeries(
      'usd',
      'eur',
      '2024-06-01',
      '2024-06-05',
    );

    expect(result.rows.map((r) => r.date)).toEqual(['2024-06-03', '2024-06-05']);
    expect(result.startDate).toBe('2024-06-03');
    expect(result.endDate).toBe('2024-06-05');
  });

  it('reports the requested window when nothing inside it was published', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [
        /2024-06-01\.\.2024-06-01/,
        {
          amount: 1,
          base: 'USD',
          start_date: '2024-05-31',
          end_date: '2024-05-31',
          rates: { '2024-05-31': { EUR: 0.92149 } },
        },
      ],
    ]);

    const result = await getFrankfurterService().getTimeSeries(
      'USD',
      'EUR',
      '2024-06-01',
      '2024-06-01',
    );

    expect(result.rows).toEqual([]);
    expect(result.startDate).toBe('2024-06-01');
    expect(result.endDate).toBe('2024-06-01');
  });

  it('answers an identity pair with 1 on the days a proxy quote proves were published', async () => {
    const calls = stubFetch([
      [/\/currencies$/, CURRENCIES],
      [
        /2024-06-03\.\.2024-06-05/,
        {
          amount: 1,
          base: 'USD',
          start_date: '2024-06-03',
          end_date: '2024-06-05',
          rates: {
            '2024-06-03': { EUR: 0.91 },
            '2024-06-04': { EUR: 0.92 },
            '2024-06-05': { EUR: 0.93 },
          },
        },
      ],
    ]);

    const result = await getFrankfurterService().getTimeSeries(
      'USD',
      'USD',
      '2024-06-03',
      '2024-06-05',
    );

    // The self-pair never reaches the API — USD is quoted against EUR instead.
    expect(calls.some((url) => url.includes('symbols=EUR'))).toBe(true);
    expect(calls.some((url) => url.includes('symbols=USD'))).toBe(false);
    expect(result.rows).toEqual([
      { date: '2024-06-03', rate: 1, base_currency: 'USD', quote_currency: 'USD' },
      { date: '2024-06-04', rate: 1, base_currency: 'USD', quote_currency: 'USD' },
      { date: '2024-06-05', rate: 1, base_currency: 'USD', quote_currency: 'USD' },
    ]);
  });

  it('quotes an EUR identity pair against USD, since EUR against itself is the same 422', async () => {
    const calls = stubFetch([
      [/\/currencies$/, CURRENCIES],
      [
        /2024-06-03\.\.2024-06-03/,
        {
          amount: 1,
          base: 'EUR',
          start_date: '2024-06-03',
          end_date: '2024-06-03',
          rates: { '2024-06-03': { USD: 1.09 } },
        },
      ],
    ]);

    const result = await getFrankfurterService().getTimeSeries(
      'EUR',
      'EUR',
      '2024-06-03',
      '2024-06-03',
    );

    expect(calls.some((url) => url.includes('symbols=USD'))).toBe(true);
    expect(result.rows).toEqual([
      { date: '2024-06-03', rate: 1, base_currency: 'EUR', quote_currency: 'EUR' },
    ]);
  });
});

describe('getRates', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(() => vi.unstubAllGlobals());

  const snapshot = { amount: 1, base: 'USD', date: '2024-06-04', rates: { EUR: 0.92, GBP: 0.79 } };

  it('strips the base from the upstream symbols and injects its identity rate', async () => {
    const calls = stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, snapshot],
    ]);

    const result = await getFrankfurterService().getRates('USD', 'latest', ['USD', 'EUR', 'GBP']);

    const dataCall = calls.find((url) => url.includes('/latest?')) ?? '';
    expect(decodeURIComponent(dataCall)).toContain('symbols=EUR,GBP');
    expect(decodeURIComponent(dataCall)).not.toContain('USD,');
    expect(result.rates).toEqual({ EUR: 0.92, GBP: 0.79, USD: 1 });
  });

  it('returns just the identity rate when the base is the only symbol requested', async () => {
    const calls = stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, snapshot],
    ]);

    const result = await getFrankfurterService().getRates('usd', 'latest', ['usd']);

    // Nothing is left to filter on, so the unfiltered snapshot supplies the date.
    const dataCall = calls.find((url) => url.includes('/latest?')) ?? '';
    expect(dataCall).not.toContain('symbols=');
    expect(result.rates).toEqual({ USD: 1 });
    expect(result.date).toBe('2024-06-04');
  });

  it('leaves a snapshot without a self-symbol untouched', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, snapshot],
    ]);

    const result = await getFrankfurterService().getRates('USD', 'latest', ['EUR']);

    expect(result.rates).toEqual({ EUR: 0.92, GBP: 0.79 });
  });
});
