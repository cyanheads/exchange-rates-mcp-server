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
  upstreamNoData,
} from '@/services/frankfurter/errors.js';

describe('frankfurter failures', () => {
  it('classifies a malformed date as invalid_date_format, naming the field', () => {
    const error = invalidDateFormat('start_date', '2024-6-1');

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toContain('start_date');
    expect(error.message).toContain('2024-6-1');
    expect(failureOf(error)).toEqual({ field: 'start_date', reason: 'invalid_date_format' });
  });

  it('names the single unsupported currency code and its field', () => {
    const error = unsupportedCurrency('symbols', ['XYZ']);

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe('symbols "XYZ" is not supported by the ECB.');
    expect(failureOf(error)).toEqual({ field: 'symbols', reason: 'unsupported_currency' });
  });

  it('names every unsupported code when several are bad', () => {
    expect(unsupportedCurrency('symbols', ['XYZ', 'ABC']).message).toBe(
      'symbols contains codes not supported by the ECB: XYZ, ABC.',
    );
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
