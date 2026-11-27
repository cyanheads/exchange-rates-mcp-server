/**
 * @fileoverview End-to-end contract conformance for the rate tools, driven through the
 * framework's `toolContractSuite`. Unlike the per-tool handler tests, this runs the
 * production pipeline — input parse, handler, output parse, `format()`, enrichment —
 * so a success lands on BOTH consumption paths (`structuredContent` and `content[]`)
 * and a failure produces the dual-surface error envelope with its declared reason.
 * @module tests/tools/fx-tool-contracts.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { unsupportedCurrency, upstreamNoData } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';
import type { FrankfurterRateResponse, ResolvedRate } from '@/services/frankfurter/types.js';

const mockGetRate = vi.fn<(...args: unknown[]) => Promise<ResolvedRate>>();
const mockGetRates = vi.fn<(...args: unknown[]) => Promise<FrankfurterRateResponse>>();
const mockGetTimeSeries = vi.fn();

describe('currency input aliases', () => {
  const window = { start_date: '2024-06-03', end_date: '2024-06-04' };
  it.each([
    {
      tool: fxGetRate,
      extra: {},
      aliases: [
        ['from', 'to'],
        ['from_currency', 'to_currency'],
        ['base', 'symbol'],
      ],
    },
    {
      tool: fxConvertCurrency,
      extra: { amount: 100 },
      aliases: [
        ['from', 'to'],
        ['from_currency', 'to_currency'],
      ],
    },
    {
      tool: fxGetTimeseries,
      extra: window,
      aliases: [
        ['from_currency', 'to_currency'],
        ['base', 'symbol'],
      ],
    },
  ])(
    '$tool.name accepts direction aliases without advertising them',
    async ({ tool, extra, aliases }) => {
      const canonical = await runToolContract(tool as typeof fxGetRate, {
        base_currency: 'usd',
        quote_currency: 'eur',
        ...extra,
      });
      expect(canonical.isError).toBeFalsy();
      const properties = z.toJSONSchema(tool.input).properties!;
      for (const [baseKey, quoteKey] of aliases) {
        const fields = { [baseKey!]: 'usd', [quoteKey!]: 'eur', ...extra };
        const response = await runToolContract(tool as typeof fxGetRate, fields as never);
        expect(response.structuredContent).toEqual(canonical.structuredContent);
        expect(response.content).toEqual(canonical.content);
        for (const [key, canonicalKey] of [
          [baseKey!, 'base_currency'],
          [quoteKey!, 'quote_currency'],
        ] as const) {
          expect(properties).not.toHaveProperty(key);
          const collision = await runToolContract(
            tool as typeof fxGetRate,
            { ...fields, [canonicalKey]: 'JPY' } as never,
          );
          expect(collision.isError).toBe(true);
          expect(JSON.stringify(collision.content)).toContain('send one of them, not both');
          expect(JSON.stringify(collision.structuredContent)).toContain(
            'send one of them, not both',
          );
        }
      }
    },
  );
  it.each([
    { tool: fxGetTimeseries, extra: window, fields: { from: 'USD', to: 'EUR' } },
    { tool: fxGetRate, extra: {}, fields: { base: 'USD', symbols: ['EUR'] } },
    { tool: fxConvertCurrency, extra: { amount: 100 }, fields: { base: 'USD', symbol: 'EUR' } },
    { tool: fxGetRate, extra: {}, fields: { from: 'USD', from_currency: 'JPY', to: 'EUR' } },
  ])(
    '$tool.name rejects ambiguous or unsupported spellings $fields',
    async ({ tool, extra, fields }) => {
      const result = await runToolContract(
        tool as typeof fxGetRate,
        { ...extra, ...fields } as never,
      );
      expect(result.isError).toBe(true);
    },
  );

  const cases = [
    { tool: fxGetRate, extra: {}, pair: true, mock: mockGetRate },
    { tool: fxConvertCurrency, extra: { amount: 100 }, pair: true, mock: mockGetRate },
    { tool: fxGetRates, extra: {}, pair: false, mock: mockGetRates },
    {
      tool: fxGetTimeseries,
      extra: { start_date: '2024-06-03', end_date: '2024-06-04' },
      pair: true,
      mock: mockGetTimeSeries,
    },
  ];

  it.each(cases)(
    '$tool.name characterizes canonical fields and rejects unknown keys',
    async ({ tool, extra, pair }) => {
      const input = { base_currency: 'usd', ...(pair && { quote_currency: 'eur' }), ...extra };
      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ base_currency: 'USD' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('USD') });
      expect(
        (await runToolContract(tool as typeof fxGetRate, { ...input, unknown_key: 'USD' } as never))
          .isError,
      ).toBe(true);
      const properties = z.toJSONSchema(tool.input).properties!;
      expect(properties).toHaveProperty('base_currency');
      expect(properties).not.toHaveProperty('base');
      expect(properties).not.toHaveProperty('quote');
    },
  );

  it.each(cases)(
    '$tool.name accepts aliases unchanged and rejects canonical collisions on both surfaces',
    async ({ tool, extra, pair, mock }) => {
      mock.mockClear();
      const input = { base: 'usd', ...(pair && { quote: 'eur' }), ...extra };
      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      expect(result.isError).toBeFalsy();
      expect(mock.mock.calls[0]?.[0]).toBe('usd');
      if (pair) expect(mock.mock.calls[0]?.[1]).toBe('eur');
      expect(result.structuredContent).toMatchObject({ base_currency: 'USD' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('USD') });
      for (const canonical of ['base_currency', ...(pair ? ['quote_currency'] : [])]) {
        const collision = await runToolContract(
          tool as typeof fxGetRate,
          {
            ...input,
            [canonical]: 'GBP',
          } as never,
        );
        expect(collision.isError).toBe(true);
        expect(JSON.stringify(collision.structuredContent)).toContain('send one of them, not both');
        expect(JSON.stringify(collision.content)).toContain('send one of them, not both');
      }
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );
});

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
  rateType: 'Daily rate (Frankfurter v1)',
  source: 'Frankfurter v1',
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
        expect(text).toContain('Daily rate (Frankfurter v1)');
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
        expect(text).toContain('Daily rate (Frankfurter v1)');
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
 * A range past one inline page, run through the production pipeline so the page bound,
 * its continuation, and the notice are asserted on the surfaces a client actually reads.
 */
describe('fx_get_timeseries paginated inline wire result', () => {
  it('carries the same bounded page and continuation on structuredContent and content[]', async () => {
    const rows = Array.from({ length: 620 }, (_, i) => ({
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      rate: 0.9,
      base_currency: 'USD',
      quote_currency: 'EUR',
    }));
    mockGetTimeSeries.mockImplementationOnce(async () => ({
      rows,
      startDate: rows[0]!.date,
      endDate: rows.at(-1)!.date,
    }));

    const result = await runToolContract(fxGetTimeseries, {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: rows[0]!.date,
      end_date: rows.at(-1)!.date,
    });
    const structured = result.structuredContent as {
      rates: Record<string, number>;
      rate_count: number;
      truncated: boolean;
      next_start_date?: string;
      notice?: string;
      spilled: boolean;
    };
    const text = result.content.map((block) => (block as { text: string }).text).join('\n');
    const renderedDates = text.match(/^\d{4}-\d{2}-\d{2}(?=: )/gm) ?? [];

    expect(result.isError).toBeFalsy();
    expect(structured.spilled).toBe(false);
    expect(structured.rate_count).toBe(620);
    expect(structured.truncated).toBe(true);
    expect(structured.next_start_date).toBe(rows[500]!.date);
    expect(Object.keys(structured.rates)).toEqual(renderedDates);
    expect(renderedDates).toHaveLength(500);
    expect(text).toContain(`next_start_date: ${rows[500]!.date}`);
    expect(structured.notice).toContain(`start_date=${rows[500]!.date}`);
    expect(text).toContain(`start_date=${rows[500]!.date}`);
    expect(text).not.toContain('fx_dataframe');
  });
});

/**
 * A snap has three causes — weekend, holiday, or a same-day request before the fix is
 * published — so no wording on the point tools may assert one of them.
 */
describe('date snap wording', () => {
  const note =
    "⚠️ *Requested date snapped to 2024-05-31: no rate was published for the requested date (weekend, holiday, or the day's fix not yet released)*";
  it.each([
    { tool: fxGetRate, input: { base_currency: 'USD', quote_currency: 'EUR', date: '2024-06-01' } },
    { tool: fxGetRates, input: { base_currency: 'USD', date: '2024-06-01' } },
    {
      tool: fxConvertCurrency,
      input: { base_currency: 'USD', quote_currency: 'EUR', amount: 100, date: '2024-06-01' },
    },
  ])('$tool.name names every snap cause without asserting one', async ({ tool, input }) => {
    expect(tool.output.shape.date_snapped.description).toBe(
      'True when Frankfurter v1 served a prior publication date because the requested daily fix was unavailable. False for fixed-only and latest results.',
    );
    const surface = JSON.stringify([
      tool.description,
      z.toJSONSchema(tool.input),
      z.toJSONSchema(tool.output),
    ]);
    expect(surface).not.toContain('weekend/holiday');
    expect(surface).not.toContain('weekends/holidays');

    const result = await runToolContract(tool as typeof fxGetRate, input as never);
    expect(result.structuredContent).toMatchObject({ rate_date: '2024-05-31', date_snapped: true });
    expect((result.content[0] as { text: string }).text.split('\n')).toContain(note);
  });
});

/**
 * Coverage bounds ride the handler re-raise: `ctx.fail` carries only the data it is
 * given, so each tool must forward `currency_windows` with the service's message.
 */
describe('upstream_no_data wire envelope', () => {
  const ILS = {
    code: 'ILS',
    name: 'Israeli New Shekel',
    start_date: '2000-01-13',
    end_date: '2026-11-13',
  };
  const coverage = (start: string, end = start) => ({ requested: { start, end }, windows: [ILS] });
  const pointRecovery =
    "Request a date inside the currency's coverage bounds (currency_windows, or fx_list_currencies); bounds can contain gaps, so widen the range with fx_get_timeseries to find observed dates.";
  const cases = [
    {
      tool: fxGetRate,
      mock: mockGetRate,
      input: { base_currency: 'ILS', quote_currency: 'USD', date: '1999-03-01' },
      field: 'base_currency',
      requested: coverage('1999-03-01'),
      recovery: pointRecovery,
    },
    {
      tool: fxConvertCurrency,
      mock: mockGetRate,
      input: { base_currency: 'ILS', quote_currency: 'USD', amount: 100, date: '1999-03-01' },
      field: 'base_currency',
      requested: coverage('1999-03-01'),
      recovery: pointRecovery,
    },
    {
      tool: fxGetRates,
      mock: mockGetRates,
      input: { base_currency: 'USD', date: '1999-03-01', symbols: ['ILS'] },
      field: 'symbols',
      requested: coverage('1999-03-01'),
      recovery: pointRecovery,
    },
    {
      tool: fxGetTimeseries,
      mock: mockGetTimeSeries,
      input: {
        base_currency: 'USD',
        quote_currency: 'ILS',
        start_date: '1999-01-04',
        end_date: '1999-12-31',
      },
      field: 'quote_currency',
      requested: coverage('1999-01-04', '1999-12-31'),
      recovery:
        "Request a range inside the currency's coverage bounds (currency_windows, or fx_list_currencies); bounds can contain gaps, so widen the range to find observed dates.",
    },
  ];

  it.each(cases)(
    '$tool.name forwards currency_windows and the bounds sentence blaming $field',
    async ({ tool, mock, input, field, requested, recovery }) => {
      (mock as typeof mockGetTimeSeries).mockRejectedValueOnce(
        upstreamNoData(field, ['ILS'], requested),
      );
      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      const error = (
        result.structuredContent as {
          error: { code: number; data: Record<string, unknown>; message: string };
        }
      ).error;
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      const message = `Frankfurter v1 returned no observation for ${field}: ILS. ILS (Israeli New Shekel) coverage begins 2000-01-13.`;

      expect(result.isError).toBe(true);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message,
        data: {
          reason: 'upstream_no_data',
          field,
          missing_codes: ['ILS'],
          currency_windows: [ILS],
          recovery: { hint: recovery },
        },
      });
      expect(text).toContain(message);
      expect(text).toContain(recovery);
    },
  );

  it.each(cases)(
    '$tool.name adds no currency_windows when the service supplied none',
    async ({ tool, mock, input, field }) => {
      (mock as typeof mockGetTimeSeries).mockRejectedValueOnce(upstreamNoData(field, ['ILS']));
      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      const error = (
        result.structuredContent as { error: { data: Record<string, unknown>; message: string } }
      ).error;
      expect(error.message).toBe(`Frankfurter v1 returned no observation for ${field}: ILS.`);
      expect(error.data).not.toHaveProperty('currency_windows');
    },
  );
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
      } as never);
      expect(error.message.startsWith(`${field} `)).toBe(true);
      expect(error.message.endsWith(ACCEPTED_TEXT)).toBe(true);
      expect(error.message.split('Accepted:')).toHaveLength(2);
      expect(text).toContain(ACCEPTED_TEXT);
      expect(text.split('Accepted:')).toHaveLength(2);
    },
  );
});
