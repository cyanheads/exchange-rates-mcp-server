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
  end_date?: string;
  name: string;
  /** Official ECB metadata outer bounds, not a guarantee against interior gaps. */
  start_date?: string;
}

/** An official ECB metadata row: both outer bounds present, never a guarantee against interior gaps. */
export type CoverageWindow = Required<Currency>;

/** A currency discovery row. `Currency` stays the shape of `currency_windows` on errors. */
export interface DiscoveredCurrency extends Currency {
  /** True only for a code absent from current v1 discovery; v1 membership decides it, not `end_date`. */
  retired: boolean;
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
  /**
   * True when `rateDate` differs from the requested date: a weekend, a holiday, or a
   * same-day request before that day's fix is published. Always false for `latest`.
   */
  dateSnapped: boolean;
  /** The quote currency code. */
  quoteCurrency: string;
  /** The exchange rate (how many quote units per 1 base). */
  rate: number;
  /** The served publication date: the prior published date when none was published for the requested one. */
  rateDate: string;
  /** Human-readable rate type caveat. */
  rateType: 'Daily rate (Frankfurter v1)';
  /** Data source attribution. */
  source: 'Frankfurter v1';
}

/** A time-series row for canvas registration. Must satisfy `Record<string, unknown>` for spillover. */
export interface SeriesRow extends Record<string, unknown> {
  base_currency: string;
  date: string;
  quote_currency: string;
  rate: number;
}

/**
 * A time series clipped to the caller's requested window. Frankfurter's own
 * `start_date`/`end_date` echo the window it *served*, which opens earlier than
 * the requested one whenever the range starts on a non-publication day. These
 * bounds never fall outside what the caller asked for.
 */
export interface TimeSeriesResult {
  /** Last publication date inside the requested window; the requested end when there is none. */
  endDate: string;
  /** Clipped served dates missing either leg; not non-publication calendar dates. */
  missingCoverage?: { count: number; firstDate: string; lastDate: string };
  /** Publication days inside the requested window, ascending by date. May be empty. */
  rows: SeriesRow[];
  /** First publication date inside the requested window; the requested start when there is none. */
  startDate: string;
}
