/**
 * @fileoverview Tests for the Frankfurter service — the date validation gate, the
 * range clipping that keeps snapped upstream dates out of a response, and the
 * identity-pair paths, which answer 1 locally but still read their date off a
 * proxy quote instead of echoing the caller's.
 * @module tests/services/frankfurter-service.test
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getFrankfurterService,
  isIsoDate,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

/** The ECB reference set, as `/currencies` returns it — trimmed to what these cases touch. */
const CURRENCIES = { EUR: 'Euro', GBP: 'British Pound', USD: 'US Dollar' };

/**
 * The service reads `globalThis.fetch`, so the upstream boundary is stubbed with the
 * framework's strict harness: routes answer with real `Response` objects, and any URL
 * the test did not anticipate throws instead of silently resolving.
 */
let http: FetchMockHarness | undefined;

/** Route the service's fetches by URL, answering each with a JSON body. */
const stubFetch = (routes: Array<[RegExp, unknown]>): void => {
  http = createFetchMock(routes.map(([match, body]) => ({ match, respond: Response.json(body) })));
  http.install();
};

/** URLs requested so far — read after the call under test, since the harness records as it goes. */
const requestedUrls = (): string[] => http?.calls.map((c) => c.request.url) ?? [];

const restoreFetch = () => {
  http?.restore();
  http = undefined;
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

describe('outbound request headers', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

  it('identifies itself with the released version, not a hardcoded one', async () => {
    stubFetch([[/\/currencies$/, CURRENCIES]]);

    await getFrankfurterService().listCurrencies();

    const request = http?.calls[0]?.request;
    expect(request?.headers.get('user-agent')).toBe(
      `exchange-rates-mcp-server/${config.mcpServerVersion}`,
    );
    expect(request?.headers.get('accept')).toBe('application/json');
  });
});

describe('getRate', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

  it('dates an identity rate to the ECB publication day, flagging the snap like any other pair', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      // Saturday request; Frankfurter answers with Friday's fix.
      [/\/2024-06-01\?/, { amount: 1, base: 'USD', date: '2024-05-31', rates: { EUR: 0.92149 } }],
    ]);

    const result = await getFrankfurterService().getRate('usd', 'usd', '2024-06-01');

    // The self-pair never reaches the API — USD is quoted against EUR instead.
    expect(requestedUrls().some((url) => url.includes('symbols=EUR'))).toBe(true);
    expect(requestedUrls().some((url) => url.includes('symbols=USD'))).toBe(false);
    expect(result).toMatchObject({ rate: 1, rateDate: '2024-05-31', dateSnapped: true });
  });

  it('quotes an EUR identity pair against USD, since EUR against itself is the same 422', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, { amount: 1, base: 'EUR', date: '2024-06-04', rates: { USD: 1.09 } }],
    ]);

    const result = await getFrankfurterService().getRate('EUR', 'EUR', 'latest');

    expect(requestedUrls().some((url) => url.includes('symbols=USD'))).toBe(true);
    expect(result).toMatchObject({ rate: 1, rateDate: '2024-06-04', dateSnapped: false });
  });

  it('fails an identity pair on a date the ECB never published for that currency', async () => {
    http = createFetchMock([
      { match: /\/currencies$/, respond: Response.json(CURRENCIES) },
      { match: () => true, respond: () => new Response(null, { status: 404 }) },
    ]);
    http.install();

    await expect(getFrankfurterService().getRate('USD', 'USD', '1999-01-01')).rejects.toMatchObject(
      { data: { reason: 'upstream_no_data' } },
    );
  });
});

describe('getTimeSeries', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

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
    stubFetch([
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
    expect(requestedUrls().some((url) => url.includes('symbols=EUR'))).toBe(true);
    expect(requestedUrls().some((url) => url.includes('symbols=USD'))).toBe(false);
    expect(result.rows).toEqual([
      { date: '2024-06-03', rate: 1, base_currency: 'USD', quote_currency: 'USD' },
      { date: '2024-06-04', rate: 1, base_currency: 'USD', quote_currency: 'USD' },
      { date: '2024-06-05', rate: 1, base_currency: 'USD', quote_currency: 'USD' },
    ]);
  });

  it('quotes an EUR identity pair against USD, since EUR against itself is the same 422', async () => {
    stubFetch([
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

    expect(requestedUrls().some((url) => url.includes('symbols=USD'))).toBe(true);
    expect(result.rows).toEqual([
      { date: '2024-06-03', rate: 1, base_currency: 'EUR', quote_currency: 'EUR' },
    ]);
  });
});

describe('getRates', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

  const snapshot = { amount: 1, base: 'USD', date: '2024-06-04', rates: { EUR: 0.92, GBP: 0.79 } };

  it('strips the base from the upstream symbols and injects its identity rate', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, snapshot],
    ]);

    const result = await getFrankfurterService().getRates('USD', 'latest', ['USD', 'EUR', 'GBP']);

    const dataCall = requestedUrls().find((url) => url.includes('/latest?')) ?? '';
    expect(decodeURIComponent(dataCall)).toContain('symbols=EUR,GBP');
    expect(decodeURIComponent(dataCall)).not.toContain('USD,');
    expect(result.rates).toEqual({ EUR: 0.92, GBP: 0.79, USD: 1 });
  });

  it('returns just the identity rate when the base is the only symbol requested', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, snapshot],
    ]);

    const result = await getFrankfurterService().getRates('usd', 'latest', ['usd']);

    // Nothing is left to filter on, so the unfiltered snapshot supplies the date.
    const dataCall = requestedUrls().find((url) => url.includes('/latest?')) ?? '';
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

describe('unsupported currency rejection', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

  /** The live set above, sorted — what every rejection lists after the rejected codes. */
  const ACCEPTED = ['EUR', 'GBP', 'USD'];

  it('lists the live accepted set after a rejected base, without reaching the rates endpoint', async () => {
    stubFetch([[/\/currencies$/, CURRENCIES]]);

    const rejection = getFrankfurterService().getRate('ars', 'USD', 'latest');

    await expect(rejection).rejects.toMatchObject({
      message: 'base_currency "ARS" is not supported by the ECB. Accepted: EUR, GBP, USD.',
      data: {
        accepted_codes: ACCEPTED,
        field: 'base_currency',
        reason: 'unsupported_currency',
        rejected_codes: ['ARS'],
      },
    });
    expect(requestedUrls().every((url) => url.endsWith('/currencies'))).toBe(true);
  });

  it('lists the accepted set once for several rejected symbols, blaming symbols alone', async () => {
    stubFetch([[/\/currencies$/, CURRENCIES]]);

    const error = await getFrankfurterService()
      .getRates('USD', '2024-06-03', ['ars', 'EUR', 'vnd'])
      .then(
        () => expect.unreachable('expected getRates to reject'),
        (e: unknown) => e as Error & { data: unknown },
      );

    expect(error.message).toBe(
      'symbols contains codes not supported by the ECB: ARS, VND. Accepted: EUR, GBP, USD.',
    );
    expect(error.message.split('Accepted:')).toHaveLength(2);
    expect(error.data).toMatchObject({
      accepted_codes: ACCEPTED,
      field: 'symbols',
      rejected_codes: ['ARS', 'VND'],
    });
  });

  it('carries the accepted set on a rejected quote in a time series', async () => {
    stubFetch([[/\/currencies$/, CURRENCIES]]);

    await expect(
      getFrankfurterService().getTimeSeries('USD', 'TWD', '2024-06-03', '2024-06-05'),
    ).rejects.toMatchObject({
      message: 'quote_currency "TWD" is not supported by the ECB. Accepted: EUR, GBP, USD.',
      data: { accepted_codes: ACCEPTED, field: 'quote_currency', rejected_codes: ['TWD'] },
    });
  });

  it('propagates a failed currency-list fetch unchanged instead of building a rejection', async () => {
    http = createFetchMock([
      { match: /\/currencies$/, respond: () => new Response('bad request', { status: 400 }) },
    ]);
    http.install();

    const error = await getFrankfurterService()
      .getRates('ARS', 'latest')
      .then(
        () => expect.unreachable('expected getRates to reject'),
        (e: unknown) => e as { code: number; data?: { reason?: string } },
      );

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).not.toBe('unsupported_currency');
    expect(requestedUrls()).toHaveLength(1);
  });
});
