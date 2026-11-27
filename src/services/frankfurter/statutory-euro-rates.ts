/**
 * @fileoverview Irrevocable national currency units per euro and their effective dates.
 * @module services/frankfurter/statutory-euro-rates
 */

export interface StatutoryRate {
  adoption_date: string;
  code: string;
  units_per_eur: number;
}

/** Council Regulation (EC) No 2866/98 as amended. */
export const STATUTORY_SOURCE = 'Council Regulation (EC) No 2866/98 as amended';

export const MARKET_PROVENANCE = {
  rateType: 'Daily rate (Frankfurter v1)',
  source: 'Frankfurter v1',
} as const;

/** Attribute an observation or range according to the legs that supplied its values. */
export function statutoryProvenance(market: boolean) {
  return market
    ? {
        rateType: 'Frankfurter v1 rates with statutory euro conversion',
        source: `Frankfurter v1 and ${STATUTORY_SOURCE}`,
      }
    : { rateType: 'Statutory euro conversion', source: STATUTORY_SOURCE };
}

/**
 * EUR-Lex 01998R2866-20260101 and the ECB's list of irrevocable euro conversion rates.
 * The first wave adopted the euro as book money in 1999, before euro cash in 2002.
 */
const ratesByAdoption: ReadonlyArray<
  [adoptionDate: string, rates: ReadonlyArray<[code: string, name: string, unitsPerEur: number]>]
> = [
  [
    '1999-01-01',
    [
      ['ATS', 'Austrian Schilling', 13.7603],
      ['BEF', 'Belgian Franc', 40.3399],
      ['DEM', 'Deutsche Mark', 1.95583],
      ['ESP', 'Spanish Peseta', 166.386],
      ['FIM', 'Finnish Markka', 5.94573],
      ['FRF', 'French Franc', 6.55957],
      ['IEP', 'Irish Pound', 0.787564],
      ['ITL', 'Italian Lira', 1936.27],
      ['LUF', 'Luxembourg Franc', 40.3399],
      ['NLG', 'Dutch Guilder', 2.20371],
      ['PTE', 'Portuguese Escudo', 200.482],
    ],
  ],
  ['2001-01-01', [['GRD', 'Greek Drachma', 340.75]]],
  ['2007-01-01', [['SIT', 'Slovenian Tolar', 239.64]]],
  [
    '2008-01-01',
    [
      ['CYP', 'Cyprus Pound', 0.585274],
      ['MTL', 'Maltese Lira', 0.4293],
    ],
  ],
  ['2009-01-01', [['SKK', 'Slovak Koruna', 30.126]]],
  ['2011-01-01', [['EEK', 'Estonian Kroon', 15.6466]]],
  ['2014-01-01', [['LVL', 'Latvian Lats', 0.702804]]],
  ['2015-01-01', [['LTL', 'Lithuanian Litas', 3.4528]]],
  ['2023-01-01', [['HRK', 'Croatian Kuna', 7.5345]]],
  ['2026-01-01', [['BGN', 'Bulgarian Lev', 1.95583]]],
];

/** Fixed-rate catalog, independent of upstream currency membership or coverage. */
export const statutoryEuroRates = new Map<string, Readonly<StatutoryRate & { name: string }>>(
  ratesByAdoption.flatMap(([adoption_date, rates]) =>
    rates.map(([code, name, units_per_eur]) => [
      code,
      { code, name, adoption_date, units_per_eur },
    ]),
  ),
);

/** Return a legal factor only once it has come into force. */
export function statutoryRate(code: string, date: string): StatutoryRate | undefined {
  const row = statutoryEuroRates.get(code);
  if (!row || row.adoption_date > date) return;
  const { adoption_date, units_per_eur } = row;
  return { code, adoption_date, units_per_eur };
}
