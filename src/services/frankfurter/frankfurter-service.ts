/**
 * @fileoverview Frankfurter API service — wraps Frankfurter v1 rate data from api.frankfurter.dev.
 * @module services/frankfurter/frankfurter-service
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, OFFICIAL_FRANKFURTER_BASE_URL } from '@/config/server-config.js';
import { fetchCurrencyMetadata } from './currency-metadata.js';
import {
  type CoverageContext,
  failureOf,
  invalidDateFormat,
  unsupportedCurrency,
  upstreamNoData,
} from './errors.js';
import {
  MARKET_PROVENANCE,
  type StatutoryRate,
  statutoryEuroRates,
  statutoryProvenance,
  statutoryRate,
} from './statutory-euro-rates.js';
import type {
  CoverageWindow,
  Currency,
  CurrencyMap,
  DiscoveredCurrency,
  FrankfurterRateResponse,
  FrankfurterSeriesResponse,
  ResolvedRate,
  ResolvedSnapshot,
  SeriesRow,
  TimeSeriesResult,
} from './types.js';

/** Frankfurter v1 data start date. Requests before this return 404 from Frankfurter. */
const ECB_START_DATE = '1999-01-04';
const MS_PER_DAY = 86_400_000;

/** YYYY-MM-DD shape guard — calendar validity is checked separately in {@link isIsoDate}. */
const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The Frankfurter v1 reference set changes at most a few times a decade — cache it for a day. */
const CURRENCY_CACHE_TTL_MS = 86_400_000;

/**
 * A failed coverage-metadata read is retried after five minutes, not a day: one transient
 * timeout would otherwise hide retired flags and coverage windows until the next daily
 * refresh, while the wait still bounds requests to the optional endpoint during an outage.
 */
const METADATA_FAILURE_TTL_MS = 300_000;

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

function fixedRatesFor(codes: string[], date: string, enabled: boolean) {
  const factors = new Map<string, StatutoryRate>();
  if (enabled) {
    for (const code of new Set(codes)) {
      const factor = statutoryRate(code, date);
      if (factor) factors.set(code, factor);
    }
  }
  return factors;
}

function fixedOnly(codes: string[], factors: ReadonlyMap<string, StatutoryRate>): boolean {
  return factors.size > 0 && codes.every((code) => code === 'EUR' || factors.has(code));
}

/** The v1 epoch only limits requests requiring a v1 observation. */
export function supportedBeforeV1(date: string, base: string, quotes: string[]): boolean {
  if (quotes.length === 0) return false;
  const codes = [base, ...quotes].map((code) => code.trim().toUpperCase());
  return fixedOnly(
    codes,
    fixedRatesFor(
      codes,
      date,
      getServerConfig().frankfurterBaseUrl === OFFICIAL_FRANKFURTER_BASE_URL,
    ),
  );
}

function eurLeg(
  code: string,
  rates: FrankfurterRateResponse['rates'],
  fixed: ReadonlyMap<string, StatutoryRate>,
) {
  return code === 'EUR' ? 1 : (fixed.get(code)?.units_per_eur ?? rates[code]);
}

function dateOffset(date: string, days: number): string {
  return new Date(Date.parse(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
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
  private metadataCache?: { fetchedAt: number; currencies: CoverageWindow[] | undefined };

  constructor() {
    this.baseUrl = getServerConfig().frankfurterBaseUrl;
    this.userAgent = `exchange-rates-mcp-server/${config.mcpServerVersion}`;
  }

  // ── Currencies ──────────────────────────────────────────────────────────────

  /** Fetch all supported currencies as a sorted array. Served from the day-long cache. */
  async listCurrencies(signal?: AbortSignal): Promise<Currency[]> {
    return (await this.currencies(signal)).list.map((currency) => ({ ...currency }));
  }

  /**
   * Current discovery dated `as_of`, the latest served rate date. Each call reads
   * `/latest?base=EUR` uncached — the request a latest-rate call makes — so `as_of`
   * matches the `rate_date` a latest-rate call returns at the same moment; a failed
   * read fails discovery rather than reporting an earlier date. The currency list and
   * coverage metadata keep their day-long caches.
   */
  async currencyDiscovery(
    signal?: AbortSignal,
    includeRetired = false,
  ): Promise<{ currencies: DiscoveredCurrency[]; as_of: string; notice?: string }> {
    const current = await this.listCurrencies(signal);
    signal?.throwIfAborted();
    const { date: as_of } = await this.fetchJson<FrankfurterRateResponse>(
      '/latest?base=EUR',
      signal,
    );
    const metadata = await this.currencyMetadata(signal);
    const bounds = new Map(metadata?.map((currency) => [currency.code, currency]));
    const currencies: DiscoveredCurrency[] = current.map((currency) => {
      const coverage = bounds.get(currency.code);
      return {
        ...currency,
        ...(coverage && { start_date: coverage.start_date, end_date: coverage.end_date }),
        retired: false,
      };
    });
    if (includeRetired) {
      const currentCodes = new Set(current.map((currency) => currency.code));
      for (const currency of metadata ?? []) {
        if (!currentCodes.has(currency.code)) currencies.push({ ...currency, retired: true });
      }
      if (this.baseUrl === OFFICIAL_FRANKFURTER_BASE_URL) {
        const byCode = new Map(currencies.map((currency) => [currency.code, currency]));
        for (const { code, name, adoption_date, units_per_eur } of statutoryEuroRates.values()) {
          const currency = byCode.get(code);
          if (currency) {
            Object.assign(currency, { adoption_date, units_per_eur });
          } else {
            currencies.push({ code, name, retired: true, adoption_date, units_per_eur });
          }
        }
      }
      currencies.sort((a, b) => a.code.localeCompare(b.code));
    }
    const unavailable = metadata === undefined;
    return {
      currencies,
      as_of,
      ...(unavailable && {
        notice:
          includeRetired && this.baseUrl === OFFICIAL_FRANKFURTER_BASE_URL
            ? 'Optional official ECB coverage metadata is unavailable; current v1 discovery and statutory euro rates are preserved, but coverage dates and other retired currencies cannot be supplied.'
            : 'Optional official ECB coverage metadata is unavailable; current v1 discovery is preserved, but coverage dates and additional retired currencies cannot be supplied.',
      }),
    };
  }

  /** Never query official metadata for a custom v1 source, nor share a caller's cancellation. */
  private async currencyMetadata(signal?: AbortSignal): Promise<CoverageWindow[] | undefined> {
    signal?.throwIfAborted();
    if (this.baseUrl !== OFFICIAL_FRANKFURTER_BASE_URL) return;
    const cached = this.metadataCache;
    const ttlMs = cached?.currencies ? CURRENCY_CACHE_TTL_MS : METADATA_FAILURE_TTL_MS;
    if (cached && Date.now() - cached.fetchedAt <= ttlMs)
      return cached.currencies?.map((currency) => ({ ...currency }));
    const currencies = await fetchCurrencyMetadata(this.userAgent, signal);
    signal?.throwIfAborted();
    this.metadataCache = { currencies, fetchedAt: Date.now() };
    return currencies?.map((currency) => ({ ...currency }));
  }

  /** Coverage adds recovery context only; it never changes membership or the original diagnosis. */
  private async currencyRejection(
    field: string,
    rejected: string[],
    accepted: string[],
    signal?: AbortSignal,
  ) {
    const metadata = await this.currencyMetadata(signal);
    const windows = metadata?.filter((currency) => rejected.includes(currency.code));
    return unsupportedCurrency(field, rejected, accepted, windows);
  }

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
      throw await this.currencyRejection(
        field,
        unsupported,
        list.map((currency) => currency.code),
        signal,
      );
    }
  }

  /**
   * Historical membership is the union of raw served dates, including snapped dates before
   * clipping. A known code absent from that data fails `upstream_no_data`, placed against
   * its official coverage bounds when metadata is available — read as `currencyRejection`
   * reads it, so the miss adds no v1 request.
   */
  private async assertHistoricalCurrencies(
    fields: Array<[string, string[]]>,
    available: Set<string>,
    requested: CoverageContext['requested'],
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
      if (unknown.length > 0) throw await this.currencyRejection(field, unknown, accepted, signal);
    }
    for (const [field, missing] of absent) {
      if (missing.length === 0) continue;
      const metadata = await this.currencyMetadata(signal);
      throw upstreamNoData(field, missing, metadata && { requested, windows: metadata });
    }
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
    const { raw, fixed, statutory } = await this.resolveSnapshot(
      upper_base,
      [upper_quote],
      'quote_currency',
      date,
      signal,
      true,
    );
    const baseLeg = eurLeg(upper_base, raw.rates, fixed);
    const quoteLeg = eurLeg(upper_quote, raw.rates, fixed);
    if (baseLeg === undefined) throw upstreamNoData('base_currency', [upper_base]);
    if (quoteLeg === undefined) throw upstreamNoData('quote_currency', [upper_quote]);
    const rate = quoteLeg / baseLeg;

    const dateSnapped = date !== 'latest' && raw.date !== date;

    return {
      baseCurrency: upper_base,
      quoteCurrency: upper_quote,
      rate,
      rateDate: raw.date,
      dateSnapped,
      ...(statutory
        ? {
            ...statutoryProvenance(statutory.market),
            statutory,
            legs: { base: baseLeg, quote: quoteLeg },
          }
        : MARKET_PROVENANCE),
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
    /** The current-only latest-rates resource shares this market snapshot path. */
    includeFixed = true,
  ): Promise<ResolvedSnapshot> {
    const upper_base = base.trim().toUpperCase();
    const upper_symbols = symbols?.map((s) => s.trim().toUpperCase()) ?? [];
    const { raw, fixed, statutory } = await this.resolveSnapshot(
      upper_base,
      upper_symbols,
      'symbols',
      date,
      signal,
      includeFixed,
    );
    const baseLeg = eurLeg(upper_base, raw.rates, fixed);
    if (baseLeg === undefined) throw upstreamNoData('base_currency', [upper_base]);
    const requested =
      upper_symbols.length > 0
        ? upper_symbols
        : ['EUR', ...Object.keys(raw.rates)].filter((code) => code !== upper_base);
    const rates = Object.create(null) as Record<string, number>;
    const missing = requested.filter((code) => eurLeg(code, raw.rates, fixed) === undefined);
    if (missing.length > 0) throw upstreamNoData('symbols', missing);
    for (const code of requested) {
      const leg = eurLeg(code, raw.rates, fixed);
      if (leg === undefined) throw upstreamNoData('symbols', [code]);
      rates[code] = leg / baseLeg;
    }
    return {
      ...raw,
      base: upper_base,
      rates,
      ...(statutory && { statutory }),
    };
  }

  /** Supply both point and bulk calculations with the same snapshot and active fixed factors. */
  private async resolveSnapshot(
    base: string,
    quotes: string[],
    quoteField: 'quote_currency' | 'symbols',
    date: string,
    signal: AbortSignal | undefined,
    includeFixed: boolean,
  ) {
    signal?.throwIfAborted();
    if (date !== 'latest') assertDateFormat(date, 'date');
    const effectiveDate = date === 'latest' ? new Date().toISOString().slice(0, 10) : date;
    const codes = [base, ...quotes];
    const fixed = fixedRatesFor(
      codes,
      effectiveDate,
      includeFixed && this.baseUrl === OFFICIAL_FRANKFURTER_BASE_URL,
    );
    const market = quotes.length === 0 || !fixedOnly(codes, fixed);
    const statutory =
      fixed.size > 0 ? { fixedRates: [...fixed.values()], market, date: effectiveDate } : undefined;
    if (!market) {
      return { raw: { amount: 1, base: 'EUR', date: effectiveDate, rates: {} }, fixed, statutory };
    }

    if (date === 'latest') {
      if (!fixed.has(base)) await this.assertSupportedCurrencies('base_currency', [base], signal);
      const marketQuotes = quotes.filter((code) => !fixed.has(code));
      if (marketQuotes.length > 0)
        await this.assertSupportedCurrencies(quoteField, marketQuotes, signal);
    }
    const endpoint = date === 'latest' ? '/latest' : `/${encodeURIComponent(date)}`;
    const raw = await this.fetchJson<FrankfurterRateResponse>(`${endpoint}?base=EUR`, signal);
    if (date !== 'latest') {
      await this.assertHistoricalCurrencies(
        [
          ['base_currency', [base]],
          [quoteField, quotes],
        ],
        new Set(['EUR', ...Object.keys(raw.rates), ...fixed.keys()]),
        { start: date, end: date },
        signal,
      );
    }
    return { raw, fixed, statutory };
  }

  // ── Time-series ─────────────────────────────────────────────────────────────

  /**
   * Fetch a historical rate series for a currency pair, clipped to the requested
   * window and suitable for canvas registration.
   *
   * Two upstream behaviours are absorbed here:
   *
   * - A range that opens on a day with no published fix (a weekend, a TARGET
   *   holiday, or a same-day start before the fix is released) is snapped back to
   *   the prior publication day, so the response can carry dates the caller never
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
    signal?.throwIfAborted();
    assertDateFormat(startDate, 'start_date');
    assertDateFormat(endDate, 'end_date');
    const codes = [upper_base, upper_quote];
    const enabled = this.baseUrl === OFFICIAL_FRANKFURTER_BASE_URL;
    const endFactors = fixedRatesFor(codes, endDate, enabled);
    const fixedBaseLeg = eurLeg(upper_base, {}, endFactors);
    const fixedQuoteLeg = eurLeg(upper_quote, {}, endFactors);
    const lastAdoption = [...endFactors.values()]
      .map((rate) => rate.adoption_date)
      .sort()
      .at(-1);
    const fixedSuffix =
      lastAdoption && fixedBaseLeg !== undefined && fixedQuoteLeg !== undefined
        ? { startDate: lastAdoption, rate: fixedQuoteLeg / fixedBaseLeg }
        : undefined;
    const marketEnd = fixedSuffix ? dateOffset(fixedSuffix.startDate, -1) : endDate;
    let marketRates: FrankfurterSeriesResponse['rates'] = {};

    if (startDate <= marketEnd) {
      const url = `/${encodeURIComponent(startDate)}..${encodeURIComponent(marketEnd)}?base=EUR`;
      try {
        marketRates = (await this.fetchJson<FrankfurterSeriesResponse>(url, signal)).rates;
      } catch (error) {
        signal?.throwIfAborted();
        /** A v1 404 for the market prefix still leaves a valid statutory suffix. */
        if (!fixedSuffix || failureOf(error)?.reason !== 'upstream_no_data') throw error;
      }
      const available = new Set<string>(endFactors.keys());
      for (const rates of Object.values(marketRates)) {
        available.add('EUR');
        for (const code of Object.keys(rates)) available.add(code);
      }
      if (fixedSuffix) available.add('EUR');
      await this.assertHistoricalCurrencies(
        [
          ['base_currency', [upper_base]],
          ['quote_currency', [upper_quote]],
        ],
        available,
        { start: startDate, end: endDate },
        signal,
      );
    }

    let missing: Omit<NonNullable<TimeSeriesResult['missingCoverage']>, 'codes'> | undefined;
    const missingByCode = new Map<string, CoverageContext['requested']>();
    const trackMissing = (code: string, date: string) => {
      const span = missingByCode.get(code);
      if (span) span.end = date;
      else missingByCode.set(code, { start: date, end: date });
    };
    const usedFactors = new Map<string, StatutoryRate>();
    const rows: SeriesRow[] = [];
    let usedMarket = false;
    const append = (
      date: string,
      rate: number,
      fixed: ReadonlyMap<string, StatutoryRate>,
      market: boolean,
    ) => {
      if (market) usedMarket = true;
      for (const [code, factor] of fixed) usedFactors.set(code, factor);
      rows.push({
        date,
        rate,
        base_currency: upper_base,
        quote_currency: upper_quote,
        ...(fixed.size > 0 && { source: statutoryProvenance(market).source }),
      });
    };

    for (const [date, rateMap] of Object.entries(marketRates).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (date < startDate || date > marketEnd) continue;
      const fixed = fixedRatesFor(codes, date, enabled);
      const baseLeg = eurLeg(upper_base, rateMap, fixed);
      const quoteLeg = eurLeg(upper_quote, rateMap, fixed);
      if (baseLeg === undefined || quoteLeg === undefined) {
        missing ??= { count: 0, firstDate: date, lastDate: date };
        missing.count += 1;
        missing.lastDate = date;
        if (baseLeg === undefined) trackMissing(upper_base, date);
        if (quoteLeg === undefined && upper_quote !== upper_base) trackMissing(upper_quote, date);
        continue;
      }
      append(date, quoteLeg / baseLeg, fixed, true);
    }

    if (fixedSuffix) {
      for (
        let date = startDate < fixedSuffix.startDate ? fixedSuffix.startDate : startDate;
        date <= endDate;
        date = dateOffset(date, 1)
      ) {
        append(date, fixedSuffix.rate, endFactors, false);
      }
    }

    if (usedFactors.size > 0) {
      for (const row of rows) row.source ??= MARKET_PROVENANCE.source;
    }

    const metadata = missing ? await this.currencyMetadata(signal) : undefined;
    return {
      rows,
      ...(missing && {
        missingCoverage: {
          ...missing,
          codes: [...missingByCode]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([code, span]) => {
              const window = metadata?.find((currency) => currency.code === code);
              return { code, ...span, ...(window && { window }) };
            }),
        },
      }),
      startDate: rows[0]?.date ?? startDate,
      endDate: rows.at(-1)?.date ?? endDate,
      ...(usedFactors.size > 0 && {
        statutory: { fixedRates: [...usedFactors.values()], market: usedMarket },
      }),
    };
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const deadlineSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(12_000),
    ]);
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

        let body: T;
        try {
          body = (await response.json()) as T;
        } catch (err) {
          signal?.throwIfAborted();
          /** A fully read body that is not JSON (an HTML interstitial) will not parse on retry. */
          if (err instanceof SyntaxError) {
            throw serializationError(
              'Frankfurter returned a response that is not JSON.',
              undefined,
              {
                cause: err,
              },
            );
          }
          throw err;
        }
        signal?.throwIfAborted();
        return body;
      },
      { maxRetries: 2, baseDelayMs: 500, signal: deadlineSignal },
    );
  }
}

export { ECB_START_DATE };
