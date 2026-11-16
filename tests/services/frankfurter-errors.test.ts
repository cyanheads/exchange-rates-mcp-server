/**
 * @fileoverview Tests for the Frankfurter service's structured failures — the
 * contract reasons handlers classify on instead of matching message prose.
 * @module tests/services/frankfurter-errors.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  failureOf,
  invalidDateFormat,
  unsupportedCurrency,
  unsupportedCurrencyCodesOf,
  upstreamNoData,
} from '@/services/frankfurter/errors.js';

/** The live ECB reference set as `/currencies` returns it — 30 codes, sorted. */
const ACCEPTED = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'ZAR',
];
const ACCEPTED_TEXT = `Accepted: ${ACCEPTED.join(', ')}.`;

describe('frankfurter failures', () => {
  it('classifies a malformed date as invalid_date_format, naming the field', () => {
    const error = invalidDateFormat('start_date', '2024-6-1');

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toContain('start_date');
    expect(error.message).toContain('2024-6-1');
    expect(failureOf(error)).toEqual({ field: 'start_date', reason: 'invalid_date_format' });
  });

  it('names the single unsupported code and its field, then lists the accepted set', () => {
    const error = unsupportedCurrency('base_currency', ['ARS'], ACCEPTED);

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(
      `base_currency "ARS" is not available in this Frankfurter v1 currency set. ${ACCEPTED_TEXT}`,
    );
    expect(error.data).toEqual({
      accepted_codes: ACCEPTED,
      field: 'base_currency',
      reason: 'unsupported_currency',
      rejected_codes: ['ARS'],
    });
  });

  it('names every unsupported code when several are bad, listing the accepted set once', () => {
    const error = unsupportedCurrency('symbols', ['ARS', 'VND'], ACCEPTED);

    expect(error.message).toBe(
      `symbols contains codes outside this Frankfurter v1 currency set: ARS, VND. ${ACCEPTED_TEXT}`,
    );
    expect(error.message.split('Accepted:')).toHaveLength(2);
    expect(error.data).toMatchObject({ accepted_codes: ACCEPTED, rejected_codes: ['ARS', 'VND'] });
  });

  it('keeps failureOf to field and reason, leaving the code lists to their own reader', () => {
    const error = unsupportedCurrency('symbols', ['ARS'], ACCEPTED);

    expect(failureOf(error)).toEqual({ field: 'symbols', reason: 'unsupported_currency' });
    expect(unsupportedCurrencyCodesOf(error)).toEqual({
      accepted_codes: ACCEPTED,
      rejected_codes: ['ARS'],
    });
  });

  it('reads no code lists off a failure that carries none', () => {
    expect(unsupportedCurrencyCodesOf(upstreamNoData())).toBeUndefined();
    expect(unsupportedCurrencyCodesOf(new Error('boom'))).toBeUndefined();
  });

  it('classifies an upstream gap as upstream_no_data with no field blamed', () => {
    const error = upstreamNoData();

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(failureOf(error)).toEqual({ reason: 'upstream_no_data' });
  });

  it('preserves sorted deduplicated missing observations through the typed reader', () => {
    const error = upstreamNoData('symbols', ['JPY', 'ISK', 'ISK']);
    expect(failureOf(error)).toEqual({
      reason: 'upstream_no_data',
      field: 'symbols',
      missing_codes: ['ISK', 'JPY'],
    });
    expect(error.message).toContain('symbols: ISK, JPY');
    expect(unsupportedCurrencyCodesOf(error)).toBeUndefined();
  });

  describe('coverage bounds on a dated miss', () => {
    const ILS = {
      code: 'ILS',
      name: 'Israeli New Shekel',
      start_date: '2000-01-13',
      end_date: '2026-11-13',
    };
    const ISK = {
      code: 'ISK',
      name: 'Icelandic Króna',
      start_date: '1999-01-04',
      end_date: '2026-11-13',
    };
    /** Official bounds that close before today, for the `coverage ends` form. */
    const HRK = {
      code: 'HRK',
      name: 'Croatian Kuna',
      start_date: '2000-01-13',
      end_date: '2022-12-30',
    };
    const BASE = 'Frankfurter v1 returned no observation for';

    it.each([
      [
        'a date before start_date',
        { start: '1999-03-01', end: '1999-03-01' },
        ILS,
        'ILS (Israeli New Shekel) coverage begins 2000-01-13.',
      ],
      [
        'a range ending before start_date',
        { start: '1999-01-04', end: '2000-01-12' },
        ILS,
        'ILS (Israeli New Shekel) coverage begins 2000-01-13.',
      ],
      [
        'a date after end_date',
        { start: '2023-01-02', end: '2023-01-02' },
        HRK,
        'HRK (Croatian Kuna) coverage ends 2022-12-30.',
      ],
      [
        'a range starting after end_date',
        { start: '2023-01-02', end: '2023-01-31' },
        HRK,
        'HRK (Croatian Kuna) coverage ends 2022-12-30.',
      ],
      [
        'one date inside the bounds',
        { start: '2012-06-01', end: '2012-06-01' },
        ISK,
        'ISK (Icelandic Króna) has no published rate on 2012-06-01, inside its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.',
      ],
      [
        'a range inside the bounds',
        { start: '2012-06-01', end: '2012-06-30' },
        ISK,
        'ISK (Icelandic Króna) has no published rate from 2012-06-01 through 2012-06-30, which overlaps its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.',
      ],
      [
        'a range straddling start_date',
        { start: '1999-12-01', end: '2000-01-31' },
        ILS,
        'ILS (Israeli New Shekel) has no published rate from 1999-12-01 through 2000-01-31, which overlaps its 2000-01-13 through 2026-11-13 coverage bounds; bounds can contain gaps.',
      ],
      [
        'a range straddling end_date',
        { start: '2022-12-01', end: '2023-01-31' },
        HRK,
        'HRK (Croatian Kuna) has no published rate from 2022-12-01 through 2023-01-31, which overlaps its 2000-01-13 through 2022-12-30 coverage bounds; bounds can contain gaps.',
      ],
      [
        'a date on start_date',
        { start: '2000-01-13', end: '2000-01-13' },
        ILS,
        'ILS (Israeli New Shekel) has no published rate on 2000-01-13, inside its 2000-01-13 through 2026-11-13 coverage bounds; bounds can contain gaps.',
      ],
      [
        'a date on end_date',
        { start: '2022-12-30', end: '2022-12-30' },
        HRK,
        'HRK (Croatian Kuna) has no published rate on 2022-12-30, inside its 2000-01-13 through 2022-12-30 coverage bounds; bounds can contain gaps.',
      ],
    ])('names the bounds for %s', (_case, requested, window, sentence) => {
      const error = upstreamNoData('quote_currency', [window.code], {
        requested,
        windows: [HRK, ILS, ISK],
      });
      expect(error.message).toBe(`${BASE} quote_currency: ${window.code}. ${sentence}`);
      expect(error.data).toEqual({
        field: 'quote_currency',
        missing_codes: [window.code],
        reason: 'upstream_no_data',
        currency_windows: [window],
      });
      expect(failureOf(error)).toEqual({
        field: 'quote_currency',
        missing_codes: [window.code],
        reason: 'upstream_no_data',
        currency_windows: [window],
      });
    });

    it('gives several missing codes one sentence each, in code order, skipping codes without bounds', () => {
      const error = upstreamNoData('symbols', ['JPY', 'ISK', 'ILS'], {
        requested: { start: '1999-03-01', end: '1999-03-01' },
        windows: [ISK, ILS],
      });
      expect(error.message).toBe(
        `${BASE} symbols: ILS, ISK, JPY. ILS (Israeli New Shekel) coverage begins 2000-01-13. ISK (Icelandic Króna) has no published rate on 1999-03-01, inside its 1999-01-04 through 2026-11-13 coverage bounds; bounds can contain gaps.`,
      );
      expect(error.data).toMatchObject({ currency_windows: [ILS, ISK] });
    });

    it.each([
      ['no coverage context', undefined],
      [
        'no window for the code',
        { requested: { start: '1999-03-01', end: '1999-03-01' }, windows: [ISK] },
      ],
    ])('leaves message and data unchanged with %s', (_case, coverage) => {
      const error = upstreamNoData('base_currency', ['ILS'], coverage);
      expect(error.message).toBe(`${BASE} base_currency: ILS.`);
      expect(error.data).toEqual({
        field: 'base_currency',
        missing_codes: ['ILS'],
        reason: 'upstream_no_data',
      });
      expect(failureOf(error)).not.toHaveProperty('currency_windows');
    });
  });

  /**
   * `McpError.data` reaches the client as `structuredContent.error.data`, so the
   * upstream request URL — which carries the caller's codes and dates alongside
   * whatever host `FRANKFURTER_BASE_URL` names — must not be on it.
   */
  it('carries the reason alone, never the upstream request URL', () => {
    expect(upstreamNoData().data).toEqual({ reason: 'upstream_no_data' });
  });

  it('returns undefined for errors the service did not classify', () => {
    expect(failureOf(new Error('not found: something'))).toBeUndefined();
    expect(failureOf(undefined)).toBeUndefined();
  });
});
