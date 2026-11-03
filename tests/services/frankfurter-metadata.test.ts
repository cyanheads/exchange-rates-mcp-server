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
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxListCurrencies } from '@/mcp-server/tools/definitions/fx-list-currencies.tool.js';
import {
  getFrankfurterService,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

let http: FetchMockHarness;
const metadata = [
  { iso_code: 'USD', name: 'Metadata dollar', start_date: '1999-01-04', end_date: '2024-06-03' },
  { iso_code: 'EUR', name: 'Euro', start_date: '1999-01-04', end_date: '2024-06-03' },
  { iso_code: 'RUB', name: 'Russian Ruble', start_date: '1999-01-04', end_date: '2022-03-01' },
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
        { code: 'EUR', start_date: '1999-01-04', end_date: '2024-06-03' },
        { code: 'USD', name: 'US Dollar', end_date: '2024-06-03' },
      ],
    });
    const all = await runToolContract(fxListCurrencies, { include_retired: true });
    expect(all.structuredContent).toMatchObject({
      count: 3,
      currencies: [
        { code: 'EUR' },
        { code: 'RUB', start_date: '1999-01-04', end_date: '2022-03-01' },
        { code: 'USD' },
      ],
    });
    expect(JSON.stringify(all.content)).toContain('2022-03-01');
    expect(http.calls.filter(({ request }) => request.url.includes('/v2/'))).toHaveLength(1);
  });
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
    expect(fxCurrenciesResource.output!.parse(result)).toMatchObject({
      count: 2,
      currencies: [
        { code: 'EUR', start_date: '1999-01-04' },
        { code: 'USD', end_date: '2024-06-03' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('RUB');
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
      notice: expect.stringContaining('unavailable'),
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('start_date');
    expect(JSON.stringify(result.content)).toContain('unavailable');
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
  it('refreshes metadata once per daily cadence, including after an outage', async () => {
    vi.useFakeTimers();
    install({}, 503);
    const service = getFrankfurterService();
    await service.currencyDiscovery();
    await service.currencyDiscovery();
    expect(http.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(86_400_001);
    await service.currencyDiscovery();
    expect(http.calls).toHaveLength(6);
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
    discovery.currencies.find((currency) => currency.code === 'RUB')!.start_date = 'MUTATED';
    const error = (await service
      .getRate('RUB', 'EUR', 'latest')
      .catch((error: unknown) => error)) as {
      data: { currency_windows: Array<{ start_date: string }> };
    };
    expect(error.data.currency_windows[0]!.start_date).toBe('1999-01-04');
    error.data.currency_windows[0]!.start_date = 'MUTATED';
    expect(
      (await service.currencyDiscovery(undefined, true)).currencies.find(
        (currency) => currency.code === 'RUB',
      )!.start_date,
    ).toBe('1999-01-04');
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
