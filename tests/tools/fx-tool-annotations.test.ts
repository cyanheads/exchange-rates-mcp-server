/**
 * @fileoverview Pins every tool's behavior hints against a hand-maintained
 * classification of what its handler actually touches. `openWorldHint` is true
 * for any tool that can reach the Frankfurter API — a cache in front of the call
 * does not make it local — and false for the DataCanvas-only tools.
 *
 * Written as a surface-wide table on purpose: no linter can check a hint against
 * handler behavior, and a single-tool test would miss the same drift landing on
 * a sibling. A tool exported from the definitions barrel without a row here fails
 * the coverage check, so a new tool must be classified before it ships.
 * @module tests/tools/fx-tool-annotations.test
 */

import { describe, expect, it } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';

interface Hints {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
}

/** Reaches Frankfurter over HTTP — read-only, idempotent, open-world. */
const frankfurter: Hints = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

/** Reads the local DataCanvas only. */
const canvasRead: Hints = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const expected: Record<string, Hints> = {
  fx_convert_currency: frankfurter,
  fx_get_rate: frankfurter,
  fx_get_rates: frankfurter,
  fx_get_timeseries: frankfurter,
  fx_list_currencies: frankfurter,
  fx_dataframe_describe: canvasRead,
  fx_dataframe_query: canvasRead,
  fx_dataframe_drop: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const tools = Object.values(definitions);

describe('tool annotations', () => {
  it('classifies every exported tool', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    '%s declares the hints its handler behavior implies',
    (name, tool) => {
      const { destructiveHint, idempotentHint, openWorldHint, readOnlyHint } = (tool.annotations ??
        {}) as Hints;

      expect({ destructiveHint, idempotentHint, openWorldHint, readOnlyHint }).toEqual(
        expected[name],
      );
    },
  );
});
