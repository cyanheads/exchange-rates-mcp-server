/**
 * @fileoverview End-to-end contract conformance for the rate tools, driven through the
 * framework's `toolContractSuite`. Unlike the per-tool handler tests, this runs the
 * production pipeline — input parse, handler, output parse, `format()`, enrichment —
 * so a success lands on BOTH consumption paths (`structuredContent` and `content[]`)
 * and a failure produces the dual-surface error envelope with its declared reason.
 * @module tests/tools/fx-tool-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, expect, vi } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { unsupportedCurrency } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { ResolvedRate } from '@/services/frankfurter/types.js';

const mockGetRate = vi.fn<(...args: unknown[]) => Promise<ResolvedRate>>();
const mockGetTimeSeries = vi.fn();

vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRate: mockGetRate,
  getTimeSeries: mockGetTimeSeries,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

const snappedRate: ResolvedRate = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: 0.92149,
  rateDate: '2024-05-31',
  dateSnapped: true,
  rateType: 'ECB reference (mid-market)',
  source: 'ECB via Frankfurter',
};

beforeEach(() => {
  mockGetRate.mockImplementation(async (_base, quote) =>
    quote === 'XYZ' ? Promise.reject(unsupportedCurrency('quote_currency', ['XYZ'])) : snappedRate,
  );
  mockGetTimeSeries.mockResolvedValue({
    rows: [
      { date: '2024-06-03', rate: 0.91, base_currency: 'USD', quote_currency: 'EUR' },
      { date: '2024-06-04', rate: 0.92, base_currency: 'USD', quote_currency: 'EUR' },
    ],
    startDate: '2024-06-03',
    endDate: '2024-06-04',
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
