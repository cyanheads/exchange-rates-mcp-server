/**
 * @fileoverview Pins the `canvas_id` input contract the canvas surface took on from
 * @cyanheads/mcp-ts-core 0.13.5: every tool that accepts a canvas id declares the
 * field with `CanvasIdSchema`, so the minted `^[A-Za-z0-9_-]{10}$` shape is advertised
 * in `inputSchema` and an impossible value is rejected at argument validation — rather
 * than reaching the registry, which can only report it as missing or expired.
 *
 * Written as a surface-wide sweep on purpose: the failure this guards against is one
 * tool quietly reverting to a bare `z.string()`, which no single-tool test would notice.
 * @module tests/tools/canvas-id-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fxDataframeDescribe,
  fxDataframeDrop,
  fxDataframeQuery,
  fxGetTimeseries,
} from '@/mcp-server/tools/definitions/index.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';

/** The shape `CanvasRegistry` mints, as the framework advertises it. */
const MINTED_PATTERN = '^[A-Za-z0-9_-]{10}$';
const MINTED_ID = 'abc1234567';

/**
 * Every tool taking a canvas id, with the rest of a schema-valid input beside it and
 * the phrase its description must keep: `CanvasIdSchema`'s own `.describe()` states the
 * shape but not where an id comes from, so each field overrides it with its own source.
 */
const cases = [
  { tool: fxDataframeDescribe, siblings: {}, source: 'fx_get_timeseries' },
  { tool: fxDataframeQuery, siblings: { query: 'SELECT 1' }, source: 'fx_get_timeseries' },
  { tool: fxDataframeDrop, siblings: { table_name: 'fx_usd_eur' }, source: 'fx_get_timeseries' },
  {
    tool: fxGetTimeseries,
    siblings: {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-03',
      end_date: '2024-06-05',
    },
    // The producer itself: an id it accepts came from one of its own earlier calls.
    source: 'prior call',
  },
] as const;

/** Values no `CanvasRegistry` could ever have minted, one per way the shape can break. */
const malformed = [
  ['short', 'abc123'],
  ['long', 'abc12345678'],
  ['a disallowed character', 'abc123456!'],
  ['a whole-word placeholder', 'my-canvas'],
] as const;

describe.each(cases.map((c) => [c.tool.name, c] as const))(
  '%s canvas_id input contract',
  (_name, testCase) => {
    const { tool, siblings, source } = testCase;

    it('advertises the minted id pattern so a client sees the shape before it calls', () => {
      const schema = z.toJSONSchema(tool.input) as unknown as {
        properties?: Record<string, { pattern?: string; description?: string }>;
      };

      expect(schema.properties?.canvas_id?.pattern).toBe(MINTED_PATTERN);
    });

    it('keeps a description saying where the id comes from', () => {
      const schema = z.toJSONSchema(tool.input) as unknown as {
        properties?: Record<string, { description?: string }>;
      };

      expect(schema.properties?.canvas_id?.description).toContain(source);
    });

    it('accepts a minted id', () => {
      expect(tool.input.safeParse({ canvas_id: MINTED_ID, ...siblings }).success).toBe(true);
    });

    it.each(malformed)('rejects %s at argument validation', (_label, value) => {
      const parsed = tool.input.safeParse({ canvas_id: value, ...siblings });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((issue) => issue.path[0] === 'canvas_id')).toBe(true);
    });
  },
);

/**
 * The wire half of the same contract, through the production pipeline: a malformed id
 * now produces the framework's own argument rejection — `InvalidParams` with
 * `reason: 'invalid_arguments'` — and the handler never runs, so neither the canvas
 * registry nor the upstream service is reached.
 */
describe('malformed canvas_id on the wire', () => {
  const getCanvas = vi.spyOn(canvasModule, 'getCanvas');
  const getService = vi.spyOn(serviceModule, 'getFrankfurterService');

  beforeEach(() => {
    getCanvas.mockClear();
    getService.mockClear();
  });

  const errorOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { error: { code: number; data: Record<string, unknown> } }).error;

  it('rejects a required canvas_id before fx_dataframe_describe reaches the registry', async () => {
    const result = await runToolContract(fxDataframeDescribe, {
      canvas_id: 'my-canvas',
    } as never);

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(getCanvas).not.toHaveBeenCalled();
  });

  it('rejects an optional canvas_id before fx_get_timeseries reaches the upstream service', async () => {
    const result = await runToolContract(fxGetTimeseries, {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-03',
      end_date: '2024-06-05',
      canvas_id: 'my-canvas',
    } as never);

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(getService).not.toHaveBeenCalled();
  });

  /** Optional stays optional — the pattern must not turn an omitted id into a rejection. */
  it('leaves an omitted fx_get_timeseries canvas_id valid', () => {
    const parsed = fxGetTimeseries.input.safeParse({
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-03',
      end_date: '2024-06-05',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.canvas_id).toBeUndefined();
  });
});
