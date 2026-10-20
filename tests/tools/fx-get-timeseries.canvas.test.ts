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
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
const registry = new CanvasRegistry(provider, {
  ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
  maxCanvasesPerTenant: 2,
  sweeperIntervalMs: 0,
});
const canvas = new DataCanvas(provider, registry);

/** Enough rows that the series overflows the 40,000-char preview and spills. */
const rows = Array.from({ length: 1_000 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
  rate: i === 999 ? 1.0842 : 1,
  base_currency: 'USD',
  quote_currency: 'EUR',
}));
const startDate = rows[0]!.date;
const endDate = rows[999]!.date;

const getTimeSeries = vi.fn().mockResolvedValue({ rows, startDate, endDate });
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getTimeSeries,
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

  it('characterizes supplied-canvas inline-fit preservation of existing data', async () => {
    const ctx = createMockContext({ tenantId: 'existing-fit', errors: fxGetTimeseries.errors });
    const existing = await canvas.acquire(undefined, ctx);
    await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
    getTimeSeries.mockResolvedValueOnce({ rows: rows.slice(0, 2), startDate, endDate });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: startDate,
        end_date: endDate,
        canvas_id: existing.canvasId,
      },
      ctx,
    );
    expect(result.spilled).toBe(false);
    expect(registry.countForTenant('existing-fit')).toBe(1);
    expect((await existing.query('SELECT * FROM keep')).rows).toEqual([{ sentinel: 'preserved' }]);
  });

  it.each([0, 2])(
    'releases a new inline-fit canvas for %s rows across repeated calls',
    async (count) => {
      const tenantId = `inline-${count}`;
      getTimeSeries.mockResolvedValue({ rows: rows.slice(0, count), startDate, endDate });
      for (let call = 0; call < 4; call++) {
        const result = await runToolContract(
          fxGetTimeseries,
          { base_currency: 'USD', quote_currency: 'EUR', start_date: startDate, end_date: endDate },
          { context: { tenantId } },
        );
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ spilled: false, rate_count: count });
        expect(JSON.stringify(result.content)).toContain('spilled: false');
        expect(registry.countForTenant(tenantId)).toBe(0);
      }
    },
  );

  it.each([false, true])(
    'releases only newly acquired canvases after staging failure (supplied=%s)',
    async (supplied) => {
      const tenantId = `failed-${supplied}`;
      const ctx = createMockContext({ tenantId, errors: fxGetTimeseries.errors });
      const existing = supplied ? await canvas.acquire(undefined, ctx) : undefined;
      if (existing) await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
      getTimeSeries.mockResolvedValue({ rows, startDate, endDate });
      const failure = new Error('staging failed');
      const register = vi.spyOn(provider, 'registerTable').mockRejectedValueOnce(failure);
      try {
        await expect(
          fxGetTimeseries.handler(
            {
              base_currency: 'USD',
              quote_currency: 'EUR',
              start_date: startDate,
              end_date: endDate,
              ...(existing && { canvas_id: existing.canvasId }),
            },
            ctx,
          ),
        ).rejects.toBe(failure);
      } finally {
        register.mockRestore();
      }
      expect(registry.countForTenant(tenantId)).toBe(supplied ? 1 : 0);
      if (existing)
        expect((await existing.query('SELECT * FROM keep')).rows).toEqual([
          { sentinel: 'preserved' },
        ]);
    },
  );

  it.each([false, true])(
    'releases only new canvases when cancelled immediately after acquire (supplied=%s)',
    async (supplied) => {
      const tenantId = `cancelled-${supplied}`;
      const caller = new AbortController();
      const ctx = createMockContext({
        tenantId,
        signal: caller.signal,
        errors: fxGetTimeseries.errors,
      });
      const existing = supplied ? await canvas.acquire(undefined, ctx) : undefined;
      if (existing) await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
      getTimeSeries.mockResolvedValue({ rows, startDate, endDate });
      const reason = new Error('caller left');
      const acquire = canvas.acquire.bind(canvas);
      const hook = vi.spyOn(canvas, 'acquire').mockImplementationOnce(async (...args) => {
        const instance = await acquire(...args);
        caller.abort(reason);
        return instance;
      });
      try {
        await expect(
          fxGetTimeseries.handler(
            {
              base_currency: 'USD',
              quote_currency: 'EUR',
              start_date: startDate,
              end_date: endDate,
              ...(existing && { canvas_id: existing.canvasId }),
            },
            ctx,
          ),
        ).rejects.toBe(reason);
      } finally {
        hook.mockRestore();
      }
      expect(registry.countForTenant(tenantId)).toBe(supplied ? 1 : 0);
      if (existing)
        expect((await existing.query('SELECT * FROM keep')).rows).toEqual([
          { sentinel: 'preserved' },
        ]);
    },
  );

  it.each([false, true])(
    'cleans up cancellation while DuckDB consumes the staged rows (supplied=%s)',
    async (supplied) => {
      const tenantId = `midstage-${supplied}`;
      const caller = new AbortController();
      const ctx = createMockContext({
        tenantId,
        signal: caller.signal,
        errors: fxGetTimeseries.errors,
      });
      const existing = supplied ? await canvas.acquire(undefined, ctx) : undefined;
      if (existing) await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
      getTimeSeries.mockResolvedValue({ rows, startDate, endDate });
      const reason = new Error('cancel while staging');
      const registerTable = provider.registerTable.bind(provider);
      let consumed = 0;
      const hook = vi
        .spyOn(provider, 'registerTable')
        .mockImplementationOnce((id, name, source, context, options) => {
          async function* interrupted() {
            for await (const row of source) {
              consumed++;
              if (consumed === 2) caller.abort(reason);
              yield row;
            }
          }
          return registerTable(id, name, interrupted(), context, options);
        });
      try {
        await expect(
          fxGetTimeseries.handler(
            {
              base_currency: 'USD',
              quote_currency: 'EUR',
              start_date: startDate,
              end_date: endDate,
              ...(existing && { canvas_id: existing.canvasId }),
            },
            ctx,
          ),
        ).rejects.toBe(reason);
      } finally {
        hook.mockRestore();
      }
      expect(consumed).toBe(2);
      expect(registry.countForTenant(tenantId)).toBe(supplied ? 1 : 0);
      if (existing)
        expect((await existing.query('SELECT * FROM keep')).rows).toEqual([
          { sentinel: 'preserved' },
        ]);
    },
  );
});
