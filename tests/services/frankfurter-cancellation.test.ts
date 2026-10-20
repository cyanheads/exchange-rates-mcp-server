/**
 * @fileoverview Cancellation and retry controls at the real Frankfurter HTTP boundary.
 * @module tests/services/frankfurter-cancellation.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getFrankfurterService,
  resetFrankfurterService,
} from '@/services/frankfurter/frankfurter-service.js';

const currencies = { EUR: 'Euro', USD: 'US Dollar' };
const requests: Request[] = [];

beforeEach(() => {
  resetFrankfurterService();
  requests.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Retain Request objects so native signal propagation cannot be lost to GC. */
function install(respond: (request: Request, attempt: number) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      return respond(request, requests.length);
    }),
  );
}

describe('Frankfurter cancellation', () => {
  it('characterizes sorted cached currencies and three attempts on transient failure', async () => {
    install((_request, attempt) =>
      attempt < 3 ? new Response('busy', { status: 503 }) : Response.json(currencies),
    );
    const service = getFrankfurterService();
    expect(await service.listCurrencies()).toEqual([
      { code: 'EUR', name: 'Euro' },
      { code: 'USD', name: 'US Dollar' },
    ]);
    expect(await service.listCurrencies()).toHaveLength(2);
    expect(requests).toHaveLength(3);
  });

  it('rejects a pre-aborted caller before constructing a request', async () => {
    install(() => Response.json(currencies));
    const reason = new Error('caller left');
    await expect(getFrankfurterService().listCurrencies(AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(requests).toHaveLength(0);
  });

  it.each(['fetch', 'body'] as const)(
    'aborts %s without retry and never caches the aborted load',
    async (phase) => {
      const caller = new AbortController();
      const reason = new Error('caller left');
      install((request, attempt) => {
        if (attempt > 1) return Response.json(currencies);
        if (phase === 'fetch') {
          caller.abort(reason);
          request.signal.throwIfAborted();
          return Response.json(currencies);
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
                once: true,
              });
              stream.enqueue(new TextEncoder().encode('{'));
            },
            pull(stream) {
              caller.abort(reason);
              if (!request.signal.aborted) {
                stream.enqueue(new TextEncoder().encode('}'));
                stream.close();
              }
            },
          }),
        );
      });
      const service = getFrankfurterService();
      await expect(service.listCurrencies(caller.signal)).rejects.toBe(reason);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(await service.listCurrencies()).toHaveLength(2);
      expect(requests).toHaveLength(2);
    },
  );

  it('cancels an armed backoff timer before a second attempt', async () => {
    vi.useFakeTimers();
    install(() => new Response('busy', { status: 503 }));
    const caller = new AbortController();
    const reason = new Error('stop retrying');
    const settled = getFrankfurterService()
      .listCurrencies(caller.signal)
      .then(
        () => 'success',
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    caller.abort(reason);
    await vi.runAllTimersAsync();
    expect(await settled).toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it('does not share an in-flight load between callers or poison the completed cache', async () => {
    const caller = new AbortController();
    const reason = new Error('first caller left');
    install((request, attempt) =>
      attempt === 1
        ? new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          })
        : Response.json(currencies),
    );
    const service = getFrankfurterService();
    const cancelled = service.listCurrencies(caller.signal).catch((error: unknown) => error);
    expect(await service.listCurrencies()).toHaveLength(2);
    caller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(await service.listCurrencies()).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it.each(['rate', 'rates', 'series'] as const)(
    'cancels a retried %s request after the currency lookup completes',
    async (method) => {
      const caller = new AbortController();
      const reason = new Error('cancel later attempt');
      install((request, attempt) => {
        if (attempt === 1) return Response.json(currencies);
        if (attempt === 2) return new Response('busy', { status: 503 });
        caller.abort(reason);
        request.signal.throwIfAborted();
        throw new Error('unreachable');
      });
      const service = getFrankfurterService();
      const call =
        method === 'rate'
          ? service.getRate('USD', 'EUR', 'latest', caller.signal)
          : method === 'rates'
            ? service.getRates('USD', 'latest', ['EUR'], caller.signal)
            : service.getTimeSeries('USD', 'EUR', '2024-06-03', '2024-06-04', caller.signal);
      await expect(call).rejects.toBe(reason);
      expect(requests).toHaveLength(3);
      expect(requests[2]!.signal.aborted).toBe(true);
      expect(await service.listCurrencies()).toHaveLength(2);
      expect(requests).toHaveLength(3);
      await expect(service.listCurrencies(caller.signal)).rejects.toBe(reason);
    },
  );
});
