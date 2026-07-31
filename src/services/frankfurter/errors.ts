/**
 * @fileoverview Structured failures for the Frankfurter service. Each constructor
 * stamps a contract `reason` (and the offending input field) onto `McpError.data`
 * so tool handlers classify failures by reading `failureOf()` instead of matching
 * on message prose.
 * @module services/frankfurter/errors
 */

import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Contract reasons the Frankfurter service attaches to the errors it throws.
 * Every calling tool declares the subset it can surface in its `errors[]`.
 */
const FAILURE_REASONS = [
  'invalid_date_format',
  'unsupported_currency',
  'upstream_no_data',
] as const;

export type FrankfurterFailureReason = (typeof FAILURE_REASONS)[number];

/** Structured failure payload carried on `McpError.data`. */
export interface FrankfurterFailure {
  /** The input at fault, named as the calling tool exposes it (e.g. `start_date`, `symbols`). */
  field?: string;
  /** Contract reason — mirrors the `errors[]` entry the calling tool declares. */
  reason: FrankfurterFailureReason;
}

/** A date input that is not a real YYYY-MM-DD calendar date. */
export function invalidDateFormat(field: string, value: string): McpError {
  return validationError(`${field} "${value}" is not a valid YYYY-MM-DD calendar date.`, {
    field,
    reason: 'invalid_date_format',
    value,
  });
}

/**
 * One or more currency codes outside the ECB reference set. Codes are checked
 * against the live currency list before the request, because Frankfurter's 404
 * body carries no field attribution.
 */
export function unsupportedCurrency(field: string, codes: string[]): McpError {
  const message =
    codes.length === 1
      ? `${field} "${codes[0]}" is not supported by the ECB.`
      : `${field} contains codes not supported by the ECB: ${codes.join(', ')}.`;
  return validationError(message, { codes, field, reason: 'unsupported_currency' });
}

/**
 * The ECB published no rates for an otherwise well-formed request — most often a
 * date that predates the requested currency's series (ILS and BRL start well after
 * the 1999-01-04 ECB epoch).
 */
export function upstreamNoData(url: string): McpError {
  return notFound('The ECB published no rates for this request.', {
    reason: 'upstream_no_data',
    url,
  });
}

/**
 * Read the structured failure off a service-thrown error.
 * Returns `undefined` for anything the service did not classify.
 */
export function failureOf(error: unknown): FrankfurterFailure | undefined {
  if (!(error instanceof McpError)) return;
  const data = error.data as { field?: unknown; reason?: unknown } | undefined;
  const reason = FAILURE_REASONS.find((known) => known === data?.reason);
  if (reason === undefined) return;
  return {
    ...(typeof data?.field === 'string' ? { field: data.field } : {}),
    reason,
  };
}
