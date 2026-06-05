---
name: exchange-rates-mcp-server
description: "Foreign-exchange rates and conversion over ECB reference data — any currency pair, historical or latest, with cross-rates computed for you."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/exchange-rates-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
mirror: "T0/T1 — ECB full-history file (eurofxref-hist, ~MB) on disk for historical/timeseries + cross-rate math; latest daily fix fetched live. Avoids per-range live calls."
pattern: multi-source aggregation (ECB reference anchor + free FX provider)
complexity: low-medium
api-deps: ECB reference rates (via Frankfurter, keyless), exchangerate.host / open.er-api.com for broader currency coverage
api-cost: free (ECB/Frankfurter keyless; broader providers free tier, key optional)
hostable: true
composes-with: finnhub-mcp-server, coingecko-mcp-server, worldbank-mcp-server
---

# exchange-rates-mcp-server

Foreign-exchange rates and currency conversion — any pair, latest or historical — anchored on European Central Bank reference rates. Fills a real gap: the fleet has no **fiat** FX (`coingecko` is crypto, `finnhub` is equities). The reason this beats a curl is the parsing and the math: ECB publishes SDMX/XML that's painful to handle, ECB rates are EUR-base only (so any non-EUR pair has to be triangulated through EUR), and "the rate on date X" has to cope with weekends and holidays that have no published fix. The server normalizes to clean rate objects, computes cross-rates, and is honest about rate dates.

**Audience:** Finance, e-commerce, travel, and developers — anyone converting money or pulling a historical rate. Broad, and none of it is served by the existing fleet.

## User Goals

- Convert an amount from one currency to another (latest or on a past date)
- Get the current exchange rate for a pair
- Get a historical time series for a pair over a date range
- Get every rate for a base currency in one snapshot
- List supported currencies with names and symbols (disambiguate "dollars")

## API Surface

Multi-source, ECB as the reference anchor. Fiat only — no crypto (that's the `coingecko` idea).

| Source | Strength | Auth |
|:-------|:---------|:-----|
| ECB reference rates (via Frankfurter) | Authoritative daily reference rates for ~30 major currencies; historical back to 1999 | keyless |
| exchangerate.host / open.er-api.com | Broader currency coverage beyond the ECB set | free (key optional) |

ECB publishes a daily fix (~16:00 CET) against EUR; arbitrary pairs are triangulated through EUR server-side. Output carries source + rate date provenance.

## Tool Surface (sketch)

Tool prefix `fx_` — the canonical finance shorthand for foreign exchange.

```
fx_convert_currency   — convert an amount between currencies. base, quote, amount,
                     optional date (default latest). Returns the converted amount,
                     the rate used, and the rate date. Cross-rates triangulated
                     through the reference base automatically. The 80% tool.

fx_get_rate        — the exchange rate for a pair (base→quote) on a date (default
                     latest), no amount. Returns rate + date + source. For when the
                     agent wants the number, not a conversion.

fx_get_timeseries  — historical rates for a pair over a date range (start, end).
                     Returns a date→rate series for trend/analysis/charting. Spills
                     to DataCanvas for long ranges.

fx_get_rates       — every quote rate for one base currency in a single call
                     (base → {USD, JPY, GBP, …}), optional date. The bulk snapshot.

fx_list_currencies — supported ISO 4217 currencies: code, name, symbol, minor units.
                     Discovery + validation; resolves "dollars" (USD vs AUD vs CAD)
                     before a conversion.
```

## Design Notes

- **Naming.** Repo `exchange-rates-mcp-server` — no `fx` in the name: `fx-exchange-rates` stutters (synonyms), and `fx-mcp-server` alone fails the glance test (reads as effects/SFX without context). Tool prefix `fx_` — the canonical short token for the domain, universally understood and unambiguous next to a verb (`fx_convert`, `fx_get_rate`). This is **not** a mismatch; it's the fleet's existing short-canonical-prefix convention, where the descriptive suffix lives in the repo name and the prefix is the shortest unambiguous token: `bls-labor-mcp-server` → `bls_`, `eia-energy-mcp-server` → `eia_`, `nhtsa-vehicle-safety-mcp-server` → `nhtsa_`. Rejected `exchangerate_` (smushed) and `exchange_rate_` (long before every verb). `currency_` is the zero-jargon alternative if `fx` ever reads as too insider.
- **Cross-rates are the moat.** ECB publishes only EUR-base reference rates; arbitrary pairs (USD→JPY) are triangulated through EUR. Do the math server-side and document the base so rates are reproducible.
- **Be explicit these are reference (mid) rates** — a daily fix (~16:00 CET), not tradeable bid/ask, not intraday/live. No spread. Say so in tool output so an agent doesn't present them as dealing rates.
- **Date semantics.** Weekends and holidays have no ECB fix — "rate on Saturday" returns the prior business day's; echo the actual rate date, never silently snap to a different day without flagging it.
- **Source routing.** ECB (via Frankfurter, keyless) as the reference anchor; a broader free provider for currencies outside the ECB set. Output carries source + rate-date provenance.
- DataCanvas fits `fx_get_timeseries` for multi-year ranges.
- Composes with `finnhub` (equities + FX = a fuller markets picture), `coingecko` (the crypto leg), `worldbank` (macro context for a currency).
- README one-liner: "Foreign-exchange rates and conversion over ECB reference data — any pair, historical or latest, with cross-rates computed for you."
