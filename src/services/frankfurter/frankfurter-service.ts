/**
 * @fileoverview Frankfurter API service — wraps ECB rate data from api.frankfurter.dev.
 * @module services/frankfurter/frankfurter-service
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { invalidDateFormat, unsupportedCurrency, upstreamNoData } from './errors.js';
import type {
  Currency,
  CurrencyMap,
  FrankfurterRateResponse,
  FrankfurterSeriesResponse,
  ResolvedRate,
  SeriesRow,
  TimeSeriesResult,
} from './types.js';

/** ECB data start date. Requests before this return 404 from Frankfurter. */
const ECB_START_DATE = '1999-01-04';

/** YYYY-MM-DD shape guard — calendar validity is checked separately in {@link isIsoDate}. */
const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The ECB reference set changes at most a few times a decade — cache it for a day. */
const CURRENCY_CACHE_TTL_MS = 86_400_000;

/**
 * True when `value` is a real calendar date written as YYYY-MM-DD.
 * Rejects both malformed shapes (`2024-6-1`) and impossible dates (`2024-02-31`).
 */
export function isIsoDate(value: string): boolean {
  if (!DATE_FORMAT_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Boundary guard for date inputs. Throws `invalid_date_format` naming the field at fault. */
function assertDateFormat(date: string, field: string): void {
  if (!isIsoDate(date)) throw invalidDateFormat(field, date);
}

/**
 * A stand-in quote currency for a self-pair, which Frankfurter answers with a 422.
 * Any second currency reveals the days the ECB actually published for the base;
 * EUR is in the reference set for the whole ECB history, so it is the default.
 */
function proxyQuoteFor(base: string): string {
  return base === 'EUR' ? 'USD' : 'EUR';
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
  private currencyCache?: { codes: Set<string>; fetchedAt: number; list: Currency[] };

  constructor() {
    this.baseUrl = getServerConfig().frankfurterBaseUrl;
  }

  // ── Currencies ──────────────────────────────────────────────────────────────

  /** Fetch all supported currencies as a sorted array. Served from the day-long cache. */
  async listCurrencies(): Promise<Currency[]> {
    return (await this.currencies()).list;
  }

  /** The supported currency set, fetched once per {@link CURRENCY_CACHE_TTL_MS}. */
  private async currencies(): Promise<{ codes: Set<string>; list: Currency[] }> {
    const cached = this.currencyCache;
    if (cached && Date.now() - cached.fetchedAt <= CURRENCY_CACHE_TTL_MS) return cached;

    const map = await this.fetchJson<CurrencyMap>('/currencies');
    const list = Object.entries(map)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const fresh = { codes: new Set(list.map((c) => c.code)), fetchedAt: Date.now(), list };
    this.currencyCache = fresh;
    return fresh;
  }

  /**
   * Reject currency codes outside the ECB set before they reach the URL.
   * Frankfurter answers an unknown base and an unknown symbol with the same
   * bodiless 404, so membership is the only way to name the offending input.
   */
  private async assertSupportedCurrencies(field: string, codes: string[]): Promise<void> {
    const { codes: supported } = await this.currencies();
    const unsupported = codes.filter((code) => !supported.has(code));
    if (unsupported.length > 0) throw unsupportedCurrency(field, unsupported);
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
   * A self-pair is 1 by definition and a 422 upstream, so it is quoted against a
   * proxy currency instead — the rate is still local, but its date comes from the
   * day the ECB actually published for the base. That keeps an identity rate's
   * `rateDate` and `dateSnapped` telling the same story as any other pair's, and
   * a date the ECB never published for that currency fails rather than answering
   * with a fabricated publication date.
   *
   * @param base - ISO 4217 base currency code
   * @param quote - ISO 4217 quote currency code
   * @param date - ISO 8601 date string, or 'latest'
   */
  async getRate(base: string, quote: string, date: string): Promise<ResolvedRate> {
    const upper_base = base.toUpperCase();
    const upper_quote = quote.toUpperCase();
    if (date !== 'latest') assertDateFormat(date, 'date');
    await this.assertSupportedCurrencies('base_currency', [upper_base]);
    await this.assertSupportedCurrencies('quote_currency', [upper_quote]);

    const identity = upper_base === upper_quote;
    const quoted = identity ? proxyQuoteFor(upper_base) : upper_quote;

    // Frankfurter supports arbitrary base — it triangulates through EUR internally.
    // Single call: base={upper_base}&symbols={quoted}
    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const params = new URLSearchParams({ base: upper_base, symbols: quoted });
    const url = `${endpoint}?${params}`;

    const raw = await this.fetchJson<FrankfurterRateResponse>(url);
    const quotedRate = raw.rates[quoted];
    if (quotedRate === undefined) throw upstreamNoData(url);
    const rate = identity ? 1 : quotedRate;

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
   *
   * A currency's rate against itself is 1 by definition, and Frankfurter rejects
   * a request whose only symbol is the base (422 "bad currency pair"). The base
   * is therefore stripped from the upstream `symbols` and injected locally.
   */
  async getRates(base: string, date: string, symbols?: string[]): Promise<FrankfurterRateResponse> {
    const upper_base = base.toUpperCase();
    const upper_symbols = symbols?.map((s) => s.toUpperCase()) ?? [];
    if (date !== 'latest') assertDateFormat(date, 'date');
    await this.assertSupportedCurrencies('base_currency', [upper_base]);
    if (upper_symbols.length > 0) await this.assertSupportedCurrencies('symbols', upper_symbols);

    const selfQuoted = upper_symbols.includes(upper_base);
    const upstreamSymbols = upper_symbols.filter((code) => code !== upper_base);

    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const params = new URLSearchParams({ base: upper_base });
    /**
     * When the base was the only symbol requested there is nothing left to ask
     * for, so the filter is dropped — the unfiltered snapshot still carries the
     * publication date the caller needs, and the rates map is rebuilt below.
     */
    if (upstreamSymbols.length > 0) params.set('symbols', upstreamSymbols.join(','));
    const url = `${endpoint}?${params}`;
    const raw = await this.fetchJson<FrankfurterRateResponse>(url);

    if (!selfQuoted) return raw;
    return {
      ...raw,
      rates: upstreamSymbols.length > 0 ? { ...raw.rates, [upper_base]: 1 } : { [upper_base]: 1 },
    };
  }

  // ── Time-series ─────────────────────────────────────────────────────────────

  /**
   * Fetch a historical rate series for a currency pair, clipped to the requested
   * window and suitable for canvas registration.
   *
   * Two upstream behaviours are absorbed here:
   *
   * - A range that opens on a weekend or a TARGET holiday is snapped back to the
   *   prior publication day, so the response can carry dates the caller never
   *   asked for. Those rows are dropped, which leaves an empty series whenever
   *   the window contains no publication day at all.
   * - A self-pair (`base === quote`) is a 422 upstream. It is answered locally
   *   with a rate of 1 on the days the ECB actually published for that currency,
   *   read off a proxy quote rather than a hand-rolled Mon–Fri calendar — the
   *   server has no TARGET holiday table, and per-currency gaps exist too (ISK
   *   was suspended from the reference set for a decade).
   */
  async getTimeSeries(
    base: string,
    quote: string,
    startDate: string,
    endDate: string,
  ): Promise<TimeSeriesResult> {
    const upper_base = base.toUpperCase();
    const upper_quote = quote.toUpperCase();
    assertDateFormat(startDate, 'start_date');
    assertDateFormat(endDate, 'end_date');
    await this.assertSupportedCurrencies('base_currency', [upper_base]);
    await this.assertSupportedCurrencies('quote_currency', [upper_quote]);

    const identity = upper_base === upper_quote;
    const quoted = identity ? proxyQuoteFor(upper_base) : upper_quote;

    const params = new URLSearchParams({ base: upper_base, symbols: quoted });
    const url = `/${encodeURIComponent(startDate)}..${encodeURIComponent(endDate)}?${params}`;
    const raw = await this.fetchJson<FrankfurterSeriesResponse>(url);

    const rows: SeriesRow[] = Object.entries(raw.rates)
      .filter(([date]) => date >= startDate && date <= endDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([date, rateMap]) => {
        /**
         * A day the quoted currency is missing from is not a publication day for
         * this pair — dropping it is the only honest option, since any stand-in
         * number would read as a real ECB rate downstream.
         */
        const quotedRate = rateMap[quoted];
        if (quotedRate === undefined) return [];
        return [
          {
            date,
            rate: identity ? 1 : quotedRate,
            base_currency: upper_base,
            quote_currency: upper_quote,
          },
        ];
      });

    return {
      rows,
      startDate: rows[0]?.date ?? startDate,
      endDate: rows.at(-1)?.date ?? endDate,
    };
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
              'User-Agent': 'exchange-rates-mcp-server/0.1.5',
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
          /**
           * Currency codes are checked against the live ECB set before the request,
           * so a 404 here means the ECB published no rates for the requested date —
           * not an unknown currency. Both this and the 4xx codes from
           * `httpErrorFromResponse` classify as non-transient, so a deterministic
           * input failure is surfaced immediately instead of burning retries.
           */
          if (response.status === 404) throw upstreamNoData(url);
          throw await httpErrorFromResponse(response, { data: { url }, service: 'Frankfurter' });
        }

        return response.json() as Promise<T>;
      },
      { maxRetries: 2, baseDelayMs: 500 },
    );
  }
}

export { ECB_START_DATE };
