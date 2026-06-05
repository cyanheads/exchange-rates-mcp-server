/**
 * @fileoverview Frankfurter API service — wraps ECB rate data from api.frankfurter.dev.
 * @module services/frankfurter/frankfurter-service
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  Currency,
  CurrencyMap,
  FrankfurterRateResponse,
  FrankfurterSeriesResponse,
  ResolvedRate,
  SeriesRow,
} from './types.js';

/** ECB data start date. Requests before this return 404 from Frankfurter. */
const ECB_START_DATE = '1999-01-04';

/** YYYY-MM-DD format guard. */
const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 4217 currency code guard: 1-4 uppercase letters (covers standard 3-letter codes + rare 4-letter ones). */
const CURRENCY_CODE_RE = /^[A-Za-z]{1,4}$/;

/** Validate a date string is YYYY-MM-DD. Throws on bad format. */
function assertDateFormat(date: string, label: string): void {
  if (!DATE_FORMAT_RE.test(date)) {
    throw new Error(`not found: ${label} "${date}" is not a valid YYYY-MM-DD date`);
  }
}

/** Validate a currency code is safe to embed in a URL. Throws on bad format. */
function assertCurrencyFormat(code: string, label: string): void {
  if (!CURRENCY_CODE_RE.test(code)) {
    throw new Error(`not found: ${label} "${code}" is not a valid ISO 4217 currency code`);
  }
}

let _service: FrankfurterService | undefined;

/** Retrieve the singleton FrankfurterService (lazy-init). */
export function getFrankfurterService(): FrankfurterService {
  _service ??= new FrankfurterService();
  return _service;
}

/** @internal — exposed for testing only */
export function resetFrankfurterService(): void {
  _service = undefined;
}

class FrankfurterService {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = getServerConfig().frankfurterBaseUrl;
  }

  // ── Currencies ──────────────────────────────────────────────────────────────

  /** Fetch all supported currencies as a sorted array. */
  async listCurrencies(): Promise<Currency[]> {
    const map = await this.fetchJson<CurrencyMap>('/currencies');
    return Object.entries(map)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  // ── Rate (point-in-time) ────────────────────────────────────────────────────

  /**
   * Get the exchange rate for a currency pair on a given date.
   * Handles cross-rate triangulation through EUR automatically.
   *
   * Frankfurter's base must be EUR for ECB data — but it also supports
   * arbitrary base via its own math. We just set base={upper_base} and
   * symbols={upper_quote} and let Frankfurter handle the triangulation.
   *
   * @param base - ISO 4217 base currency code
   * @param quote - ISO 4217 quote currency code
   * @param date - ISO 8601 date string, or 'latest'
   */
  async getRate(base: string, quote: string, date: string): Promise<ResolvedRate> {
    const upper_base = base.toUpperCase();
    const upper_quote = quote.toUpperCase();
    assertCurrencyFormat(upper_base, 'base_currency');
    assertCurrencyFormat(upper_quote, 'quote_currency');
    if (date !== 'latest') assertDateFormat(date, 'date');

    if (upper_base === upper_quote) {
      // Identity rate — no API call needed
      const today = new Date().toISOString().slice(0, 10);
      return {
        baseCurrency: upper_base,
        quoteCurrency: upper_quote,
        rate: 1,
        rateDate: date === 'latest' ? today : date,
        dateSnapped: false,
        rateType: 'ECB reference (mid-market)',
        source: 'ECB via Frankfurter',
      };
    }

    // Frankfurter supports arbitrary base — it triangulates through EUR internally.
    // Single call: base={upper_base}&symbols={upper_quote}
    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const params = new URLSearchParams({ base: upper_base, symbols: upper_quote });
    const url = `${endpoint}?${params}`;

    const raw = await this.fetchJson<FrankfurterRateResponse>(url);
    const rate = raw.rates[upper_quote];
    if (rate === undefined) {
      throw new Error(`not found: ${upper_quote} not in response rates`);
    }

    const dateSnapped = date !== 'latest' && raw.date !== date;

    return {
      baseCurrency: upper_base,
      quoteCurrency: upper_quote,
      rate,
      rateDate: raw.date,
      dateSnapped,
      rateType: 'ECB reference (mid-market)',
      source: 'ECB via Frankfurter',
    };
  }

  // ── Bulk rates snapshot ─────────────────────────────────────────────────────

  /**
   * Fetch all rates for a base currency at latest or historical date.
   * Optionally filter to a specific set of symbols.
   */
  getRates(base: string, date: string, symbols?: string[]): Promise<FrankfurterRateResponse> {
    const upper_base = base.toUpperCase();
    assertCurrencyFormat(upper_base, 'base_currency');
    if (date !== 'latest') assertDateFormat(date, 'date');
    if (symbols) {
      for (const sym of symbols) assertCurrencyFormat(sym.toUpperCase(), 'symbol');
    }
    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const params = new URLSearchParams({ base: upper_base });
    if (symbols && symbols.length > 0)
      params.set('symbols', symbols.map((s) => s.toUpperCase()).join(','));
    const url = `${endpoint}?${params}`;
    return this.fetchJson<FrankfurterRateResponse>(url);
  }

  // ── Time-series ─────────────────────────────────────────────────────────────

  /**
   * Fetch a historical rate series for a currency pair.
   * Returns raw API response plus derived rows suitable for canvas registration.
   */
  async getTimeSeries(
    base: string,
    quote: string,
    startDate: string,
    endDate: string,
  ): Promise<{ raw: FrankfurterSeriesResponse; rows: SeriesRow[] }> {
    const upper_base = base.toUpperCase();
    const upper_quote = quote.toUpperCase();
    assertCurrencyFormat(upper_base, 'base_currency');
    assertCurrencyFormat(upper_quote, 'quote_currency');
    assertDateFormat(startDate, 'start_date');
    assertDateFormat(endDate, 'end_date');

    const params = new URLSearchParams({ base: upper_base, symbols: upper_quote });
    const url = `/${encodeURIComponent(startDate)}..${encodeURIComponent(endDate)}?${params}`;
    const raw = await this.fetchJson<FrankfurterSeriesResponse>(url);

    const rows: SeriesRow[] = Object.entries(raw.rates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rateMap]) => ({
        date,
        rate: rateMap[upper_quote] ?? 0,
        base_currency: upper_base,
        quote_currency: upper_quote,
      }));

    return { raw, rows };
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private fetchJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetch(url, {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'exchange-rates-mcp-server/0.1.1',
            },
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          throw serviceUnavailable(
            `Frankfurter API unreachable: ${(err as Error).message}`,
            { url },
            { cause: err as Error },
          );
        }

        if (!response.ok) {
          if (response.status === 404) {
            const body = await response.text().catch(() => '');
            throw new Error(`not found: ${body || 'date out of range or unknown currency'}`);
          }
          throw serviceUnavailable(`Frankfurter API error ${response.status}`, {
            url,
            status: response.status,
          });
        }

        return response.json() as Promise<T>;
      },
      { maxRetries: 2, baseDelayMs: 500 },
    );
  }
}

export { ECB_START_DATE };
