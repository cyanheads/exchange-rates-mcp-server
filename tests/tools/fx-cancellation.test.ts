/**
 * @fileoverview Every service-backed handler cancels actual upstream work.
 * @module tests/tools/fx-cancellation.test
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fxCurrenciesResource } from '@/mcp-server/resources/definitions/fx-currencies.resource.js';
import { fxRatesLatestResource } from '@/mcp-server/resources/definitions/fx-rates-latest.resource.js';
import {
  fxConvertCurrency,
  fxGetRate,
  fxGetRates,
  fxGetTimeseries,
  fxListCurrencies,
} from '@/mcp-server/tools/definitions/index.js';
import { unsupportedCurrency } from '@/services/frankfurter/errors.js';
import { resetFrankfurterService } from '@/services/frankfurter/frankfurter-service.js';

beforeEach(resetFrankfurterService);
afterEach(() => vi.unstubAllGlobals());

const pair = { base_currency: 'USD', quote_currency: 'EUR' };
const cases = [
  {
    name: 'fx_list_currencies',
    call: (signal: AbortSignal) => fxListCurrencies.handler({}, createMockContext({ signal })),
  },
  {
    name: 'fx_get_rate',
    call: (signal: AbortSignal) =>
      fxGetRate.handler(pair, createMockContext({ signal, errors: fxGetRate.errors })),
  },
  {
    name: 'fx_get_rates',
    call: (signal: AbortSignal) =>
      fxGetRates.handler(
        { base_currency: 'USD' },
        createMockContext({ signal, errors: fxGetRates.errors }),
      ),
  },
  {
    name: 'fx_convert_currency',
    call: (signal: AbortSignal) =>
      fxConvertCurrency.handler(
        { ...pair, amount: 100 },
        createMockContext({ signal, errors: fxConvertCurrency.errors }),
      ),
  },
  {
    name: 'fx_get_timeseries',
    call: (signal: AbortSignal) =>
      fxGetTimeseries.handler(
        { ...pair, start_date: '2024-06-03', end_date: '2024-06-04' },
        createMockContext({ signal, errors: fxGetTimeseries.errors }),
      ),
  },
  {
    name: 'fx://currencies',
    call: (signal: AbortSignal) => fxCurrenciesResource.handler({}, createMockContext({ signal })),
  },
  {
    name: 'fx://rates/latest/{base}',
    call: (signal: AbortSignal) =>
      fxRatesLatestResource.handler({ base: 'USD' }, createMockContext({ signal })),
  },
];

it.each(cases)(
  '$name passes the caller signal to the active upstream request',
  async ({ call }) => {
    const caller = new AbortController();
    const reason = new Error('caller left');
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const request = new Request(url, init);
        requests.push(request);
        caller.abort(reason);
        request.signal.throwIfAborted();
        return Response.json(
          url.endsWith('/currencies')
            ? { USD: 'Dollar', EUR: 'Euro' }
            : {
                base: 'USD',
                date: '2024-06-03',
                rates: { EUR: 0.9 },
              },
        );
      }),
    );
    await expect(call(caller.signal)).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
  },
);

it.each(cases)(
  '$name preserves cancellation identity even when its reason resembles a domain failure',
  async ({ call }) => {
    const caller = new AbortController();
    const reason = unsupportedCurrency('base_currency', ['ARS'], ['USD', 'EUR']);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        caller.abort(reason);
        init.signal!.throwIfAborted();
        throw new Error('unreachable');
      }),
    );
    await expect(call(caller.signal)).rejects.toBe(reason);
  },
);
