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
    expect(error.message).toBe(`base_currency "ARS" is not supported by the ECB. ${ACCEPTED_TEXT}`);
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
      `symbols contains codes not supported by the ECB: ARS, VND. ${ACCEPTED_TEXT}`,
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
    expect(unsupportedCurrencyCodesOf(upstreamNoData('/latest?base=USD'))).toBeUndefined();
    expect(unsupportedCurrencyCodesOf(new Error('boom'))).toBeUndefined();
  });

  it('classifies an upstream gap as upstream_no_data with no field blamed', () => {
    const error = upstreamNoData('/2000-01-04?base=ILS');

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(failureOf(error)).toEqual({ reason: 'upstream_no_data' });
  });

  it('returns undefined for errors the service did not classify', () => {
    expect(failureOf(new Error('not found: something'))).toBeUndefined();
    expect(failureOf(undefined)).toBeUndefined();
  });
});
