/**
 * @fileoverview Historical unit guidance for the official Frankfurter v1 series.
 */
import { getServerConfig, OFFICIAL_FRANKFURTER_BASE_URL } from '@/config/server-config.js';

const redenominations = [
  { code: 'RON', effectiveDate: '2005-07-01', formerCode: 'ROL', factor: '10,000' },
  { code: 'TRY', effectiveDate: '2005-01-01', formerCode: 'TRL', factor: '1,000,000' },
];

/** The earliest observed date is sufficient for a same-pair series. */
export function redenominationNotice(firstObservedDate: string, codes: string[]): string {
  if (getServerConfig().frankfurterBaseUrl !== OFFICIAL_FRANKFURTER_BASE_URL) return '';
  return redenominations
    .filter(({ code, effectiveDate }) => codes.includes(code) && firstObservedDate < effectiveDate)
    .map(
      ({ code, effectiveDate, formerCode, factor }) =>
        `${code} observations before ${effectiveDate} use restated units (1 ${code} = ${factor} ${formerCode}).`,
    )
    .join(' ');
}

/** Explain how to express old-unit amounts for a successor the official source accepts. */
export function successorGuidance(rejected: string[], accepted: string[]): string {
  if (getServerConfig().frankfurterBaseUrl !== OFFICIAL_FRANKFURTER_BASE_URL) return '';
  return redenominations
    .filter(({ code, formerCode }) => rejected.includes(formerCode) && accepted.includes(code))
    .map(
      ({ code, formerCode, factor }) =>
        `For historical ${formerCode} amounts, use ${code} and divide by ${factor} (1 ${code} = ${factor} ${formerCode}).`,
    )
    .join(' ');
}
