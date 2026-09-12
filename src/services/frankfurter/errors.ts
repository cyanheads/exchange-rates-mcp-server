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

/** The code lists an `unsupported_currency` failure carries on `McpError.data`. */
export interface UnsupportedCurrencyCodes {
  /** The live ECB reference set the request was checked against, sorted. */
  accepted_codes: string[];
  /** The requested codes outside that set. */
  rejected_codes: string[];
}

/**
 * One or more currency codes outside the ECB reference set. Codes are checked
 * against the live currency list before the request, because Frankfurter's 404
 * body carries no field attribution. The accepted set is appended once, however
 * many codes were rejected, so the caller can correct the request without a
 * second call.
 */
export function unsupportedCurrency(
  field: string,
  rejected: string[],
  accepted: string[],
): McpError {
  const rejection =
    rejected.length === 1
      ? `${field} "${rejected[0]}" is not supported by the ECB.`
      : `${field} contains codes not supported by the ECB: ${rejected.join(', ')}.`;
  return validationError(`${rejection} Accepted: ${accepted.join(', ')}.`, {
    accepted_codes: accepted,
    field,
    reason: 'unsupported_currency',
    rejected_codes: rejected,
  });
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

/**
 * Read the rejected and accepted code lists off an `unsupported_currency` failure,
 * for a handler re-raise to forward — `ctx.fail` carries only the data it is given.
 * Returns `undefined` for any error that carries no such lists.
 */
export function unsupportedCurrencyCodesOf(error: unknown): UnsupportedCurrencyCodes | undefined {
  if (!(error instanceof McpError)) return;
  const data = error.data as Partial<UnsupportedCurrencyCodes> | undefined;
  if (!Array.isArray(data?.accepted_codes) || !Array.isArray(data?.rejected_codes)) return;
  return { accepted_codes: data.accepted_codes, rejected_codes: data.rejected_codes };
}
