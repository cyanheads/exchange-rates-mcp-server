/**
 * @fileoverview Frankfurter API service — wraps Frankfurter v1 rate data from api.frankfurter.dev.
 * @module services/frankfurter/frankfurter-service
 */

import { config } from '@cyanheads/mcp-ts-core/config';
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

/** Frankfurter v1 data start date. Requests before this return 404 from Frankfurter. */
const ECB_START_DATE = '1999-01-04';

/** YYYY-MM-DD shape guard — calendar validity is checked separately in {@link isIsoDate}. */
const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The Frankfurter v1 reference set changes at most a few times a decade — cache it for a day. */
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
  /**
   * Polite identifier sent on every Frankfurter request. The version comes from the
   * framework's resolved config — sourced from package.json — so it cannot drift from
   * the released version the way a hardcoded string does.
   */
  private readonly userAgent: string;
  private currencyCache?: { codes: Set<string>; fetchedAt: number; list: Currency[] };

  constructor() {
    this.baseUrl = getServerConfig().frankfurterBaseUrl;
    this.userAgent = `exchange-rates-mcp-server/${config.mcpServerVersion}`;
  }

  // ── Currencies ──────────────────────────────────────────────────────────────

  /** Fetch all supported currencies as a sorted array. Served from the day-long cache. */
  async listCurrencies(signal?: AbortSignal): Promise<Currency[]> {
    return (await this.currencies(signal)).list.map((currency) => ({ ...currency }));
  }

  /** Current discovery with the latest served rate date, cached independently of historical data. */
  async currencyDiscovery(
    signal?: AbortSignal,
  ): Promise<{ currencies: Currency[]; as_of: string }> {
    const currencies = await this.listCurrencies(signal);
    signal?.throwIfAborted();
    const cached = this.discoveryDateCache;
    if (cached && Date.now() - cached.fetchedAt <= CURRENCY_CACHE_TTL_MS) {
      return { currencies, as_of: cached.date };
    }
    const raw = await this.fetchJson<FrankfurterRateResponse>('/latest?base=EUR', signal);
    signal?.throwIfAborted();
    this.discoveryDateCache = { date: raw.date, fetchedAt: Date.now() };
    return { currencies, as_of: raw.date };
  }

  private discoveryDateCache?: { date: string; fetchedAt: number };

  /** The supported currency set, fetched once per {@link CURRENCY_CACHE_TTL_MS}. */
  private async currencies(
    signal?: AbortSignal,
  ): Promise<{ codes: Set<string>; list: Currency[] }> {
    signal?.throwIfAborted();
    const cached = this.currencyCache;
    if (cached && Date.now() - cached.fetchedAt <= CURRENCY_CACHE_TTL_MS) return cached;

    const map = await this.fetchJson<CurrencyMap>('/currencies', signal);
    signal?.throwIfAborted();
    const list = Object.entries(map)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const fresh = { codes: new Set(list.map((c) => c.code)), fetchedAt: Date.now(), list };
    this.currencyCache = fresh;
    return fresh;
  }

  /**
   * Reject currency codes outside the Frankfurter v1 set before they reach the URL.
   * Frankfurter answers an unknown base and an unknown symbol with the same
   * bodiless 404, so membership is the only way to name the offending input.
   * The rejection lists the sorted live set it was checked against.
   */
  private async assertSupportedCurrencies(
    field: string,
    codes: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const { codes: supported, list } = await this.currencies(signal);
    const unsupported = [...new Set(codes.filter((code) => !supported.has(code)))].sort();
    if (unsupported.length > 0) {
      throw unsupportedCurrency(
        field,
        unsupported,
        list.map((currency) => currency.code),
      );
    }
  }

  /** Historical membership is the union of raw served dates, including snapped dates before clipping. */
  private async assertHistoricalCurrencies(
    fields: Array<[string, string[]]>,
    available: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const accepted = [...available].sort();
    const absent = fields.map(
      ([field, codes]) => [field, codes.filter((code) => !available.has(code))] as const,
    );
    if (absent.every(([, codes]) => codes.length === 0)) return;
    const current = await this.currencies(signal);
    for (const [field, missing] of absent) {
      const unknown = [...new Set(missing.filter((code) => !current.codes.has(code)))].sort();
      if (unknown.length > 0) throw unsupportedCurrency(field, unknown, accepted);
    }
    throw upstreamNoData();
  }

  // ── Rate (point-in-time) ────────────────────────────────────────────────────

  /**
   * Derive a pair from one unfiltered EUR snapshot. Both legs must exist on the
   * served date; EUR is 1. Historical membership comes from that same snapshot,
   * and identity pairs retain actual publication dates and missing-data failures.
   */
  async getRate(
    base: string,
    quote: string,
    date: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRate> {
    const upper_base = base.trim().toUpperCase();
    const upper_quote = quote.trim().toUpperCase();
    if (date !== 'latest') assertDateFormat(date, 'date');
    if (date === 'latest') {
      await this.assertSupportedCurrencies('base_currency', [upper_base], signal);
      await this.assertSupportedCurrencies('quote_currency', [upper_quote], signal);
    }
    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const raw = await this.fetchJson<FrankfurterRateResponse>(`${endpoint}?base=EUR`, signal);
    if (date !== 'latest') {
      await this.assertHistoricalCurrencies(
        [
          ['base_currency', [upper_base]],
          ['quote_currency', [upper_quote]],
        ],
        new Set(['EUR', ...Object.keys(raw.rates)]),
        signal,
      );
    }
    const baseLeg = upper_base === 'EUR' ? 1 : raw.rates[upper_base];
    const quoteLeg = upper_quote === 'EUR' ? 1 : raw.rates[upper_quote];
    if (baseLeg === undefined || quoteLeg === undefined) throw upstreamNoData();
    const rate = quoteLeg / baseLeg;

    const dateSnapped = date !== 'latest' && raw.date !== date;

    return {
      baseCurrency: upper_base,
      quoteCurrency: upper_quote,
      rate,
      rateDate: raw.date,
      dateSnapped,
      rateType: 'Daily rate (Frankfurter v1)',
      source: 'Frankfurter v1',
    };
  }

  // ── Bulk rates snapshot ─────────────────────────────────────────────────────

  /**
   * Fetch all rates for a base currency at latest or historical date.
   * Optionally filter to a specific set of symbols.
   *
   * Rates are derived locally from the unfiltered EUR snapshot and filtered only
   * after membership validation. The base appears only when explicitly requested.
   */
  async getRates(
    base: string,
    date: string,
    symbols?: string[],
    signal?: AbortSignal,
  ): Promise<FrankfurterRateResponse> {
    const upper_base = base.trim().toUpperCase();
    const upper_symbols = symbols?.map((s) => s.trim().toUpperCase()) ?? [];
    if (date !== 'latest') assertDateFormat(date, 'date');
    if (date === 'latest') {
      await this.assertSupportedCurrencies('base_currency', [upper_base], signal);
      if (upper_symbols.length > 0)
        await this.assertSupportedCurrencies('symbols', upper_symbols, signal);
    }
    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const raw = await this.fetchJson<FrankfurterRateResponse>(`${endpoint}?base=EUR`, signal);
    if (date !== 'latest') {
      await this.assertHistoricalCurrencies(
        [
          ['base_currency', [upper_base]],
          ['symbols', upper_symbols],
        ],
        new Set(['EUR', ...Object.keys(raw.rates)]),
        signal,
      );
    }
    const baseLeg = upper_base === 'EUR' ? 1 : raw.rates[upper_base];
    if (baseLeg === undefined) throw upstreamNoData();
    const requested =
      upper_symbols.length > 0
        ? upper_symbols
        : ['EUR', ...Object.keys(raw.rates)].filter((code) => code !== upper_base);
    const rates = Object.create(null) as Record<string, number>;
    for (const code of requested) {
      const leg = code === 'EUR' ? 1 : raw.rates[code];
      if (leg === undefined) throw upstreamNoData();
      rates[code] = leg / baseLeg;
    }
    return {
      ...raw,
      base: upper_base,
      rates,
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
   * - Each row requires both EUR legs on that same served date. An identity pair
   *   is 1 only when its currency is observed, rather than on a synthetic calendar.
   */
  async getTimeSeries(
    base: string,
    quote: string,
    startDate: string,
    endDate: string,
    signal?: AbortSignal,
  ): Promise<TimeSeriesResult> {
    const upper_base = base.trim().toUpperCase();
    const upper_quote = quote.trim().toUpperCase();
    assertDateFormat(startDate, 'start_date');
    assertDateFormat(endDate, 'end_date');
    const url = `/${encodeURIComponent(startDate)}..${encodeURIComponent(endDate)}?base=EUR`;
    const raw = await this.fetchJson<FrankfurterSeriesResponse>(url, signal);
    const available = new Set<string>();
    for (const rates of Object.values(raw.rates)) {
      available.add('EUR');
      for (const code of Object.keys(rates)) available.add(code);
    }
    await this.assertHistoricalCurrencies(
      [
        ['base_currency', [upper_base]],
        ['quote_currency', [upper_quote]],
      ],
      available,
      signal,
    );

    const rows: SeriesRow[] = Object.entries(raw.rates)
      .filter(([date]) => date >= startDate && date <= endDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([date, rateMap]) => {
        /**
         * A day the quoted currency is missing from is not a publication day for
         * this pair — dropping it is the only honest option, since any stand-in
         * number would read as a real Frankfurter v1 rate downstream.
         */
        const baseLeg = upper_base === 'EUR' ? 1 : rateMap[upper_base];
        const quoteLeg = upper_quote === 'EUR' ? 1 : rateMap[upper_quote];
        if (baseLeg === undefined || quoteLeg === undefined) return [];
        return [
          {
            date,
            rate: quoteLeg / baseLeg,
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

  private fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(
      async ({ signal: attemptSignal }) => {
        attemptSignal.throwIfAborted();
        const requestSignal = AbortSignal.any([attemptSignal, AbortSignal.timeout(10_000)]);
        let response: Response;
        try {
          response = await fetch(url, {
            headers: {
              Accept: 'application/json',
              'User-Agent': this.userAgent,
            },
            signal: requestSignal,
          });
        } catch (err) {
          signal?.throwIfAborted();
          /**
           * `error.data` is forwarded to the client as `structuredContent.error.data`,
           * and the request URL carries the caller's codes and dates plus whatever host
           * `FRANKFURTER_BASE_URL` points at — so nothing thrown here puts it on the wire.
           * The cause keeps the underlying fetch failure reachable server-side.
           */
          throw serviceUnavailable(
            `Frankfurter API unreachable: ${(err as Error).message}`,
            undefined,
            {
              cause: err as Error,
            },
          );
        }

        if (!response.ok) {
          /**
           * This unfiltered EUR request returning 404 means no served data for
           * the requested interval. Both this and the 4xx codes from
           * `httpErrorFromResponse` classify as non-transient, so a deterministic
           * input failure is surfaced immediately instead of burning retries.
           */
          if (response.status === 404) throw upstreamNoData();
          throw await httpErrorFromResponse(response, { service: 'Frankfurter' });
        }

        const body = (await response.json()) as T;
        signal?.throwIfAborted();
        return body;
      },
      { maxRetries: 2, baseDelayMs: 500, ...(signal && { signal }) },
    );
  }
}

export { ECB_START_DATE };
