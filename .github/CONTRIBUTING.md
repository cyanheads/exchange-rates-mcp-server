# Contributing

Thanks for using `exchange-rates-mcp-server`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

Open a [bug report](https://github.com/cyanheads/exchange-rates-mcp-server/issues/new?template=bug_report.yml) or [feature request](https://github.com/cyanheads/exchange-rates-mcp-server/issues/new?template=feature_request.yml). Both forms are structured, and filling in the fields is what makes an issue actionable.

PRs are welcome; open an issue first for anything larger than a typo.

## Server bug or framework bug?

`exchange-rates-mcp-server` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry. Sorting out which layer broke saves everyone a round-trip:

- **This repo** — a tool returns wrong data, a Frankfurter/ECB call fails, a schema doesn't match reality, or a description misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on a valid config, a `Context` method behaves contrary to its docs, or transport or auth misbehaves regardless of which tool you call.

If you're not sure, file here and it'll get routed.

## Before filing

A few things that save a round-trip:

1. **Check you're on the latest release.** Fixes land on the current version.
2. **Search existing issues** before opening a new one. Add to the matching thread instead of filing a duplicate.
3. **Redact anything sensitive.** Issues are public and permanent — no API keys, tokens, auth headers, internal URLs, or PII in code, logs, or stack traces.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun / Node / Workers), and transport (stdio / HTTP).
- The tool or resource involved, and the arguments you called it with.
- Actual vs expected behavior, verbatim: error messages and stack traces as they appeared.
- For features: the use case first, then the API as you'd want to call it.

Rate data comes from the ECB via [Frankfurter](https://frankfurter.dev). A rate that looks wrong is worth checking against the ECB reference set first — these are mid-market reference rates published on TARGET business days, not tradeable quotes, and a weekend or holiday request snaps to the prior publication day.

## For agents

Do the triage first — an unverified report costs more to read than it saves to file.

Two workflows ship with this project:

- [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md) — filing against this repo.
- [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) — filing against `mcp-ts-core` when you've isolated the bug to the framework.

Read the relevant one before filing on a user's behalf.

## Security

Don't open a public issue for a vulnerability. Report it privately — GitHub's **Security** tab → **Report a vulnerability**, or email **security@caseyjhand.com**. See [SECURITY.md](./SECURITY.md).
