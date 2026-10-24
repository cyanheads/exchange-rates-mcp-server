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
import { getServerConfig } from '@/config/server-config.js';
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

  it('derives an unrounded cross-rate from one unfiltered EUR snapshot', async () => {
    stubFetch([
      [/\/currencies$/, { ...CURRENCIES, KRW: 'Korean Won' }],
      [
        /\/2024-06-03\?/,
        { amount: 1, base: 'EUR', date: '2024-06-03', rates: { KRW: 1493.24, USD: 1.0842 } },
      ],
    ]);
    const rate = await getFrankfurterService().getRate('KRW', 'USD', '2024-06-03');
    expect(rate.rate).toBe(0.0007260721652246123);
    expect(requestedUrls().filter((url) => url.includes('/2024-06-03?'))).toEqual([
      `${getServerConfig().frankfurterBaseUrl}/2024-06-03?base=EUR`,
    ]);
  });

  it('accepts historical retired currencies and trims currency values', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [
        /\/2005-06-01\?/,
        { amount: 1, base: 'EUR', date: '2005-06-01', rates: { CYP: 0.58, USD: 1.22 } },
      ],
    ]);
    const rate = await getFrankfurterService().getRate(' cyp ', ' eur ', '2005-06-01');
    expect(rate).toMatchObject({
      baseCurrency: 'CYP',
      quoteCurrency: 'EUR',
      rate: 1 / 0.58,
      source: 'Frankfurter v1',
      rateType: 'Daily rate (Frankfurter v1)',
    });
  });

  it('derives bulk filtered and unfiltered historical snapshots consistently', async () => {
    stubFetch([
      [
        /\/2005-06-01\?/,
        { amount: 1, base: 'EUR', date: '2005-06-01', rates: { CYP: 0.58, USD: 1.22 } },
      ],
    ]);
    const service = getFrankfurterService();
    expect((await service.getRates('EUR', '2005-06-01')).rates).toEqual({ CYP: 0.58, USD: 1.22 });
    expect(
      (await service.getRates(' cyp ', '2005-06-01', [' eur ', 'cyp', ' usd '])).rates,
    ).toEqual({ EUR: 1 / 0.58, CYP: 1, USD: 1.22 / 0.58 });
    expect(requestedUrls()).toHaveLength(2);
    expect(requestedUrls().every((url) => url.endsWith('?base=EUR'))).toBe(true);
  });

  it('uses every raw served date for historical availability but emits only coexisting in-range legs', async () => {
    stubFetch([
      [
        /2005-06-01\.\.2005-06-06/,
        {
          rates: {
            '2005-05-31': { USD: 2, CYP: 0.6 },
            '2005-06-01': { USD: 2 },
            '2005-06-02': { CYP: 0.5, USD: 2 },
            '2005-06-03': { USD: 2 },
            '2005-06-06': { USD: 2 },
          },
        },
      ],
    ]);
    const result = await getFrankfurterService().getTimeSeries(
      'CYP',
      'USD',
      '2005-06-01',
      '2005-06-06',
    );
    expect(result.rows).toEqual([
      { date: '2005-06-02', rate: 4, base_currency: 'CYP', quote_currency: 'USD' },
    ]);
    expect(requestedUrls()).toHaveLength(1);
  });

  it.each(['USD', 'CYP'])(
    'preserves real publication dates for historical %s identities',
    async (code) => {
      stubFetch([
        [
          /2005-06-01\.\.2005-06-03/,
          {
            rates: {
              '2005-06-01': { USD: 2 },
              '2005-06-02': { CYP: 0.5 },
              '2005-06-03': { USD: 2, CYP: 0.6 },
            },
          },
        ],
      ]);
      const result = await getFrankfurterService().getTimeSeries(
        code,
        code,
        '2005-06-01',
        '2005-06-03',
      );
      expect(result.rows.map((row) => [row.date, row.rate])).toEqual(
        code === 'USD'
          ? [
              ['2005-06-01', 1],
              ['2005-06-03', 1],
            ]
          : [
              ['2005-06-02', 1],
              ['2005-06-03', 1],
            ],
      );
    },
  );

  it('distinguishes a current currency with missing observations from an unknown historical code', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/2005-06-01\?/, { amount: 1, base: 'EUR', date: '2005-06-01', rates: { CYP: 0.58 } }],
    ]);
    await expect(getFrankfurterService().getRate('USD', 'EUR', '2005-06-01')).rejects.toMatchObject(
      { data: { reason: 'upstream_no_data' } },
    );
    await expect(
      getFrankfurterService().getRates('EUR', '2005-06-01', ['zzz', 'aaa']),
    ).rejects.toMatchObject({
      data: {
        field: 'symbols',
        reason: 'unsupported_currency',
        accepted_codes: ['CYP', 'EUR'],
        rejected_codes: ['AAA', 'ZZZ'],
      },
    });
  });

  it('keeps current discovery dated and immune to caller mutation', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, { date: '2024-06-03', base: 'EUR', amount: 1, rates: { USD: 1.0842 } }],
    ]);
    const service = getFrankfurterService();
    const first = await service.currencyDiscovery();
    first.currencies[0]!.code = 'MUTATED';
    first.currencies.length = 1;
    expect(await service.currencyDiscovery()).toEqual({
      currencies: [
        { code: 'EUR', name: 'Euro' },
        { code: 'GBP', name: 'British Pound' },
        { code: 'USD', name: 'US Dollar' },
      ],
      as_of: '2024-06-03',
    });
    expect(requestedUrls()).toHaveLength(2);
  });

  it('dates an identity rate to the ECB publication day, flagging the snap like any other pair', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      // Saturday request; Frankfurter answers with Friday's fix.
      [/\/2024-06-01\?/, { amount: 1, base: 'EUR', date: '2024-05-31', rates: { USD: 1.0852 } }],
    ]);

    const result = await getFrankfurterService().getRate('usd', 'usd', '2024-06-01');

    // The self-pair never reaches the API — USD is quoted against EUR instead.
    expect(requestedUrls().some((url) => url.includes('base=EUR'))).toBe(true);
    expect(requestedUrls().some((url) => url.includes('symbols=USD'))).toBe(false);
    expect(result).toMatchObject({ rate: 1, rateDate: '2024-05-31', dateSnapped: true });
  });

  it('quotes an EUR identity pair against USD, since EUR against itself is the same 422', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, { amount: 1, base: 'EUR', date: '2024-06-04', rates: { USD: 1.09 } }],
    ]);

    const result = await getFrankfurterService().getRate('EUR', 'EUR', 'latest');

    expect(requestedUrls().some((url) => url.includes('base=EUR'))).toBe(true);
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
            '2024-05-31': { USD: 1.0852 },
            '2024-06-03': { USD: 1.1 },
            '2024-06-05': { USD: 1.09 },
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
          rates: { '2024-05-31': { USD: 1.0852 } },
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
            '2024-06-03': { USD: 1.1 },
            '2024-06-04': { USD: 1.08 },
            '2024-06-05': { USD: 1.09 },
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
    expect(requestedUrls().some((url) => url.includes('base=EUR'))).toBe(true);
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

    expect(requestedUrls().some((url) => url.includes('base=EUR'))).toBe(true);
    expect(result.rows).toEqual([
      { date: '2024-06-03', rate: 1, base_currency: 'EUR', quote_currency: 'EUR' },
    ]);
  });
});

describe('getRates', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

  const snapshot = { amount: 1, base: 'EUR', date: '2024-06-04', rates: { USD: 2, GBP: 1.58 } };

  it('derives the requested quotes and identity from an unfiltered EUR snapshot', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/\/latest\?/, snapshot],
    ]);

    const result = await getFrankfurterService().getRates('USD', 'latest', ['USD', 'EUR', 'GBP']);

    const dataCall = requestedUrls().find((url) => url.includes('/latest?')) ?? '';
    expect(decodeURIComponent(dataCall)).toContain('base=EUR');
    expect(dataCall).not.toContain('symbols=');
    expect(decodeURIComponent(dataCall)).not.toContain('USD,');
    expect(result.rates).toEqual({ EUR: 0.5, GBP: 0.79, USD: 1 });
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

    expect(result.rates).toEqual({ EUR: 0.5 });
  });
});

/**
 * `McpError.data` is forwarded to the client as `structuredContent.error.data`, so
 * nothing thrown out of the HTTP boundary may carry the request URL: it holds the
 * caller's codes and dates alongside whatever host `FRANKFURTER_BASE_URL` names.
 * Every failure shape the boundary can produce is covered — a non-2xx through the
 * framework's `httpErrorFromResponse`, the 404 shortcut, and a fetch that throws.
 */
describe('upstream failure error data', () => {
  beforeEach(() => resetFrankfurterService());
  afterEach(restoreFetch);

  /** The base URL the failing request carries, so a leak is recognizable in any field. */
  const BASE_URL = getServerConfig().frankfurterBaseUrl;

  const rejectionOf = async (promise: Promise<unknown>) =>
    promise.then(
      () => expect.unreachable('expected the request to reject'),
      (e: unknown) =>
        e as Error & { code: number; data?: Record<string, unknown>; cause?: unknown },
    );

  /** Every error reachable through `cause`, so a retry wrapper between the two does not hide the original. */
  const causeChain = (error: unknown): unknown[] => {
    const chain: unknown[] = [];
    for (let link = error; link != null; link = (link as { cause?: unknown }).cause) {
      chain.push(link);
    }
    return chain;
  };

  it('keeps the request URL off a non-2xx error, naming the service instead', async () => {
    http = createFetchMock([
      { match: /\/currencies$/, respond: Response.json(CURRENCIES) },
      { match: () => true, respond: () => new Response('upstream said no', { status: 400 }) },
    ]);
    http.install();

    const error = await rejectionOf(getFrankfurterService().getRate('USD', 'EUR', 'latest'));

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).not.toHaveProperty('url');
    expect(JSON.stringify(error.data)).not.toContain(BASE_URL);
    expect(error.message).toContain('Frankfurter');
    /** The status and body still reach the caller — it is the URL alone that is withheld. */
    expect(error.data).toMatchObject({ status: 400, body: 'upstream said no' });
  });

  it('keeps the request URL off the 404 upstream_no_data shortcut', async () => {
    http = createFetchMock([
      { match: /\/currencies$/, respond: Response.json(CURRENCIES) },
      { match: () => true, respond: () => new Response(null, { status: 404 }) },
    ]);
    http.install();

    const error = await rejectionOf(getFrankfurterService().getRate('USD', 'EUR', '1999-01-01'));

    expect(error.data).toEqual({ reason: 'upstream_no_data' });
  });

  it('keeps the request URL off an unreachable-API error while chaining the cause', async () => {
    const networkFailure = new TypeError('fetch failed');
    http = createFetchMock([
      {
        match: () => true,
        respond: () => {
          throw networkFailure;
        },
      },
    ]);
    http.install();

    const error = await rejectionOf(getFrankfurterService().listCurrencies());

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('Frankfurter API unreachable');
    expect(error.data).not.toHaveProperty('url');
    expect(JSON.stringify(error.data)).not.toContain(BASE_URL);
    /** Withholding the URL must not also cut the chain back to the underlying fetch failure. */
    expect(causeChain(error)).toContain(networkFailure);
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
      message:
        'base_currency "ARS" is not available in this Frankfurter v1 currency set. Accepted: EUR, GBP, USD.',
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
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [
        /\/2024-06-03\?/,
        { amount: 1, base: 'EUR', date: '2024-06-03', rates: { USD: 1.1, GBP: 0.85 } },
      ],
    ]);

    const error = await getFrankfurterService()
      .getRates('USD', '2024-06-03', ['ars', 'EUR', 'vnd'])
      .then(
        () => expect.unreachable('expected getRates to reject'),
        (e: unknown) => e as Error & { data: unknown },
      );

    expect(error.message).toBe(
      'symbols contains codes outside this Frankfurter v1 currency set: ARS, VND. Accepted: EUR, GBP, USD.',
    );
    expect(error.message.split('Accepted:')).toHaveLength(2);
    expect(error.data).toMatchObject({
      accepted_codes: ACCEPTED,
      field: 'symbols',
      rejected_codes: ['ARS', 'VND'],
    });
  });

  it('carries the accepted set on a rejected quote in a time series', async () => {
    stubFetch([
      [/\/currencies$/, CURRENCIES],
      [/2024-06-03\.\.2024-06-05/, { rates: { '2024-06-03': { USD: 1.1, GBP: 0.85 } } }],
    ]);

    await expect(
      getFrankfurterService().getTimeSeries('USD', 'TWD', '2024-06-03', '2024-06-05'),
    ).rejects.toMatchObject({
      message:
        'quote_currency "TWD" is not available in this Frankfurter v1 currency set. Accepted: EUR, GBP, USD.',
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
