/**
 * @fileoverview Date-snap wording shared by fx_get_rate, fx_get_rates and fx_convert_currency.
 * A snapped date has three causes — a weekend, a TARGET holiday, or a same-day request made
 * before that day's fix is published — so neither text asserts one of them.
 * @module mcp-server/tools/date-snap
 */

/** The `date_snapped` output description. */
export const DATE_SNAPPED_DESCRIPTION =
  'True when Frankfurter v1 served a prior publication date because the requested daily fix was unavailable. False for fixed-only and latest results.';

/** Date shared by the point, conversion and bulk output contracts. */
export const RATE_DATE_DESCRIPTION =
  'Served market publication date, or the requested date (current UTC date for latest) for a fixed-only result.';

/** The `format()` line for a snapped rate, naming the published date served instead. */
export const dateSnapNote = (rateDate: string) =>
  `⚠️ *Requested date snapped to ${rateDate}: no rate was published for the requested date (weekend, holiday, or the day's fix not yet released)*`;
