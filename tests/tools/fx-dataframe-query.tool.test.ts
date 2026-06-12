/**
 * @fileoverview Tests for fx_dataframe_query tool.
 * @module tests/tools/fx-dataframe-query.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxDataframeQuery } from '@/mcp-server/tools/definitions/fx-dataframe-query.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';

const mockQuery = vi.fn();
const mockAcquire = vi.fn();
const mockGetCanvas = vi.spyOn(canvasModule, 'getCanvas');

describe('fx_dataframe_query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when canvas not enabled', async () => {
    mockGetCanvas.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler({ canvas_id: 'abc1234567', query: 'SELECT * FROM fx_usd_eur' }, ctx),
    ).rejects.toThrow('DataCanvas is not enabled');
  });

  it('returns query results from canvas', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { date: '2024-06-03', rate: 0.91 },
        { date: '2024-06-04', rate: 0.92 },
      ],
      rowCount: 2,
    });
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    const result = await fxDataframeQuery.handler(
      { canvas_id: 'abc1234567', query: 'SELECT date, rate FROM fx_usd_eur ORDER BY date' },
      ctx,
    );

    expect(result.canvas_id).toBe('abc1234567');
    expect(result.row_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ date: '2024-06-03', rate: 0.91 });
  });

  it('surfaces truncated when the row cap was hit', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ date: '2024-06-03', rate: 0.91 }],
      rowCount: 10_000,
      truncated: true,
    });
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    const result = await fxDataframeQuery.handler(
      { canvas_id: 'abc1234567', query: 'SELECT * FROM fx_usd_eur' },
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(10_000);
  });

  it('throws canvas_not_found for missing canvas', async () => {
    mockAcquire.mockRejectedValue(new Error('not found: canvas expired'));
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler({ canvas_id: 'expired123', query: 'SELECT * FROM fx_usd_eur' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
  });

  it('throws invalid_query for non-SELECT SQL', async () => {
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockQuery.mockRejectedValue(new Error('ValidationError: only SELECT is allowed'));
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler({ canvas_id: 'abc1234567', query: 'DROP TABLE fx_usd_eur' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
  });

  it('throws invalid_query for unknown table reference', async () => {
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockQuery.mockRejectedValue(new Error('Table does not exist: fx_nonexistent'));
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler(
        { canvas_id: 'abc1234567', query: 'SELECT * FROM fx_nonexistent' },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
  });

  it('format renders query results as markdown table', () => {
    const result = {
      rows: [
        { date: '2024-06-03', rate: 0.91 },
        { date: '2024-06-04', rate: 0.92 },
      ],
      row_count: 2,
      truncated: false,
      canvas_id: 'abc1234567',
    };
    const content = fxDataframeQuery.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('date');
    expect(text).toContain('rate');
    expect(text).toContain('2024-06-03');
    expect(text).toContain('0.91');
    expect(text).toContain('abc1234567');
  });

  it('format discloses the row cap when truncated', () => {
    const result = {
      rows: Array.from({ length: 50 }, (_, i) => ({ date: `2024-06-${i + 1}`, rate: 0.9 })),
      row_count: 10_000,
      truncated: true,
      canvas_id: 'abc1234567',
    };
    const content = fxDataframeQuery.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('capped');
  });

  it('format renders empty result correctly', () => {
    const result = {
      rows: [],
      row_count: 0,
      truncated: false,
      canvas_id: 'abc1234567',
    };
    const content = fxDataframeQuery.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('abc1234567');
  });
});
