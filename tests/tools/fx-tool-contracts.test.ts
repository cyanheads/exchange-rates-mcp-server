/**
 * @fileoverview End-to-end contract conformance for the rate tools, driven through the
 * framework's `toolContractSuite`. Unlike the per-tool handler tests, this runs the
 * production pipeline — input parse, handler, output parse, `format()`, enrichment —
 * so a success lands on BOTH consumption paths (`structuredContent` and `content[]`)
 * and a failure produces the dual-surface error envelope with its declared reason.
 * @module tests/tools/fx-tool-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { unsupportedCurrency } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { FrankfurterRateResponse, ResolvedRate } from '@/services/frankfurter/types.js';

const mockGetRate = vi.fn<(...args: unknown[]) => Promise<ResolvedRate>>();
const mockGetRates = vi.fn<(...args: unknown[]) => Promise<FrankfurterRateResponse>>();
const mockGetTimeSeries = vi.fn();

vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRate: mockGetRate,
  getRates: mockGetRates,
  getTimeSeries: mockGetTimeSeries,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

/** A trimmed live ECB set; `XYZ` and `ARS` stand in for codes outside it. */
const ACCEPTED = ['EUR', 'GBP', 'JPY', 'USD'];
const ACCEPTED_TEXT = 'Accepted: EUR, GBP, JPY, USD.';

const snappedRate: ResolvedRate = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: 0.92149,
  rateDate: '2024-05-31',
  dateSnapped: true,
  rateType: 'ECB reference (mid-market)',
  source: 'ECB via Frankfurter',
};

/** Reject a pair the way the service does: base checked first, then quote. */
const rejectUnsupportedPair = (base: unknown, quote: unknown): Error | undefined => {
  if (!ACCEPTED.includes(String(base).toUpperCase())) {
    return unsupportedCurrency('base_currency', [String(base).toUpperCase()], ACCEPTED);
  }
  if (!ACCEPTED.includes(String(quote).toUpperCase())) {
    return unsupportedCurrency('quote_currency', [String(quote).toUpperCase()], ACCEPTED);
  }
  return;
};

beforeEach(() => {
  mockGetRate.mockImplementation(async (base, quote) => {
    const rejection = rejectUnsupportedPair(base, quote);
    if (rejection) throw rejection;
    return snappedRate;
  });
  mockGetRates.mockImplementation(async (base, date, symbols) => {
    const rejection = rejectUnsupportedPair(base, 'EUR');
    if (rejection) throw rejection;
    const unsupported = ((symbols as string[] | undefined) ?? []).filter(
      (code) => !ACCEPTED.includes(code),
    );
    if (unsupported.length > 0) throw unsupportedCurrency('symbols', unsupported, ACCEPTED);
    return {
      amount: 1,
      base: 'USD',
      date: date === '2024-06-01' ? '2024-05-31' : '2024-06-04',
      rates: { EUR: 0.92, GBP: 0.79 },
    };
  });
  mockGetTimeSeries.mockImplementation(async (base, quote) => {
    const rejection = rejectUnsupportedPair(base, quote);
    if (rejection) throw rejection;
    return {
      rows: [
        { date: '2024-06-03', rate: 0.91, base_currency: 'USD', quote_currency: 'EUR' },
        { date: '2024-06-04', rate: 0.92, base_currency: 'USD', quote_currency: 'EUR' },
      ],
      startDate: '2024-06-03',
      endDate: '2024-06-04',
    };
  });
});

toolContractSuite(fxGetRate, {
  success: [
    {
      name: 'carries the snapped rate date on both surfaces',
      input: { base_currency: 'usd', quote_currency: 'eur', date: '2024-06-01' },
      expected: { rate: 0.92149, rate_date: '2024-05-31', date_snapped: true },
      assert: (result) => {
        const text = (result.content[0] as { text: string }).text;
        /** The snap warning is the one fact a content[]-only client would otherwise lose. */
        expect(text).toContain('2024-05-31');
        expect(text).toContain('snapped');
        expect(text).toContain('ECB reference (mid-market)');
      },
    },
  ],
  errors: [
    {
      name: 'names the offending currency field',
      input: { base_currency: 'USD', quote_currency: 'XYZ' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'unsupported_currency',
    },
    {
      name: 'refuses a date before the ECB epoch',
      input: { base_currency: 'USD', quote_currency: 'EUR', date: '1998-12-31' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'date_out_of_range',
    },
    {
      name: 'refuses a date that is not a real calendar day',
      input: { base_currency: 'USD', quote_currency: 'EUR', date: '2024-02-31' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_date_format',
    },
  ],
});

toolContractSuite(fxGetRates, {
  success: [
    {
      name: 'reports an unsnapped latest snapshot on both surfaces',
      input: { base_currency: 'USD' },
      expected: { rate_date: '2024-06-04', rates: { EUR: 0.92, GBP: 0.79 }, date_snapped: false },
      assert: (result) => {
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('**EUR**: 0.92');
        expect(text).toContain('ECB reference (mid-market)');
        expect(text).not.toContain('snapped');
      },
    },
    {
      name: 'carries the snapped snapshot date on both surfaces',
      input: { base_currency: 'USD', date: '2024-06-01' },
      expected: { rate_date: '2024-05-31', date_snapped: true },
      assert: (result) => {
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('Requested date snapped to 2024-05-31');
      },
    },
  ],
  errors: [
    {
      name: 'blames symbols for an unsupported symbol',
      input: { base_currency: 'USD', symbols: ['XYZ'] },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'unsupported_currency',
    },
  ],
});

toolContractSuite(fxConvertCurrency, {
  success: [
    {
      name: 'renders the converted amount alongside the rate that produced it',
      input: { base_currency: 'USD', quote_currency: 'EUR', amount: 100 },
      expected: { base_amount: 100, quote_amount: 92.149, rate: 0.92149 },
      assert: (result) => {
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('92.149');
        expect(text).toContain('100 USD');
      },
    },
  ],
  errors: [
    {
      name: 'refuses a future date',
      input: { base_currency: 'USD', quote_currency: 'EUR', amount: 1, date: '2999-01-01' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'date_out_of_range',
    },
  ],
});

toolContractSuite(fxGetTimeseries, {
  success: [
    {
      name: 'returns an inline series inside the requested window',
      input: {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2024-06-03',
        end_date: '2024-06-04',
      },
      expected: {
        rate_count: 2,
        spilled: false,
        start_date: '2024-06-03',
        end_date: '2024-06-04',
      },
      assert: (result) => {
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('2024-06-03: 0.91');
        expect(text).toContain('2024-06-04: 0.92');
        expect(text).toContain('spilled: false');
      },
    },
  ],
  errors: [
    {
      name: 'refuses a reversed range',
      input: {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: '2024-06-05',
        end_date: '2024-06-03',
      },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_range',
    },
  ],
});

/**
 * The accepted set is lost at the handler re-raise, not in the service, so it is
 * asserted on the wire envelope the production pipeline builds — both surfaces.
 */
describe('unsupported_currency wire envelope', () => {
  const window = { start_date: '2024-06-03', end_date: '2024-06-04' };

  const cases = [
    {
      name: 'fx_get_rate',
      tool: fxGetRate,
      input: { base_currency: 'ARS', quote_currency: 'USD' },
      field: 'base_currency',
      rejected: ['ARS'],
    },
    {
      name: 'fx_get_rate',
      tool: fxGetRate,
      input: { base_currency: 'USD', quote_currency: 'ARS' },
      field: 'quote_currency',
      rejected: ['ARS'],
    },
    {
      name: 'fx_convert_currency',
      tool: fxConvertCurrency,
      input: { base_currency: 'ARS', quote_currency: 'USD', amount: 100 },
      field: 'base_currency',
      rejected: ['ARS'],
    },
    {
      name: 'fx_convert_currency',
      tool: fxConvertCurrency,
      input: { base_currency: 'USD', quote_currency: 'ARS', amount: 100 },
      field: 'quote_currency',
      rejected: ['ARS'],
    },
    {
      name: 'fx_get_rates',
      tool: fxGetRates,
      input: { base_currency: 'ARS' },
      field: 'base_currency',
      rejected: ['ARS'],
    },
    {
      name: 'fx_get_rates',
      tool: fxGetRates,
      input: { base_currency: 'USD', symbols: ['ARS', 'EUR', 'XYZ'] },
      field: 'symbols',
      rejected: ['ARS', 'XYZ'],
    },
    {
      name: 'fx_get_timeseries',
      tool: fxGetTimeseries,
      input: { base_currency: 'ARS', quote_currency: 'USD', ...window },
      field: 'base_currency',
      rejected: ['ARS'],
    },
    {
      name: 'fx_get_timeseries',
      tool: fxGetTimeseries,
      input: { base_currency: 'USD', quote_currency: 'ARS', ...window },
      field: 'quote_currency',
      rejected: ['ARS'],
    },
  ];

  it.each(cases)(
    '$name forwards rejected and accepted codes blaming $field',
    async ({ tool, input, field, rejected }) => {
      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      const error = (
        result.structuredContent as {
          error: { code: number; data: Record<string, unknown>; message: string };
        }
      ).error;
      const text = (result.content[0] as { text: string }).text;

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        accepted_codes: ACCEPTED,
        field,
        reason: 'unsupported_currency',
        recovery: { hint: expect.stringContaining('fx_list_currencies') },
        rejected_codes: rejected,
      });
      expect(error.message.startsWith(`${field} `)).toBe(true);
      expect(error.message.endsWith(ACCEPTED_TEXT)).toBe(true);
      expect(error.message.split('Accepted:')).toHaveLength(2);
      expect(text).toContain(ACCEPTED_TEXT);
      expect(text.split('Accepted:')).toHaveLength(2);
    },
  );
});
