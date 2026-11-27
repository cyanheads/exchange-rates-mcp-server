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
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  /** A queued series a failed call never consumed must not leak into the next test. */
  beforeEach(() => {
    getTimeSeries.mockReset();
    getTimeSeries.mockResolvedValue({ rows, startDate, endDate });
  });

  afterAll(async () => {
    setCanvas(undefined);
    await canvas.shutdown(createMockContext());
  });

  it('stages all rows and composes unit guidance with coverage and delivery notices', async () => {
    getTimeSeries.mockResolvedValueOnce({
      rows: [
        { date: '2005-06-29', rate: 3.63, base_currency: 'EUR', quote_currency: 'RON' },
        { date: '2005-07-01', rate: 3.603, base_currency: 'EUR', quote_currency: 'RON' },
      ],
      startDate: '2005-06-29',
      endDate: '2005-07-01',
      missingCoverage: {
        count: 1,
        firstDate: '2005-06-30',
        lastDate: '2005-06-30',
        codes: [{ code: 'RON', start: '2005-06-30', end: '2005-06-30' }],
      },
    });
    const result = await runToolContract(
      fxGetTimeseries,
      {
        base_currency: 'EUR',
        quote_currency: 'RON',
        start_date: '2005-06-29',
        end_date: '2005-07-01',
        limit: 0,
        stage: true,
      },
      { context: { tenantId: 'historical-units' } },
    );
    expect(result.structuredContent).toMatchObject({ spilled: true, rates: {}, rate_count: 2 });
    for (const surface of [result.structuredContent, result.content]) {
      const text = JSON.stringify(surface);
      expect(text).toContain('1 RON = 10,000 ROL');
      expect(text).toContain('1 served publication day on 2005-06-30');
      expect(text).toContain('Staged 2 rows');
    }
  });

  it.each([
    { supplied: false, limit: 0 },
    { supplied: false, limit: 1 },
    { supplied: false, limit: 999 },
    { supplied: true, limit: 0 },
    { supplied: true, limit: 1 },
    { supplied: true, limit: 999 },
  ])(
    'bounds the $supplied staged preview at limit=$limit while preserving full data and notices',
    async ({ supplied, limit }) => {
      const tenantId = `preview-${supplied}-${limit}`;
      const ctx = createMockContext({ tenantId });
      const existing = supplied ? await canvas.acquire(undefined, ctx) : undefined;
      getTimeSeries.mockResolvedValueOnce({
        rows,
        startDate,
        endDate,
        missingCoverage: {
          count: 3,
          firstDate: '2020-01-02',
          lastDate: '2020-01-04',
          codes: [{ code: 'USD', start: '2020-01-02', end: '2020-01-04' }],
        },
      });
      const result = await runToolContract(
        fxGetTimeseries,
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          start_date: startDate,
          end_date: endDate,
          limit,
          ...(existing && { canvas_id: existing.canvasId }),
        },
        { context: { tenantId } },
      );
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        rates: Record<string, number>;
        canvas_id: string;
        table_name: string;
        notice: string;
      };
      expect(data).toMatchObject({
        rate_count: 1000,
        spilled: true,
        truncated: true,
        summary: { mean: 1.0000842, last: { rate: 1.0842, date: endDate } },
      });
      expect(data).not.toHaveProperty('next_start_date');
      expect(Object.keys(data.rates).length).toBeLessThanOrEqual(Math.min(limit, 500));
      if (limit < 2) expect(Object.keys(data.rates)).toHaveLength(limit);
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      expect(text.match(/^\d{4}-\d{2}-\d{2}(?=: )/gm) ?? []).toEqual(Object.keys(data.rates));
      for (const surface of [data.notice, text]) {
        expect(surface).toContain('3 served publication days');
        expect(surface).toContain('observed days only');
        expect(surface).toContain('Staged 1000 rows');
        if (limit === 999) expect(surface).toContain('clamped to 500');
      }
      const instance = await canvas.acquire(data.canvas_id, ctx);
      expect(
        (await instance.query(`SELECT count(*)::INTEGER AS n FROM ${data.table_name}`)).rows,
      ).toEqual([{ n: 1000 }]);
    },
  );

  it('does not turn an inline-fit range into automatic staging for limit zero', async () => {
    const tenantId = 'summary-inline-fit';
    getTimeSeries.mockResolvedValueOnce({ rows: rows.slice(0, 2), startDate, endDate });
    const result = await runToolContract(
      fxGetTimeseries,
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: startDate,
        end_date: endDate,
        limit: 0,
      },
      { context: { tenantId } },
    );
    expect(result.structuredContent).toMatchObject({
      rates: {},
      rate_count: 2,
      spilled: false,
      truncated: true,
      next_start_date: startDate,
    });
    expect(registry.countForTenant(tenantId)).toBe(0);
  });

  it('stages rate as DOUBLE when the leading rates are whole numbers', async () => {
    const ctx = createMockContext({ errors: fxGetTimeseries.errors });
    const result = await fxGetTimeseries.handler(
      {
        base_currency: 'USD',
        quote_currency: 'EUR',
        start_date: startDate,
        end_date: endDate,
        stage: false,
      },
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
    const input = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: startDate,
      end_date: endDate,
      canvas_id: existing.canvasId,
      stage: false,
    };
    const result = await fxGetTimeseries.handler(input, ctx);
    expect(result.spilled).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.table_name).toMatch(/^fx_usd_eur_[a-z0-9]+$/);
    const again = await fxGetTimeseries.handler(input, ctx);
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

  /** A two-day window: far under the spill threshold, so only explicit staging can stage it. */
  const shortWindow = { start_date: '2020-01-01', end_date: '2020-01-02' };
  const shortSeries = (count: number) => ({
    rows: rows.slice(0, count),
    startDate: shortWindow.start_date,
    endDate: shortWindow.end_date,
  });
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block as { text: string }).text).join('\n');

  it.each([0, 1, 2])(
    'stage: true without canvas_id stages %s rows on one new retained canvas',
    async (count) => {
      const tenantId = `stage-${count}`;
      getTimeSeries.mockResolvedValueOnce(shortSeries(count));
      const result = await runToolContract(
        fxGetTimeseries,
        { base_currency: 'USD', quote_currency: 'EUR', ...shortWindow, stage: true },
        { context: { tenantId } },
      );
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        canvas_id: string;
        table_name: string;
        rates: Record<string, number>;
        notice: string;
      };
      expect(data).toMatchObject({ spilled: true, truncated: false, rate_count: count });
      expect(data).not.toHaveProperty('next_start_date');
      expect(data.table_name).toMatch(/^fx_usd_eur_[0-9a-f]{32}$/);
      expect(Object.keys(data.rates)).toEqual(rows.slice(0, count).map((row) => row.date));
      expect(registry.countForTenant(tenantId)).toBe(1);

      const instance = await canvas.acquire(data.canvas_id, createMockContext({ tenantId }));
      const table = (await instance.describe()).find((t) => t.name === data.table_name);
      expect(table?.rowCount).toBe(count);
      expect(table?.columns.find((column) => column.name === 'rate')?.type).toBe('DOUBLE');
      for (const surface of [data.notice, textOf(result)]) {
        expect(surface).toContain(data.canvas_id);
        expect(surface).toContain(data.table_name);
      }
    },
  );

  it('stage: true with limit 0 stages the full series and returns only the summary', async () => {
    const tenantId = 'stage-limit-zero';
    getTimeSeries.mockResolvedValueOnce(shortSeries(2));
    const result = await runToolContract(
      fxGetTimeseries,
      { base_currency: 'USD', quote_currency: 'EUR', ...shortWindow, stage: true, limit: 0 },
      { context: { tenantId } },
    );
    const data = result.structuredContent as { canvas_id: string; table_name: string };
    expect(data).toMatchObject({
      spilled: true,
      rates: {},
      rate_count: 2,
      truncated: true,
      summary: { mean: 1, first: { date: '2020-01-01' }, last: { date: '2020-01-02' } },
    });
    expect(data).not.toHaveProperty('next_start_date');
    const instance = await canvas.acquire(data.canvas_id, createMockContext({ tenantId }));
    expect(
      (await instance.query(`SELECT count(*)::INTEGER AS n FROM ${data.table_name}`)).rows,
    ).toEqual([{ n: 2 }]);
    expect(registry.countForTenant(tenantId)).toBe(1);
  });

  it.each([false, true])(
    'stage: %s beside canvas_id behaves exactly as canvas_id alone',
    async (stage) => {
      const tenantId = `stage-beside-${stage}`;
      const ctx = createMockContext({ tenantId });
      const existing = await canvas.acquire(undefined, ctx);
      await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
      const input = {
        base_currency: 'USD',
        quote_currency: 'EUR',
        ...shortWindow,
        canvas_id: existing.canvasId,
      };
      getTimeSeries.mockResolvedValueOnce(shortSeries(2)).mockResolvedValueOnce(shortSeries(2));
      const alone = await runToolContract(fxGetTimeseries, input, { context: { tenantId } });
      const beside = await runToolContract(
        fxGetTimeseries,
        { ...input, stage },
        { context: { tenantId } },
      );
      const tableOf = (result: typeof alone) =>
        (result.structuredContent as { table_name: string }).table_name;
      /** Each registration takes a fresh table suffix; everything else must match. */
      const normalized = (result: typeof alone) =>
        JSON.parse(
          JSON.stringify({ data: result.structuredContent, text: result.content }).replaceAll(
            tableOf(result),
            '<table>',
          ),
        );
      expect(beside.isError).toBeFalsy();
      expect(normalized(beside)).toEqual(normalized(alone));
      expect(beside.structuredContent).toMatchObject({
        spilled: true,
        canvas_id: existing.canvasId,
      });
      expect(registry.countForTenant(tenantId)).toBe(1);
      expect((await existing.query('SELECT * FROM keep')).rows).toEqual([
        { sentinel: 'preserved' },
      ]);
    },
  );

  it('stage: true without canvas_id at the tenant canvas cap fails capacity, never inline', async () => {
    const tenantId = 'stage-at-cap';
    const ctx = createMockContext({ tenantId });
    await canvas.acquire(undefined, ctx);
    await canvas.acquire(undefined, ctx);
    getTimeSeries.mockResolvedValueOnce(shortSeries(2));
    const result = await runToolContract(
      fxGetTimeseries,
      { base_currency: 'USD', quote_currency: 'EUR', ...shortWindow, stage: true },
      { context: { tenantId } },
    );
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { data: Record<string, unknown> } }).error;
    const hint =
      'Pass a canvas_id you already hold instead of omitting it to create another, or retry once idle canvases pass their TTL.';
    expect(error.data).toMatchObject({
      reason: 'canvas_capacity_exhausted',
      retryable: true,
      recovery: { hint },
    });
    expect(textOf(result)).toContain(hint);
    expect(registry.countForTenant(tenantId)).toBe(2);
  });

  it('answers an inline-fit range past the threshold at the tenant canvas cap', async () => {
    const tenantId = 'implicit-at-cap';
    const ctx = createMockContext({ tenantId });
    await canvas.acquire(undefined, ctx);
    await canvas.acquire(undefined, ctx);
    getTimeSeries.mockResolvedValueOnce({ rows: rows.slice(0, 2), startDate, endDate });
    const result = await runToolContract(
      fxGetTimeseries,
      { base_currency: 'USD', quote_currency: 'EUR', start_date: startDate, end_date: endDate },
      { context: { tenantId } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      spilled: false,
      truncated: false,
      rate_count: 2,
      rates: { [rows[0]!.date]: 1, [rows[1]!.date]: 1 },
    });
    expect(registry.countForTenant(tenantId)).toBe(2);
  });

  /**
   * The tool decides overflow before acquiring a canvas, by spillover()'s own measure:
   * the running sum of each row's JSON length against the 40,000-character preview budget.
   * Rows totalling exactly the budget fit; one character more overflows. Both sides are
   * also checked against spillover() itself, so a change in the framework's measure fails here.
   */
  describe('preview budget boundary', () => {
    const PREVIEW_BUDGET = 40_000;
    const chars = (series: readonly object[]) =>
      series.reduce((total, row) => total + JSON.stringify(row).length, 0);
    /** A rate whose JSON form is `extra` characters longer than `1`'s (1 ≤ extra ≤ 14). */
    const widened = (extra: number) => (extra === 1 ? 10 : Number(`1.${'1'.repeat(extra - 1)}`));
    /** Over-threshold rows (dates from the 1,000-day series) whose JSON totals exactly `total`. */
    const totalling = (total: number) => {
      const unit = JSON.stringify(rows[0]).length;
      let rest = total % unit;
      return rows.slice(0, Math.floor(total / unit)).map((row) => {
        const extra = Math.min(rest, 14);
        rest -= extra;
        return extra === 0 ? { ...row, rate: 1 } : { ...row, rate: widened(extra) };
      });
    };
    const fit = totalling(PREVIEW_BUDGET);
    const overflow = totalling(PREVIEW_BUDGET + 1);
    const input = {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: startDate,
      end_date: endDate,
    };

    it('builds series exactly at and one character past the budget', () => {
      expect(chars(fit)).toBe(PREVIEW_BUDGET);
      expect(chars(overflow)).toBe(PREVIEW_BUDGET + 1);
      expect(overflow).toHaveLength(fit.length);
    });

    it('matches spillover() on both sides of the budget', async () => {
      const unused = {
        registerTable: vi.fn().mockRejectedValue(new Error('fit must not register')),
      } as unknown as Parameters<typeof spillover>[0]['canvas'];
      expect(
        (await spillover({ canvas: unused, source: fit, previewChars: PREVIEW_BUDGET })).spilled,
      ).toBe(false);
      const ctx = createMockContext({ tenantId: 'boundary-probe' });
      const probe = await canvas.acquire(undefined, ctx);
      try {
        const spilled = await spillover({
          canvas: probe,
          source: overflow,
          previewChars: PREVIEW_BUDGET,
        });
        expect(spilled.spilled).toBe(true);
      } finally {
        await canvas.drop(probe.canvasId, ctx);
      }
    });

    it('pages a series exactly at the budget inline without acquiring a canvas', async () => {
      const tenantId = 'boundary-fit';
      const acquire = vi.spyOn(canvas, 'acquire');
      getTimeSeries.mockResolvedValueOnce({ rows: fit, startDate, endDate });
      try {
        const result = await runToolContract(fxGetTimeseries, input, { context: { tenantId } });
        expect(result.structuredContent).toMatchObject({
          spilled: false,
          rate_count: fit.length,
          truncated: true,
          next_start_date: fit[500]!.date,
        });
        expect(acquire).not.toHaveBeenCalled();
      } finally {
        acquire.mockRestore();
      }
      expect(registry.countForTenant(tenantId)).toBe(0);
    });

    it('stages a series one character past the budget', async () => {
      const tenantId = 'boundary-overflow';
      getTimeSeries.mockResolvedValueOnce({ rows: overflow, startDate, endDate });
      const result = await runToolContract(fxGetTimeseries, input, { context: { tenantId } });
      const data = result.structuredContent as { canvas_id: string; table_name: string };
      expect(data).toMatchObject({ spilled: true, truncated: true, rate_count: overflow.length });
      const instance = await canvas.acquire(data.canvas_id, createMockContext({ tenantId }));
      expect(
        (await instance.query(`SELECT count(*)::INTEGER AS n FROM ${data.table_name}`)).rows,
      ).toEqual([{ n: overflow.length }]);
      expect(registry.countForTenant(tenantId)).toBe(1);
    });
  });

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
      stage: false,
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

  /**
   * The registry throws `canvas_not_found` with its own generic re-stage hint; the tool's
   * declared recovery (which names `stage: true`) must be what reaches both surfaces.
   */
  it.each([
    { count: 0, stage: undefined },
    { count: 2, stage: undefined },
    { count: 2, stage: true },
  ])(
    'rejects an unknown canvas_id with the declared recovery ($count rows, stage=$stage)',
    async ({ count, stage }) => {
      const tenantId = `unknown-${count}-${stage}`;
      getTimeSeries.mockResolvedValueOnce({ rows: rows.slice(0, count), startDate, endDate });
      const result = await runToolContract(
        fxGetTimeseries,
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          start_date: startDate,
          end_date: endDate,
          canvas_id: 'abc1234567',
          ...(stage !== undefined && { stage }),
        },
        { context: { tenantId } },
      );
      expect(result.isError).toBe(true);
      const hint =
        'Supply a live canvas ID from a recent response, set stage: true without canvas_id to stage on a new canvas, or omit both for automatic staging or inline paging.';
      const error = (
        result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe('Canvas "abc1234567" not found or has expired.');
      expect(error.data).toMatchObject({ reason: 'canvas_not_found', recovery: { hint } });
      expect(textOf(result)).toContain(hint);
      expect(textOf(result)).not.toContain('Re-run the tool that produced this canvas_id');
      expect(registry.countForTenant(tenantId)).toBe(0);
    },
  );

  /**
   * How a failing or cancelled call reached the canvas: an automatic spill on a new canvas,
   * explicit staging on a supplied one, or `stage: true` on a new one. Only the supplied
   * canvas belongs to the caller and survives.
   */
  const stagingModes = ['automatic', 'supplied', 'stage'] as const;
  const stagingInput = (
    mode: (typeof stagingModes)[number],
    existing: { canvasId: string } | undefined,
  ) => ({
    base_currency: 'USD',
    quote_currency: 'EUR',
    start_date: startDate,
    end_date: endDate,
    stage: mode === 'stage',
    ...(existing && { canvas_id: existing.canvasId }),
  });

  it.each(stagingModes)(
    'releases only newly acquired canvases after staging failure (%s)',
    async (mode) => {
      const supplied = mode === 'supplied';
      const tenantId = `failed-${mode}`;
      const ctx = createMockContext({ tenantId, errors: fxGetTimeseries.errors });
      const existing = supplied ? await canvas.acquire(undefined, ctx) : undefined;
      if (existing) await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
      getTimeSeries.mockResolvedValue({ rows, startDate, endDate });
      const failure = new Error('staging failed');
      const register = vi.spyOn(provider, 'registerTable').mockRejectedValueOnce(failure);
      try {
        await expect(fxGetTimeseries.handler(stagingInput(mode, existing), ctx)).rejects.toBe(
          failure,
        );
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

  it.each(stagingModes)(
    'releases only new canvases when cancelled immediately after acquire (%s)',
    async (mode) => {
      const supplied = mode === 'supplied';
      const tenantId = `cancelled-${mode}`;
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
        await expect(fxGetTimeseries.handler(stagingInput(mode, existing), ctx)).rejects.toBe(
          reason,
        );
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

  it.each(stagingModes)(
    'cleans up cancellation while DuckDB consumes the staged rows (%s)',
    async (mode) => {
      const supplied = mode === 'supplied';
      const tenantId = `midstage-${mode}`;
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
        await expect(fxGetTimeseries.handler(stagingInput(mode, existing), ctx)).rejects.toBe(
          reason,
        );
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

  /**
   * The caller leaves in the gap after the full table registers and before the tool returns:
   * the call still rejects with the caller's reason and keeps nothing it staged — no new
   * canvas, and no series table on the caller's own canvas.
   */
  it.each(stagingModes)(
    'rejects and removes what it staged when cancelled after the table registers (%s)',
    async (mode) => {
      const supplied = mode === 'supplied';
      const tenantId = `registered-${mode}`;
      const caller = new AbortController();
      const ctx = createMockContext({
        tenantId,
        signal: caller.signal,
        errors: fxGetTimeseries.errors,
      });
      const existing = supplied
        ? await canvas.acquire(undefined, createMockContext({ tenantId }))
        : undefined;
      if (existing) await existing.registerTable('keep', [{ sentinel: 'preserved' }]);
      getTimeSeries.mockResolvedValue({ rows, startDate, endDate });
      const reason = new Error('caller left after staging');
      const registerTable = provider.registerTable.bind(provider);
      let registered = 0;
      const hook = vi.spyOn(provider, 'registerTable').mockImplementationOnce(async (...args) => {
        const handle = await registerTable(...args);
        registered++;
        caller.abort(reason);
        return handle;
      });
      try {
        await expect(fxGetTimeseries.handler(stagingInput(mode, existing), ctx)).rejects.toBe(
          reason,
        );
      } finally {
        hook.mockRestore();
      }
      expect(registered).toBe(1);
      expect(registry.countForTenant(tenantId)).toBe(supplied ? 1 : 0);
      if (existing) {
        expect((await existing.describe()).map((table) => table.name)).toEqual(['keep']);
        expect((await existing.query('SELECT * FROM keep')).rows).toEqual([
          { sentinel: 'preserved' },
        ]);
      }
    },
  );
});
