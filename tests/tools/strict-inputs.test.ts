/**
 * @fileoverview Pins the strict-input contract every tool inherited from
 * @cyanheads/mcp-ts-core 0.12.0: an argument key the schema does not declare is
 * rejected by name at the root instead of being stripped, and the advertised
 * `inputSchema` says so with `additionalProperties: false`.
 *
 * Written as a surface-wide sweep on purpose. The failure this guards against is
 * one tool quietly opting out — an added `.passthrough()`/`.catchall()`, or a
 * root that stops being a plain object — which no single-tool test would notice.
 * None of these tools accepts caller-defined extra keys, so none is exempt.
 * @module tests/tools/strict-inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  fxConvertCurrency,
  fxDataframeDescribe,
  fxDataframeDrop,
  fxDataframeQuery,
  fxGetRate,
  fxGetRates,
  fxGetTimeseries,
  fxListCurrencies,
} from '@/mcp-server/tools/definitions/index.js';

/** Every tool with a schema-valid minimal input for it. */
const cases = [
  { tool: fxListCurrencies, valid: {} },
  { tool: fxGetRates, valid: { base_currency: 'USD' } },
  { tool: fxGetRate, valid: { base_currency: 'USD', quote_currency: 'EUR' } },
  {
    tool: fxConvertCurrency,
    valid: { base_currency: 'USD', quote_currency: 'EUR', amount: 100 },
  },
  {
    tool: fxGetTimeseries,
    valid: {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-03',
      end_date: '2024-06-05',
    },
  },
  { tool: fxDataframeDescribe, valid: { canvas_id: 'abc1234567' } },
  { tool: fxDataframeQuery, valid: { canvas_id: 'abc1234567', query: 'SELECT 1' } },
  { tool: fxDataframeDrop, valid: { canvas_id: 'abc1234567', table_name: 'fx_usd_eur' } },
] as const;

describe.each(cases.map((c) => [c.tool.name, c] as const))(
  '%s input contract',
  (_name, testCase) => {
    const { tool, valid } = testCase;

    it('accepts its declared keys', () => {
      expect(tool.input.safeParse(valid).success).toBe(true);
    });

    it('rejects an undeclared root key by name instead of stripping it', () => {
      const parsed = tool.input.safeParse({ ...valid, definitely_not_a_field: 'x' });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]).toMatchObject({
        code: 'unrecognized_keys',
        keys: ['definitely_not_a_field'],
        path: [],
      });
    });

    it('advertises additionalProperties: false so a client sees the same rule', () => {
      const schema = z.toJSONSchema(tool.input) as unknown as {
        additionalProperties?: boolean;
        type?: string;
      };

      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    });
  },
);

describe('output and enrichment field names', () => {
  /**
   * 0.12.0 made `error` the wire's failure envelope and `tool()` throws at
   * definition time on an output or enrichment field using that name. Registration
   * already proves it, but naming it here keeps the reason discoverable when
   * someone reaches for `error` as a result field.
   */
  it.each(cases.map((c) => [c.tool.name, c.tool] as const))(
    '%s keeps `error` out of output and enrichment',
    (_name, tool) => {
      const output = z.toJSONSchema(tool.output) as unknown as {
        properties?: Record<string, unknown>;
      };
      expect(Object.keys(output.properties ?? {})).not.toContain('error');

      const enrichment = (tool as { enrichment?: Record<string, unknown> }).enrichment;
      if (enrichment) {
        expect(Object.keys(enrichment)).not.toContain('error');
      }
    },
  );
});
