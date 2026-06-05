/**
 * @fileoverview Type definitions for the Frankfurter API service.
 * @module services/frankfurter/types
 */

/** Map of ISO 4217 currency code → full name. */
export interface CurrencyMap {
  [code: string]: string;
}

/** A single currency with code and name. */
export interface Currency {
  code: string;
  name: string;
}

/** Raw API response from GET /latest or GET /{date}. */
export interface FrankfurterRateResponse {
  amount: number;
  base: string;
  date: string;
  rates: { [code: string]: number };
}

/** Raw API response from GET /{start}..{end} (time series). */
export interface FrankfurterSeriesResponse {
  amount: number;
  base: string;
  end_date: string;
  rates: { [date: string]: { [code: string]: number } };
  start_date: string;
}

/** A resolved exchange rate with provenance. */
export interface ResolvedRate {
  /** The base currency code. */
  baseCurrency: string;
  /** True when the API snapped the requested date to a prior business day. */
  dateSnapped: boolean;
  /** The quote currency code. */
  quoteCurrency: string;
  /** The exchange rate (how many quote units per 1 base). */
  rate: number;
  /** The actual date of the rate (may differ from requested on weekends/holidays). */
  rateDate: string;
  /** Human-readable rate type caveat. */
  rateType: 'ECB reference (mid-market)';
  /** Data source attribution. */
  source: 'ECB via Frankfurter';
}

/** A time-series row for canvas registration. Must satisfy `Record<string, unknown>` for spillover. */
export interface SeriesRow extends Record<string, unknown> {
  base_currency: string;
  date: string;
  quote_currency: string;
  rate: number;
}
