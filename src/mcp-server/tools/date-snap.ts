/**
 * @fileoverview Date-snap wording shared by fx_get_rate, fx_get_rates and fx_convert_currency.
 * A snapped date has three causes — a weekend, a TARGET holiday, or a same-day request made
 * before that day's fix is published — so neither text asserts one of them.
 * @module mcp-server/tools/date-snap
 */

/** The `date_snapped` output description. */
export const DATE_SNAPPED_DESCRIPTION =
  'True when rate_date differs from the requested date: the requested date was a weekend or holiday, or its daily fix was not yet published. Frankfurter v1 snaps such requests to the prior published date. Always false when date is omitted.';

/** The `format()` line for a snapped rate, naming the published date served instead. */
export const dateSnapNote = (rateDate: string) =>
  `⚠️ *Requested date snapped to ${rateDate}: no rate was published for the requested date (weekend, holiday, or the day's fix not yet released)*`;
