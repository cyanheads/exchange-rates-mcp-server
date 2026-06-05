/**
 * @fileoverview Tests for fx_dataframe_describe tool.
 * @module tests/tools/fx-dataframe-describe.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxDataframeDescribe } from '@/mcp-server/tools/definitions/fx-dataframe-describe.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';

const mockDescribe = vi.fn();
const mockAcquire = vi.fn();
const mockGetCanvas = vi.spyOn(canvasModule, 'getCanvas');

describe('fx_dataframe_describe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when canvas not enabled', async () => {
    mockGetCanvas.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: fxDataframeDescribe.errors });
    await expect(fxDataframeDescribe.handler({ canvas_id: 'abc1234567' }, ctx)).rejects.toThrow(
      'DataCanvas is not enabled',
    );
  });

  it('returns table schema from canvas', async () => {
    mockDescribe.mockResolvedValue([
      {
        name: 'fx_usd_eur',
        kind: 'table',
        rowCount: 100,
        columns: [
          { name: 'date', type: 'VARCHAR', nullable: false },
          { name: 'rate', type: 'DOUBLE', nullable: false },
        ],
      },
    ]);
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      describe: mockDescribe,
    });
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeDescribe.errors });
    const result = await fxDataframeDescribe.handler({ canvas_id: 'abc1234567' }, ctx);

    expect(result.canvas_id).toBe('abc1234567');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe('fx_usd_eur');
    expect(result.tables[0].row_count).toBe(100);
    expect(result.tables[0].columns[0].name).toBe('date');
  });

  it('throws canvas_not_found for missing canvas', async () => {
    mockAcquire.mockRejectedValue(new Error('not found: canvas expired'));
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeDescribe.errors });
    await expect(
      fxDataframeDescribe.handler({ canvas_id: 'expired123' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
  });

  it('format renders table schema', () => {
    const result = {
      canvas_id: 'abc1234567',
      tables: [
        {
          name: 'fx_usd_eur',
          kind: 'table',
          row_count: 100,
          columns: [
            { name: 'date', type: 'VARCHAR', nullable: false },
            { name: 'rate', type: 'DOUBLE', nullable: false },
          ],
        },
      ],
      expires_at: '2026-06-05T00:00:00.000Z',
    };
    const content = fxDataframeDescribe.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('abc1234567');
    expect(text).toContain('fx_usd_eur');
    expect(text).toContain('date');
    expect(text).toContain('DOUBLE');
    expect(text).toContain('100');
  });
});
