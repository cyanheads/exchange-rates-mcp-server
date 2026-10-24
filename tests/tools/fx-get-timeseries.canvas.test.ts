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
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.table_name).toMatch(/^fx_usd_eur_[a-z0-9]+$/);
    const again = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: startDate,
        end_date: endDate,
        canvas_id: existing.canvasId,
      },
      ctx,
    );
    expect(again.table_name).not.toBe(result.table_name);
    expect(
      (await existing.query(`SELECT count(*)::INTEGER AS n FROM ${result.table_name}`)).rows,
    ).toEqual([{ n: 2 }]);
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

  it.each([0, 1, 2])(
    'explicitly stages %s rows with schema and complete preview on both surfaces',
    async (count) => {
      const tenantId = `explicit-${count}`;
      const ctx = createMockContext({ tenantId });
      const existing = await canvas.acquire(undefined, ctx);
      getTimeSeries.mockResolvedValueOnce({ rows: rows.slice(0, count), startDate, endDate });
      const result = await runToolContract(
        fxGetTimeseries,
        {
          base_currency: ' usd ',
          quote_currency: ' eur ',
          start_date: startDate,
          end_date: endDate,
          canvas_id: existing.canvasId,
        },
        { context: { tenantId } },
      );
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        table_name: string;
        summary?: {
          mean: number;
          change_pct: number;
          min: { date: string };
          max: { date: string };
        };
      };
      expect(data).toMatchObject({
        spilled: true,
        truncated: false,
        rate_count: count,
        base_currency: 'USD',
        quote_currency: 'EUR',
        ...(count > 0 && {
          summary: { mean: 1, change_pct: 0, min: { date: startDate }, max: { date: startDate } },
        }),
      });
      expect(
        (await existing.query(`SELECT count(*)::INTEGER AS n FROM ${data.table_name}`)).rows,
      ).toEqual([{ n: count }]);
      const table = (await existing.describe()).find((table) => table.name === data.table_name);
      expect(table?.columns.find((column) => column.name === 'rate')?.type).toBe('DOUBLE');
      expect(JSON.stringify(result.content)).toContain('truncated: false');
      expect(JSON.stringify(result.content)).toContain(data.table_name);
      if (count > 0) {
        expect(JSON.stringify(result.content)).toContain('Mean: 1');
        expect(JSON.stringify(result.content)).toContain('accounting-policy');
      } else expect(data).not.toHaveProperty('summary');
    },
  );

  it('preserves concurrent repeated pair tables and supports joining another pair', async () => {
    const ctx = createMockContext({ tenantId: 'concurrent', errors: fxGetTimeseries.errors });
    const instance = await canvas.acquire(undefined, ctx);
    getTimeSeries.mockResolvedValue({ rows: rows.slice(0, 2), startDate, endDate });
    const input = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: startDate,
      end_date: endDate,
      canvas_id: instance.canvasId,
    };
    const staged = await Promise.all([
      fxGetTimeseries.handler(input, ctx),
      fxGetTimeseries.handler(input, ctx),
      fxGetTimeseries.handler({ ...input, quote_currency: 'JPY' }, ctx),
    ]);
    expect(new Set(staged.map((result) => result.table_name)).size).toBe(3);
    for (const result of staged)
      expect(
        (await instance.query(`SELECT count(*)::INTEGER AS n FROM ${result.table_name}`)).rows,
      ).toEqual([{ n: 2 }]);
    expect(
      (
        await instance.query(
          `SELECT count(*)::INTEGER AS n FROM ${staged[0]!.table_name} a JOIN ${staged[2]!.table_name} b USING (date)`,
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it.each([0, 2])(
    'rejects unknown explicit canvases even for %s inline-fit rows',
    async (count) => {
      getTimeSeries.mockResolvedValueOnce({ rows: rows.slice(0, count), startDate, endDate });
      const result = await runToolContract(fxGetTimeseries, {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: startDate,
        end_date: endDate,
        canvas_id: 'abc1234567',
      });
      expect(result.isError).toBe(true);
      for (const surface of [
        JSON.stringify(result.structuredContent),
        JSON.stringify(result.content),
      ])
        expect(surface).toContain('canvas_not_found');
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
