/**
 * @fileoverview Tests for fx_dataframe_drop — the one destructive verb on the canvas
 * surface. Covers both drop outcomes on both consumption paths (`structuredContent`
 * via the handler return and `content[]` via `format()`), the two declared failure
 * reasons with their recovery hints, and the opt-in gate that keeps the tool
 * unregistered until an operator sets FX_ENABLE_CANVAS_DROP.
 * @module tests/tools/fx-dataframe-drop.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxDataframeDrop } from '@/mcp-server/tools/definitions/fx-dataframe-drop.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';

const mockDrop = vi.fn();
const mockAcquire = vi.fn();
const mockGetCanvas = vi.spyOn(canvasModule, 'getCanvas');

/** Wire `getCanvas()` to an instance whose `drop()` is the mock above. */
const withCanvas = () => {
  mockAcquire.mockResolvedValue({
    canvasId: 'abc1234567',
    isNew: false,
    expiresAt: '2026-06-05T00:00:00.000Z',
    drop: mockDrop,
  });
  mockGetCanvas.mockReturnValue({
    acquire: mockAcquire,
  } as unknown as ReturnType<typeof canvasModule.getCanvas>);
};

describe('fx_dataframe_drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDrop.mockResolvedValue(true);
  });

  it('drops the named table and echoes the canvas it came from', async () => {
    withCanvas();
    const ctx = createMockContext({ errors: fxDataframeDrop.errors });
    const input = fxDataframeDrop.input.parse({
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
    });

    const result = await fxDataframeDrop.handler(input, ctx);

    expect(mockAcquire).toHaveBeenCalledWith('abc1234567', ctx);
    expect(mockDrop).toHaveBeenCalledWith('fx_usd_eur');
    expect(result).toEqual({
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
      dropped: true,
    });
  });

  it('reports dropped:false for a table that was already gone rather than failing', async () => {
    withCanvas();
    mockDrop.mockResolvedValue(false);
    const ctx = createMockContext({ errors: fxDataframeDrop.errors });
    const input = fxDataframeDrop.input.parse({
      canvas_id: 'abc1234567',
      table_name: 'fx_gbp_jpy',
    });

    await expect(fxDataframeDrop.handler(input, ctx)).resolves.toMatchObject({ dropped: false });
  });

  it('fails canvas_unavailable, with the enable hint, when no canvas is configured', async () => {
    mockGetCanvas.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: fxDataframeDrop.errors });
    const input = fxDataframeDrop.input.parse({
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
    });

    await expect(fxDataframeDrop.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        retryable: false,
        recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE') },
      },
    });
  });

  /** Mirrors the registry's own throw — the handler classifies on `data.reason`, not the message. */
  it('fails canvas_not_found when the canvas expired between staging and drop', async () => {
    mockAcquire.mockRejectedValue(
      notFound('Canvas not found or expired.', {
        canvasId: 'expired123',
        reason: 'canvas_not_found',
      }),
    );
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeDrop.errors });
    const input = fxDataframeDrop.input.parse({
      canvas_id: 'expired123',
      table_name: 'fx_usd_eur',
    });

    await expect(fxDataframeDrop.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: expect.stringContaining('fx_get_timeseries') },
      },
    });
  });

  it('rethrows an unclassified drop failure instead of blaming the canvas_id', async () => {
    withCanvas();
    mockDrop.mockRejectedValue(new Error('duckdb worker crashed'));
    const ctx = createMockContext({ errors: fxDataframeDrop.errors });
    const input = fxDataframeDrop.input.parse({
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
    });

    await expect(fxDataframeDrop.handler(input, ctx)).rejects.toThrow('duckdb worker crashed');
  });

  it('renders both outcomes distinguishably on the content[] surface', () => {
    const removed = fxDataframeDrop.format!({
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
      dropped: true,
    });
    const absent = fxDataframeDrop.format!({
      canvas_id: 'abc1234567',
      table_name: 'fx_usd_eur',
      dropped: false,
    });

    const removedText = (removed[0] as { text: string }).text;
    const absentText = (absent[0] as { text: string }).text;

    expect(removedText).toContain('Dropped');
    expect(removedText).toContain('fx_usd_eur');
    expect(removedText).toContain('abc1234567');
    expect(absentText).toContain('No table or view');
    expect(absentText).toContain('nothing to drop');
  });

  describe('opt-in gate', () => {
    /**
     * `disabledTool()` stamps its metadata under this key; the tool registry and the
     * manifest builder are its only other readers. Asserting on it here pins the
     * default-off posture — flipping the default would silently register a
     * destructive tool on every deployment.
     */
    const disabled = (fxDataframeDrop as unknown as Record<string, unknown>).__mcpDisabled as
      | { hint?: string; reason: string }
      | undefined;

    it('is disabled unless the deployment opts in', () => {
      expect(disabled).toBeDefined();
      expect(disabled?.reason).toMatch(/disabled/i);
    });

    it('names the env var that enables it', () => {
      expect(disabled?.hint).toBe('FX_ENABLE_CANVAS_DROP=true');
    });

    it('declares itself destructive and non-read-only', () => {
      expect(fxDataframeDrop.annotations).toMatchObject({
        destructiveHint: true,
        readOnlyHint: false,
      });
    });
  });
});
