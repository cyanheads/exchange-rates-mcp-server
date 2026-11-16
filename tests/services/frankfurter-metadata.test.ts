/**
 * @fileoverview Optional official currency coverage at the fetch boundary.
 * @module tests/services/frankfurter-metadata.test
 */
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as configModule from '@/config/server-config.js';
import { fxCurrenciesResource } from '@/mcp-server/resources/definitions/fx-currencies.resource.js';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { fxListCurrencies } from '@/mcp-server/tools/definitions/fx-list-currencies.tool.js';
import { fetchCurrencyMetadata } from '@/services/frankfurter/currency-metadata.js';
import {
  getFrankfurterService,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

let http: FetchMockHarness;
/** Rows keep the live keys the parser ignores (`iso_numeric`, `symbol`, `type`). */
const metadata = [
  {
    iso_code: 'USD',
    iso_numeric: '840',
    name: 'Metadata dollar',
    symbol: '$',
    type: 'currency',
    start_date: '1999-01-04',
    end_date: '2024-06-03',
  },
  {
    iso_code: 'EUR',
    iso_numeric: '978',
    name: 'Euro',
    symbol: '€',
    type: 'currency',
    start_date: '1999-01-04',
    end_date: '2024-06-03',
  },
  {
    iso_code: 'RUB',
    iso_numeric: '643',
    name: 'Russian Ruble',
    symbol: '₽',
    type: 'currency',
    start_date: '1999-01-04',
    end_date: '2022-03-01',
  },
];
const install = (body: unknown = metadata, status = 200) => {
  http = createFetchMock([
    { match: /\/v1\/currencies$/, respond: Response.json({ USD: 'US Dollar', EUR: 'Euro' }) },
    {
      match: /\/v1\/latest\?base=EUR$/,
      respond: Response.json({ amount: 1, base: 'EUR', date: '2024-06-03', rates: { USD: 1.1 } }),
    },
    {
      match: 'https://api.frankfurter.dev/v2/currencies?scope=all&providers=ECB',
      respond: Response.json(body, { status }),
    },
  ]);
  http.install();
};
beforeEach(() => resetFrankfurterService());
afterEach(() => {
  http?.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('optional currency metadata', () => {
  it('preserves discovery when metadata body consumption fails with a plain stream error', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/v1/currencies')) return Response.json({ EUR: 'Euro' });
      if (url.includes('/v1/latest')) return Response.json({ date: '2024-06-03', rates: {} });
      calls++;
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.error(new Error('metadata connection closed'));
          },
        }),
      );
    });
    const result = await runToolContract(fxListCurrencies, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      count: 1,
      notice: expect.stringContaining('unavailable'),
    });
    expect(JSON.stringify(result.content)).toContain('unavailable');
    expect(calls).toBe(1);
  });
  it('characterizes current discovery names and rate success', async () => {
    install();
    expect(await getFrankfurterService().getRate('EUR', 'USD', 'latest')).toMatchObject({
      rate: 1.1,
      source: 'Frankfurter v1',
    });
    expect(
      (await getFrankfurterService().currencyDiscovery()).currencies.map(({ code, name }) => ({
        code,
        name,
      })),
    ).toEqual([
      { code: 'EUR', name: 'Euro' },
      { code: 'USD', name: 'US Dollar' },
    ]);
  });
  it('adds retired codes only on opt-in, preserves v1 names, and renders bounds', async () => {
    install();
    const current = await runToolContract(fxListCurrencies, {});
    expect(current.structuredContent).toMatchObject({
      count: 2,
      currencies: [
        { code: 'EUR', start_date: '1999-01-04', end_date: '2024-06-03', retired: false },
        { code: 'USD', name: 'US Dollar', end_date: '2024-06-03', retired: false },
      ],
    });
    const all = await runToolContract(fxListCurrencies, { include_retired: true });
    expect(all.structuredContent).toMatchObject({
      count: 3,
      currencies: [
        { code: 'EUR', retired: false },
        { code: 'RUB', start_date: '1999-01-04', end_date: '2022-03-01', retired: true },
        { code: 'USD', retired: false },
      ],
    });
    expect(JSON.stringify(all.content)).toContain('2022-03-01');
    expect(http.calls.filter(({ request }) => request.url.includes('/v2/'))).toHaveLength(1);
  });

  it.each([{}, { include_retired: true }])(
    'marks exactly the appended rows retired, alike on both surfaces (%o)',
    async (input) => {
      install();
      const result = await runToolContract(fxListCurrencies, input);
      const { currencies } = result.structuredContent as {
        currencies: Array<{ code: string; retired: boolean }>;
      };
      const lines = (result.content[0] as { text: string }).text.split('\n');
      expect(currencies.filter(({ retired }) => retired).map(({ code }) => code)).toEqual(
        'include_retired' in input ? ['RUB'] : [],
      );
      for (const { code, retired } of currencies) {
        const line = lines.find((text) => text.startsWith(`**${code}** — `));
        expect(line?.endsWith(' · retired')).toBe(retired);
      }
      if ('include_retired' in input) {
        expect(lines).toContain(
          '**RUB** — Russian Ruble · start_date: 1999-01-04 · end_date: 2022-03-01 · retired',
        );
      }
    },
  );
  /**
   * Retirement is v1 membership alone. Metadata is cached a day while as_of is read per call,
   * so a current code's end_date can trail as_of, and a current code can lack a metadata row.
   */
  it.each([
    {
      name: 'its metadata end_date precedes as_of',
      body: metadata.map((row) =>
        row.iso_code === 'USD' ? { ...row, end_date: '2024-05-31' } : row,
      ),
      usd: {
        code: 'USD',
        name: 'US Dollar',
        start_date: '1999-01-04',
        end_date: '2024-05-31',
        retired: false,
      },
      line: '**USD** — US Dollar · start_date: 1999-01-04 · end_date: 2024-05-31',
    },
    {
      name: 'available metadata has no row for it',
      body: metadata.filter((row) => row.iso_code !== 'USD'),
      usd: { code: 'USD', name: 'US Dollar', retired: false },
      line: '**USD** — US Dollar',
    },
  ])(
    'keeps a current code unretired when $name, alike on both surfaces',
    async ({ body, usd, line }) => {
      install(body);
      for (const input of [{}, { include_retired: true }]) {
        const result = await runToolContract(fxListCurrencies, input);
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as {
          as_of: string;
          currencies: Array<{ code: string }>;
        };
        expect(data.as_of).toBe('2024-06-03');
        expect(data).not.toHaveProperty('notice');
        expect(data.currencies.find(({ code }) => code === 'USD')).toEqual(usd);
        const lines = (result.content[0] as { text: string }).text.split('\n');
        expect(lines.filter((text) => text.startsWith('**USD** — '))).toEqual([line]);
      }
    },
  );
  it.each([
    [{}, 200],
    [metadata, 503],
  ])('discloses unavailable enrichment without failing v1 discovery', async (body, status) => {
    install(body, status as number);
    const result = await runToolContract(fxListCurrencies, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      count: 2,
      notice: expect.stringContaining('unavailable'),
    });
    expect(JSON.stringify(result.content)).toContain('unavailable');
    expect(await getFrankfurterService().getRate('EUR', 'USD', 'latest')).toMatchObject({
      rate: 1.1,
    });
  });
  it('enriches a retired-code error without changing its reason or current accepted set', async () => {
    install();
    const result = await runToolContract(fxGetRate, {
      base_currency: 'RUB',
      quote_currency: 'EUR',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'unsupported_currency',
          field: 'base_currency',
          accepted_codes: ['EUR', 'USD'],
          currency_windows: [{ code: 'RUB', start_date: '1999-01-04', end_date: '2022-03-01' }],
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('2022-03-01');
    expect(JSON.stringify(result.content)).toContain('historical');
  });
  it('keeps the static resource current-only with optional bounds and no invented parameters', async () => {
    install();
    const result = await fxCurrenciesResource.handler({}, createMockContext());
    expect(fxCurrenciesResource.params!.parse({ include_retired: true })).toEqual({});
    /** The read is served through this output schema, the same parse the framework applies. */
    const served = fxCurrenciesResource.output!.parse(result);
    expect(served).toMatchObject({
      count: 2,
      currencies: [
        { code: 'EUR', start_date: '1999-01-04' },
        { code: 'USD', end_date: '2024-06-03' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('RUB');
    expect(JSON.stringify(served)).not.toContain('retired');
  });
  it.each([
    { body: [] },
    { body: [{ ...metadata[0], start_date: '2024-02-31' }] },
    { body: [{ ...metadata[0], start_date: '2025-01-01' }] },
    { body: [metadata[0], metadata[0]] },
    { body: [{ ...metadata[0], end_date: null }] },
  ])('rejects malformed or ambiguous metadata without fabricating coverage', async ({ body }) => {
    install(body);
    const result = await runToolContract(fxListCurrencies, { include_retired: true });
    expect(result.structuredContent).toMatchObject({
      count: 2,
      currencies: [
        { code: 'EUR', retired: false },
        { code: 'USD', retired: false },
      ],
      notice: expect.stringContaining('unavailable'),
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('start_date');
    expect(JSON.stringify(result.content)).toContain('unavailable');
    expect(JSON.stringify(result.content)).not.toContain('· retired');
  });
  it('does not contact the official endpoint for a custom v1 base', async () => {
    const config = configModule.getServerConfig();
    vi.spyOn(configModule, 'getServerConfig').mockReturnValue({
      ...config,
      frankfurterBaseUrl: 'https://custom.example/v1',
    });
    http = createFetchMock([
      {
        match: 'https://custom.example/v1/currencies',
        respond: Response.json({ XXX: 'Custom currency' }),
      },
      {
        match: 'https://custom.example/v1/latest?base=EUR',
        respond: Response.json({ date: '2024-06-03', rates: { XXX: 2 } }),
      },
    ]);
    http.install();
    const result = await runToolContract(fxListCurrencies, { include_retired: true });
    expect(result.structuredContent).toMatchObject({
      currencies: [{ code: 'XXX', name: 'Custom currency' }],
      notice: expect.stringContaining('unavailable'),
    });
    expect(http.calls.map(({ request }) => request.url)).toEqual([
      'https://custom.example/v1/currencies',
      'https://custom.example/v1/latest?base=EUR',
    ]);
  });
  it('retries failed metadata after five minutes, restoring retired rows without waiting a day', async () => {
    vi.useFakeTimers();
    let metadataUp = false;
    let metadataCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/v1/currencies')) return Response.json({ EUR: 'Euro', USD: 'US Dollar' });
      if (url.includes('/v1/latest'))
        return Response.json({ date: '2024-06-03', rates: { USD: 1.1 } });
      metadataCalls++;
      return metadataUp ? Response.json(metadata) : new Response(null, { status: 503 });
    });
    const service = getFrankfurterService();
    const retired = async () =>
      (await service.currencyDiscovery(undefined, true)).currencies
        .filter((row) => row.retired)
        .map((row) => row.code);
    expect(await retired()).toEqual([]);
    metadataUp = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await retired()).toEqual([]);
    expect(metadataCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await retired()).toEqual(['RUB']);
    expect(metadataCalls).toBe(2);
  });
  it('refreshes successful metadata once per daily cadence', async () => {
    vi.useFakeTimers();
    install();
    const service = getFrankfurterService();
    const metadataCalls = () => http.calls.filter(({ request }) => request.url.includes('/v2/'));
    const latestCalls = () => http.calls.filter(({ request }) => request.url.includes('/latest?'));
    await service.currencyDiscovery();
    await service.currencyDiscovery();
    expect(metadataCalls()).toHaveLength(1);
    expect(latestCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(86_400_001);
    await service.currencyDiscovery();
    expect(metadataCalls()).toHaveLength(2);
    expect(latestCalls()).toHaveLength(3);
  });

  it.each(['fetch', 'body'] as const)(
    'rethrows caller cancellation during metadata %s without caching or sharing it',
    async (phase) => {
      const caller = new AbortController();
      const reason = new Error('metadata caller left');
      let metadataCalls = 0;
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (url.endsWith('/v1/currencies')) return Response.json({ EUR: 'Euro', USD: 'US Dollar' });
        if (url.includes('/v1/latest'))
          return Response.json({ date: '2024-06-03', rates: { USD: 1.1 } });
        metadataCalls++;
        if (metadataCalls > 1) return Response.json(metadata);
        if (phase === 'fetch') {
          caller.abort(reason);
          init.signal!.throwIfAborted();
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              init.signal!.addEventListener('abort', () => stream.error(init.signal!.reason), {
                once: true,
              });
              stream.enqueue(new TextEncoder().encode('['));
            },
            pull() {
              caller.abort(reason);
            },
          }),
        );
      });
      const service = getFrankfurterService();
      await expect(service.currencyDiscovery(caller.signal)).rejects.toBe(reason);
      expect(metadataCalls).toBe(1);
      expect((await service.currencyDiscovery(undefined, true)).currencies).toHaveLength(3);
      expect(metadataCalls).toBe(2);
    },
  );

  it('rethrows caller cancellation from the metadata request itself, never degrading it to unavailable', async () => {
    const caller = new AbortController();
    const reason = new Error('metadata caller left');
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      caller.abort(reason);
      init.signal!.throwIfAborted();
      return Response.json(metadata);
    });
    await expect(
      fetchCurrencyMetadata('exchange-rates-mcp-server/test', caller.signal),
    ).rejects.toBe(reason);
  });

  it('preserves the original unsupported diagnosis through metadata network failure with no retry', async () => {
    let metadataCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/v1/currencies')) return Response.json({ EUR: 'Euro', USD: 'US Dollar' });
      metadataCalls++;
      throw new TypeError('network down');
    });
    const result = await runToolContract(fxGetRate, {
      base_currency: 'RUB',
      quote_currency: 'EUR',
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'unsupported_currency', rejected_codes: ['RUB'] } },
    });
    expect(metadataCalls).toBe(1);
  });

  it('does not expose cache-owned retired rows through discovery or error recovery', async () => {
    install();
    const service = getFrankfurterService();
    const discovery = await service.currencyDiscovery(undefined, true);
    const rub = discovery.currencies.find((currency) => currency.code === 'RUB')!;
    rub.start_date = 'MUTATED';
    rub.retired = false;
    discovery.currencies.find((currency) => currency.code === 'EUR')!.retired = true;
    const error = (await service
      .getRate('RUB', 'EUR', 'latest')
      .catch((error: unknown) => error)) as {
      data: { currency_windows: Array<{ start_date: string }> };
    };
    expect(error.data.currency_windows[0]!.start_date).toBe('1999-01-04');
    /** `currency_windows` keeps the `Currency` shape; only discovery rows carry `retired`. */
    expect(error.data.currency_windows[0]).not.toHaveProperty('retired');
    error.data.currency_windows[0]!.start_date = 'MUTATED';
    const again = (await service.currencyDiscovery(undefined, true)).currencies;
    expect(again.find((currency) => currency.code === 'RUB')).toMatchObject({
      start_date: '1999-01-04',
      retired: true,
    });
    expect(again.find((currency) => currency.code === 'EUR')).toMatchObject({ retired: false });
  });

  it('does not expose cache-owned rows from a cold metadata read on the error path', async () => {
    install();
    const service = getFrankfurterService();
    const error = (await service
      .getRate('RUB', 'EUR', 'latest')
      .catch((error: unknown) => error)) as {
      data: { reason: string; currency_windows: Array<{ start_date: string }> };
    };
    expect(error.data.reason).toBe('unsupported_currency');
    expect(error.data.currency_windows).toEqual([
      { code: 'RUB', name: 'Russian Ruble', start_date: '1999-01-04', end_date: '2022-03-01' },
    ]);
    error.data.currency_windows[0]!.start_date = 'MUTATED';
    const discovery = await service.currencyDiscovery(undefined, true);
    expect(discovery.currencies.find((currency) => currency.code === 'RUB')).toEqual({
      code: 'RUB',
      name: 'Russian Ruble',
      start_date: '1999-01-04',
      end_date: '2022-03-01',
      retired: true,
    });
    /** Discovery answered from the cache the error path filled, not a fresh read. */
    expect(http.calls.filter(({ request }) => request.url.includes('/v2/'))).toHaveLength(1);
  });

  it('bounds the entire metadata read to one second without retrying or failing discovery', async () => {
    const budget = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => (ms === 1_000 ? budget.signal : nativeTimeout(ms)));
    let started!: () => void;
    const metadataStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/currencies')) return Response.json({ EUR: 'Euro' });
      if (url.includes('/v1/latest')) return Response.json({ date: '2024-06-03', rates: {} });
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        started();
      });
    });
    const result = runToolContract(fxListCurrencies, {});
    await metadataStarted;
    expect(timeout).toHaveBeenCalledWith(1_000);
    budget.abort(new DOMException('metadata budget exhausted', 'TimeoutError'));
    const wire = await result;
    expect(wire.structuredContent).toMatchObject({
      count: 1,
      notice: expect.stringContaining('unavailable'),
    });
    expect(JSON.stringify(wire.content)).toContain('unavailable');
    expect(calls).toBe(1);
  });

  it('allows an independent caller to complete while the first metadata caller is cancelled', async () => {
    const caller = new AbortController();
    const reason = new Error('first metadata caller left');
    let started!: () => void;
    const metadataStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/currencies')) return Response.json({ EUR: 'Euro', USD: 'US Dollar' });
      if (url.includes('/v1/latest'))
        return Response.json({ date: '2024-06-03', rates: { USD: 1.1 } });
      calls++;
      if (calls > 1) return Response.json(metadata);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        started();
      });
    });
    const service = getFrankfurterService();
    const cancelled = service.currencyDiscovery(caller.signal).catch((error: unknown) => error);
    await metadataStarted;
    expect((await service.currencyDiscovery(undefined, true)).currencies).toHaveLength(3);
    caller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect((await service.currencyDiscovery(undefined, true)).currencies).toHaveLength(3);
    expect(calls).toBe(2);
  });
});

describe('coverage bounds on a dated upstream_no_data', () => {
  /** Live official bounds for the codes these cases miss. */
  const bounds = {
    BRL: { code: 'BRL', name: 'Brazilian Real', start_date: '2000-01-13', end_date: '2026-11-13' },
    ILS: {
      code: 'ILS',
      name: 'Israeli New Shekel',
      start_date: '2000-01-13',
      end_date: '2026-11-13',
    },
    INR: { code: 'INR', name: 'Indian Rupee', start_date: '2000-01-13', end_date: '2026-11-13' },
    ISK: { code: 'ISK', name: 'Icelandic Króna', start_date: '1999-01-04', end_date: '2026-11-13' },
  };
  /** The live keys the parser ignores, per code; `currency_windows` never carries them. */
  const unparsed = {
    BRL: { iso_numeric: '986', symbol: 'R$' },
    EUR: { iso_numeric: '978', symbol: '€' },
    ILS: { iso_numeric: '376', symbol: '₪' },
    INR: { iso_numeric: '356', symbol: '₹' },
    ISK: { iso_numeric: '352', symbol: 'kr.' },
    USD: { iso_numeric: '840', symbol: '$' },
  };
  const official = [
    ...Object.values(bounds),
    { code: 'EUR', name: 'Euro', start_date: '1999-01-04', end_date: '2026-11-13' },
    { code: 'USD', name: 'US Dollar', start_date: '1999-01-04', end_date: '2026-11-13' },
  ].map(({ code, ...row }) => ({
    iso_code: code,
    ...unparsed[code as keyof typeof unparsed],
    type: 'currency',
    ...row,
  }));
  const installServed = (metadataResponse: () => Response = () => Response.json(official)) => {
    http = createFetchMock([
      {
        match: /\/v1\/currencies$/,
        respond: Response.json({
          BRL: 'Brazilian Real',
          EUR: 'Euro',
          ILS: 'Israeli New Shekel',
          INR: 'Indian Rupee',
          ISK: 'Icelandic Króna',
          USD: 'US Dollar',
        }),
      },
      {
        match: /\/v1\/latest\?base=EUR$/,
        respond: Response.json({ date: '2026-11-13', rates: { ISK: 140.2, USD: 1.16 } }),
      },
      {
        match: /\/v1\/1999-03-01\?base=EUR$/,
        respond: Response.json({ date: '1999-03-01', rates: { ISK: 79.16, USD: 1.0925 } }),
      },
      {
        match: /\/v1\/2012-06-01\?base=EUR$/,
        respond: Response.json({
          date: '2012-06-01',
          rates: { BRL: 2.5, ILS: 4.8, INR: 69.2, USD: 1.2403 },
        }),
      },
      {
        /** A Saturday: served as the prior Friday, which has no ISK fix. */
        match: /\/v1\/2012-06-02\?base=EUR$/,
        respond: Response.json({
          date: '2012-06-01',
          rates: { BRL: 2.5, ILS: 4.8, INR: 69.2, USD: 1.2403 },
        }),
      },
      {
        match: /\/v1\/1999-01-04\.\.1999-12-31\?base=EUR$/,
        respond: Response.json({
          rates: { '1999-01-04': { USD: 1.1789 }, '1999-12-31': { USD: 1.0046 } },
        }),
      },
      {
        match: /\/v1\/2012-06-01\.\.2012-06-30\?base=EUR$/,
        respond: Response.json({
          rates: { '2012-06-01': { USD: 1.2403 }, '2012-06-29': { USD: 1.259 } },
        }),
      },
      {
        match: 'https://api.frankfurter.dev/v2/currencies?scope=all&providers=ECB',
        respond: metadataResponse,
      },
    ]);
    http.install();
  };
  const urls = () => http.calls.map(({ request }) => request.url);
  const errorOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { error: { message: string; data: Record<string, unknown> } })
      .error;
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block as { text: string }).text).join('\n');

  it.each([
    {
      name: 'fx_convert_currency, ILS before its start',
      tool: fxConvertCurrency,
      input: { base_currency: 'ILS', quote_currency: 'USD', amount: 100, date: '1999-03-01' },
      field: 'base_currency',
      missing: ['ILS'],
      message:
        'Frankfurter v1 returned no observation for base_currency: ILS. ILS (Israeli New Shekel) coverage begins 2000-01-13.',
    },
    {
      name: 'fx_get_timeseries, USD/BRL across 1999',
      tool: fxGetTimeseries,
      input: {
        base_currency: 'USD',
        quote_currency: 'BRL',
        start_date: '1999-01-04',
        end_date: '1999-12-31',
      },
      field: 'quote_currency',
      missing: ['BRL'],
      message:
        'Frankfurter v1 returned no observation for quote_currency: BRL. BRL (Brazilian Real) coverage begins 2000-01-13.',
    },
    {
      name: 'fx_get_rates, symbols BRL and INR in 1999',
      tool: fxGetRates,
      input: { base_currency: 'USD', date: '1999-03-01', symbols: ['INR', 'BRL'] },
      field: 'symbols',
      missing: ['BRL', 'INR'],
      message:
        'Frankfurter v1 returned no observation for symbols: BRL, INR. BRL (Brazilian Real) coverage begins 2000-01-13. INR (Indian Rupee) coverage begins 2000-01-13.',
    },
    {
      name: 'fx_get_rate, ISK inside its gap',
      tool: fxGetRate,
      input: { base_currency: 'USD', quote_currency: 'ISK', date: '2012-06-01' },
      field: 'quote_currency',
      missing: ['ISK'],
      message:
        'Frankfurter v1 returned no observation for quote_currency: ISK. ISK (Icelandic Króna) has no published rate on 2012-06-01, inside its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.',
    },
    {
      name: 'fx_get_rate, ISK on a snapped date, named as requested',
      tool: fxGetRate,
      input: { base_currency: 'USD', quote_currency: 'ISK', date: '2012-06-02' },
      field: 'quote_currency',
      missing: ['ISK'],
      message:
        'Frankfurter v1 returned no observation for quote_currency: ISK. ISK (Icelandic Króna) has no published rate on 2012-06-02, inside its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.',
    },
    {
      name: 'fx_get_rates, symbol ISK on a snapped date, named as requested',
      tool: fxGetRates,
      input: { base_currency: 'USD', date: '2012-06-02', symbols: ['ISK'] },
      field: 'symbols',
      missing: ['ISK'],
      message:
        'Frankfurter v1 returned no observation for symbols: ISK. ISK (Icelandic Króna) has no published rate on 2012-06-02, inside its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.',
    },
    {
      name: 'fx_get_timeseries, an ISK range inside its gap',
      tool: fxGetTimeseries,
      input: {
        base_currency: 'EUR',
        quote_currency: 'ISK',
        start_date: '2012-06-01',
        end_date: '2012-06-30',
      },
      field: 'quote_currency',
      missing: ['ISK'],
      message:
        'Frankfurter v1 returned no observation for quote_currency: ISK. ISK (Icelandic Króna) has no published rate from 2012-06-01 through 2012-06-30, which overlaps its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.',
    },
  ])(
    '$name names the bounds on both surfaces',
    async ({ tool, input, field, missing, message }) => {
      installServed();
      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        message,
        data: {
          reason: 'upstream_no_data',
          field,
          missing_codes: missing,
          currency_windows: missing.map((code) => bounds[code as keyof typeof bounds]),
        },
      });
      expect(textOf(result)).toContain(message);
    },
  );

  it('reads cold metadata once on the miss path, then answers from the warm cache, adding no v1 request', async () => {
    installServed();
    const input = { base_currency: 'USD', quote_currency: 'ISK', date: '2012-06-01' };
    const cold = await runToolContract(fxGetRate, input);
    const warm = await runToolContract(fxGetRate, input);
    expect(errorOf(warm)).toEqual(errorOf(cold));
    expect(errorOf(warm).data).toHaveProperty('currency_windows');
    expect(urls()).toEqual([
      'https://api.frankfurter.dev/v1/2012-06-01?base=EUR',
      'https://api.frankfurter.dev/v1/currencies',
      'https://api.frankfurter.dev/v2/currencies?scope=all&providers=ECB',
      'https://api.frankfurter.dev/v1/2012-06-01?base=EUR',
    ]);
  });

  it('uses metadata a discovery call already cached', async () => {
    installServed();
    await runToolContract(fxListCurrencies, {});
    const result = await runToolContract(fxGetRates, {
      base_currency: 'USD',
      date: '1999-03-01',
      symbols: ['BRL'],
    });
    expect(errorOf(result).data).toMatchObject({ currency_windows: [bounds.BRL] });
    expect(urls().filter((url) => url.includes('/v2/'))).toHaveLength(1);
  });

  it('keeps message and data unchanged when metadata is unavailable', async () => {
    installServed(() => new Response(null, { status: 503 }));
    const result = await runToolContract(fxConvertCurrency, {
      base_currency: 'ILS',
      quote_currency: 'USD',
      amount: 100,
      date: '1999-03-01',
    });
    expect(errorOf(result).message).toBe(
      'Frankfurter v1 returned no observation for base_currency: ILS.',
    );
    expect(errorOf(result).data).not.toHaveProperty('currency_windows');
    expect(textOf(result)).not.toContain('Israeli New Shekel');
    expect(urls().filter((url) => url.includes('/v2/'))).toHaveLength(1);
  });

  it('keeps a latest-path miss unchanged, without reading metadata', async () => {
    installServed();
    const result = await runToolContract(fxGetRates, { base_currency: 'USD', symbols: ['BRL'] });
    expect(errorOf(result)).toMatchObject({
      message: 'Frankfurter v1 returned no observation for symbols: BRL.',
      data: { reason: 'upstream_no_data', field: 'symbols', missing_codes: ['BRL'] },
    });
    expect(errorOf(result).data).not.toHaveProperty('currency_windows');
    expect(urls().filter((url) => url.includes('/v2/'))).toHaveLength(0);
  });

  it('rethrows caller cancellation during the miss-path metadata read', async () => {
    const caller = new AbortController();
    const reason = new Error('caller left during coverage lookup');
    installServed(() => {
      caller.abort(reason);
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      getFrankfurterService().getRate('USD', 'ISK', '2012-06-01', caller.signal),
    ).rejects.toBe(reason);
    expect(urls().filter((url) => url.includes('/v2/'))).toHaveLength(1);
  });
});
