/**
 * @fileoverview Structured failures for the Frankfurter service. Each constructor
 * stamps a contract `reason` (and the offending input field) onto `McpError.data`
 * so tool handlers classify failures by reading `failureOf()` instead of matching
 * on message prose.
 * @module services/frankfurter/errors
 */

import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { Currency } from './types.js';

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
  /** Known requested codes without an observation in the served data. */
  missing_codes?: string[];
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
  /** The current or historical served currency set the request was checked against, sorted. */
  accepted_codes: string[];
  /** Official outer coverage bounds for rejected historical codes, when available. */
  currency_windows?: Currency[];
  /** The requested codes outside that set. */
  rejected_codes: string[];
}

/**
 * Currency codes outside the current discovery or historical served set.
 * The accepted set is appended once so callers can correct the request directly.
 */
export function unsupportedCurrency(
  field: string,
  rejected: string[],
  accepted: string[],
  windows?: Currency[],
): McpError {
  const rejection =
    rejected.length === 1
      ? `${field} "${rejected[0]}" is not available in this Frankfurter v1 currency set.`
      : `${field} contains codes outside this Frankfurter v1 currency set: ${rejected.join(', ')}.`;
  const guidance = windows?.length
    ? ` Historical coverage (outer bounds, gaps may occur): ${windows.map((currency) => `${currency.code} (${currency.name}): ${currency.start_date} through ${currency.end_date}`).join('; ')}. Request a historical date within these bounds; use fx_list_currencies with include_retired=true for discovery.`
    : '';
  return validationError(`${rejection} Accepted: ${accepted.join(', ')}.${guidance}`, {
    accepted_codes: accepted,
    field,
    reason: 'unsupported_currency',
    rejected_codes: rejected,
    ...(windows?.length && { currency_windows: windows }),
  });
}

/**
 * Frankfurter v1 returned no rates for an otherwise well-formed request — most often a
 * date that predates the requested currency's series (ILS and BRL start well after
 * the 1999-01-04 Frankfurter v1 epoch).
 *
 * The upstream request URL is deliberately absent: `McpError.data` reaches the
 * client as `structuredContent.error.data`, and the URL carries both the caller's
 * inputs and the configured Frankfurter host. The calling tool re-raises with a
 * message naming the pair and dates it asked for, which is the part a caller can act on.
 */
export function upstreamNoData(field?: string, missing?: string[]): McpError {
  const missing_codes = missing && [...new Set(missing)].sort();
  return notFound(
    missing_codes
      ? `Frankfurter v1 returned no observation for ${field}: ${missing_codes.join(', ')}.`
      : 'Frankfurter v1 returned no rates for this request.',
    {
      ...(field && { field }),
      ...(missing_codes && { missing_codes }),
      reason: 'upstream_no_data',
    },
  );
}

/**
 * Read the structured failure off a service-thrown error.
 * Returns `undefined` for anything the service did not classify.
 */
export function failureOf(error: unknown): FrankfurterFailure | undefined {
  if (!(error instanceof McpError)) return;
  const data = error.data as
    | { field?: unknown; reason?: unknown; missing_codes?: unknown }
    | undefined;
  const reason = FAILURE_REASONS.find((known) => known === data?.reason);
  if (reason === undefined) return;
  return {
    ...(typeof data?.field === 'string' ? { field: data.field } : {}),
    ...(Array.isArray(data?.missing_codes) &&
    data.missing_codes.every((code) => typeof code === 'string')
      ? { missing_codes: data.missing_codes as string[] }
      : {}),
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
  return {
    accepted_codes: data.accepted_codes,
    rejected_codes: data.rejected_codes,
    ...(data.currency_windows && { currency_windows: data.currency_windows }),
  };
}
