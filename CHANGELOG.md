# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-31

Production Docker image installs its own dependencies instead of inheriting the build stage's devDependencies; drops the unused native-build toolchain

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-31 · ⚠️ Breaking

fx_convert_currency.amount rejects non-positive values; fx_get_timeseries clips to the requested range and handles same-currency pairs; DataCanvas tools gated off when unconfigured; mcp-ts-core ^0.11.0

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9; DataCanvas describe() filter and SQL-gate fixes reach fx_dataframe_* tools; new check-dependency-specifiers devcheck step + plugin-manifest packaging checks

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6; input-validation errors now classify as ValidationError (-32007); fx_dataframe_query gains a truncated output field; MCPB bundle now strips dependency-shipped agent docs

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Unsupported currency returns InvalidParams (-32602) in fx://rates/latest/{base}; cleaned audience-aware phrasing from fx_convert_currency and fx://currencies

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint — exchange-rates.caseyjhand.com/mcp added to server.json remotes and README

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 7 tools and 2 resources over the Frankfurter ECB FX API with DataCanvas SQL support and input injection hardening
