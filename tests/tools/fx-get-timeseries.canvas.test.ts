/**
 * @fileoverview fx_get_timeseries staging a spilled series on a real DuckDB canvas. The
 * column types of the staged table are a property of the engine, so a mocked
 * `spillover()` cannot show them: a series whose leading rates are whole numbers must
 * still stage `rate` as DOUBLE and keep a later fractional rate intact.
 * @module tests/tools/fx-get-timeseries.canvas.test
 */

import { tmpdir } from 'node:os';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import { setCanvas } from '@/services/canvas/canvas-accessor.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';

const provider = new DuckdbProvider({
  defaultRowLimit: 1_000,
  exportRootPath: tmpdir(),
  memoryLimitMb: 256,
  schemaSniffRows: 1_000,
  tempRootPath: tmpdir(),
});
const canvas = new DataCanvas(
  provider,
  new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
);

/** Enough rows that the series overflows the 40,000-char preview and spills. */
const rows = Array.from({ length: 1_000 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
  rate: i === 999 ? 1.0842 : 1,
  base_currency: 'USD',
  quote_currency: 'EUR',
}));
const startDate = rows[0]!.date;
const endDate = rows[999]!.date;

vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getTimeSeries: vi.fn().mockResolvedValue({ rows, startDate, endDate }),
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

setCanvas(canvas);

describe('fx_get_timeseries on a DuckDB canvas', () => {
  afterAll(async () => {
    setCanvas(undefined);
    await canvas.shutdown(createMockContext());
  });

  it('stages rate as DOUBLE when the leading rates are whole numbers', async () => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      { base_currency: 'USD', quote_currency: 'EUR', start_date: startDate, end_date: endDate },
      ctx,
    );
    expect(result.spilled).toBe(true);

    const instance = await canvas.acquire(result.canvas_id, ctx);
    const staged = await instance.query(
      `SELECT typeof(rate) AS rate_type, rate FROM ${result.table_name} WHERE date = '${endDate}'`,
    );
    expect(staged.rows).toEqual([{ rate_type: 'DOUBLE', rate: 1.0842 }]);
  });
});
