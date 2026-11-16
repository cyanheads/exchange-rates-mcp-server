/**
 * @fileoverview Tests for fx_dataframe_query tool.
 * @module tests/tools/fx-dataframe-query.tool.test
 */

import { tmpdir } from 'node:os';
import {
  CanvasRegistry,
  createCanvasService,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { config, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fxDataframeQuery } from '@/mcp-server/tools/definitions/fx-dataframe-query.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';

const mockQuery = vi.fn();
const mockAcquire = vi.fn();
const mockGetCanvas = vi.spyOn(canvasModule, 'getCanvas');

/** Parsed input, as production hands it to the handler — row_limit carries its default. */
const queryInput = (query: string, canvas_id = 'abc1234567') =>
  fxDataframeQuery.input.parse({ canvas_id, query });

describe('fx_dataframe_query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when canvas not enabled', async () => {
    mockGetCanvas.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler(queryInput('SELECT * FROM fx_usd_eur'), ctx),
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
      queryInput('SELECT date, rate FROM fx_usd_eur ORDER BY date'),
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
    const result = await fxDataframeQuery.handler(queryInput('SELECT * FROM fx_usd_eur'), ctx);

    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(10_000);
  });

  /** Mirrors the registry's own throw — the handler classifies on `data.reason`, not the message. */
  it('throws canvas_not_found for missing canvas', async () => {
    mockAcquire.mockRejectedValue(
      notFound('Canvas not found or expired.', {
        canvasId: 'expired123',
        reason: 'canvas_not_found',
      }),
    );
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler(queryInput('SELECT * FROM fx_usd_eur', 'expired123'), ctx),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
  });

  it('throws invalid_query for non-SELECT SQL', async () => {
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockQuery.mockRejectedValue(
      validationError('Canvas query must be SELECT.', {
        reason: 'non_select_statement',
        statementType: 'UNKNOWN',
      }),
    );
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler(queryInput('DROP TABLE fx_usd_eur'), ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
  });

  /**
   * The canvas layer distinguishes an unstaged table from bad SQL — an unknown
   * table is `missing_table` (re-stage), not `invalid_query` (rewrite the SQL).
   */
  it('throws missing_table when the SQL references an unstaged table', async () => {
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockQuery.mockRejectedValue(
      notFound('Canvas table "fx_nonexistent" does not exist.', {
        reason: 'missing_table',
        tableName: 'fx_nonexistent',
      }),
    );
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler(queryInput('SELECT * FROM fx_nonexistent'), ctx),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
  });

  it('throws invalid_query for an unclassified binder error on SELECT-shaped SQL', async () => {
    mockAcquire.mockResolvedValue({
      canvasId: 'abc1234567',
      isNew: false,
      expiresAt: '2026-06-05T00:00:00.000Z',
      query: mockQuery,
    });
    mockQuery.mockRejectedValue(new Error('Binder Error: column "rat" does not exist'));
    mockGetCanvas.mockReturnValue({
      acquire: mockAcquire,
    } as unknown as ReturnType<typeof canvasModule.getCanvas>);

    const ctx = createMockContext({ errors: fxDataframeQuery.errors });
    await expect(
      fxDataframeQuery.handler(queryInput('SELECT rat FROM fx_usd_eur'), ctx),
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

  it('format discloses truncation', () => {
    const result = {
      rows: Array.from({ length: 50 }, (_, i) => ({ date: `2024-06-${i + 1}`, rate: 0.9 })),
      row_count: 50,
      truncated: true,
      canvas_id: 'abc1234567',
    };
    const content = fxDataframeQuery.format!(result);
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('truncated: yes');
    expect(text).toContain('*50 rows*');
  });

  it('format renders NULL as an empty cell and numbers and dates as plain text', () => {
    const content = fxDataframeQuery.format!({
      rows: [{ date: '2024-06-03', rate: -0.91234, note: null, n: 1e-7 }],
      row_count: 1,
      truncated: false,
      canvas_id: 'abc1234567',
    });
    const text = (content[0] as { text: string }).text;
    expect(text).toContain('| 2024-06-03 | -0.91234 |  | 1e-7 |');
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

/** Table data lines in the rendered text — every `| … |` line minus the header and separator. */
const tableDataLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2);

/** Stages a canvas whose query() resolves to `result`, so runToolContract drives the real pipeline. */
const stageQueryResult = (result: {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated?: boolean;
}) => {
  mockQuery.mockResolvedValue({ columns: Object.keys(result.rows[0] ?? {}), ...result });
  mockAcquire.mockResolvedValue({
    canvasId: 'abc1234567',
    isNew: false,
    expiresAt: '2026-06-05T00:00:00.000Z',
    query: mockQuery,
  });
  mockGetCanvas.mockReturnValue({
    acquire: mockAcquire,
  } as unknown as ReturnType<typeof canvasModule.getCanvas>);
};

const seriesRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    rate: 1.1 + i / 10_000,
  }));

describe('fx_dataframe_query row_limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clamps an over-cap positive integer and composes both notices', async () => {
    stageQueryResult({ rows: [{ rate: 1 }], rowCount: 1, truncated: true });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: 'SELECT 1',
      row_limit: 10001,
    });
    expect(result.isError).toBeFalsy();
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT 1',
      expect.objectContaining({ rowLimit: 10000 }),
    );
    for (const surface of [
      JSON.stringify(result.structuredContent),
      JSON.stringify(result.content),
    ]) {
      expect(surface).toContain('10001');
      expect(surface).toContain('10000');
      expect(surface).toContain('OFFSET 10000');
    }
  });

  it('defaults row_limit to a bound below 200 and passes it to the canvas query', async () => {
    stageQueryResult({ rows: seriesRows(2), rowCount: 2 });
    const input = queryInput('SELECT 1');

    expect(input.row_limit).toBeGreaterThan(0);
    expect(input.row_limit).toBeLessThan(200);

    await fxDataframeQuery.handler(input, createMockContext({ errors: fxDataframeQuery.errors }));
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1', {
      rowLimit: input.row_limit,
      signal: expect.any(AbortSignal),
    });
  });

  it('passes an explicit row_limit through to the canvas query', async () => {
    stageQueryResult({ rows: seriesRows(2), rowCount: 2 });
    const input = fxDataframeQuery.input.parse({
      canvas_id: 'abc1234567',
      query: 'SELECT 1',
      row_limit: 7,
    });

    await fxDataframeQuery.handler(input, createMockContext({ errors: fxDataframeQuery.errors }));
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ rowLimit: 7 }));
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 2.5],
    ['a nonnumeric value', '10001'],
  ])('rejects row_limit of %s at the schema', (_label, row_limit) => {
    const parsed = fxDataframeQuery.input.safeParse({
      canvas_id: 'abc1234567',
      query: 'SELECT 1',
      row_limit,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts row_limit at the 10,000 canvas ceiling', () => {
    const parsed = fxDataframeQuery.input.safeParse({
      canvas_id: 'abc1234567',
      query: 'SELECT 1',
      row_limit: 10_000,
    });
    expect(parsed.success).toBe(true);
  });

  it('below the limit, both surfaces carry every row and report no truncation', async () => {
    stageQueryResult({ rows: seriesRows(10), rowCount: 10 });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: 'SELECT * FROM fx_usd_eur ORDER BY date',
    });
    const structured = result.structuredContent as {
      rows: unknown[];
      row_count: number;
      truncated: boolean;
      notice?: string;
    };
    const text = (result.content[0] as { text: string }).text;

    expect(structured.rows).toHaveLength(10);
    expect(structured.row_count).toBe(10);
    expect(structured.truncated).toBe(false);
    expect(structured.notice).toBeUndefined();
    expect(tableDataLines(text)).toHaveLength(10);
  });

  it('content applies no independent row slice of its own', async () => {
    stageQueryResult({ rows: seriesRows(51), rowCount: 51 });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: 'SELECT * FROM fx_usd_eur ORDER BY date LIMIT 51',
    });
    const text = (result.content[0] as { text: string }).text;

    expect((result.structuredContent as { rows: unknown[] }).rows).toHaveLength(51);
    expect(tableDataLines(text)).toHaveLength(51);
  });

  it('at the limit exactly, content renders every row structuredContent carries', async () => {
    stageQueryResult({ rows: seriesRows(51), rowCount: 51 });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: 'SELECT * FROM fx_usd_eur ORDER BY date LIMIT 51',
      row_limit: 51,
    });
    const structured = result.structuredContent as { rows: unknown[]; row_count: number };
    const text = (result.content[0] as { text: string }).text;

    expect(structured.row_count).toBe(51);
    expect(structured.rows).toHaveLength(51);
    expect(tableDataLines(text)).toHaveLength(51);
    expect(text).toContain(`| ${seriesRows(51).at(-1)!.date} |`);
  });

  it('above the limit, both surfaces name the ORDER BY … LIMIT … OFFSET retrieval pattern', async () => {
    stageQueryResult({ rows: seriesRows(5), rowCount: 5, truncated: true });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: 'SELECT * FROM fx_usd_eur',
      row_limit: 5,
    });
    const structured = result.structuredContent as {
      rows: unknown[];
      row_count: number;
      truncated: boolean;
      notice?: string;
    };
    const text = result.content.map((block) => (block as { text: string }).text).join('\n');

    expect(structured.rows).toHaveLength(5);
    expect(structured.row_count).toBe(5);
    expect(structured.truncated).toBe(true);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('ORDER BY');
      expect(surface).toContain('LIMIT 5 OFFSET 5');
      expect(surface).toMatch(/ORDER BY is required/);
    }
    expect(tableDataLines(text)).toHaveLength(5);
  });

  it('an empty result agrees on 0 rows across both surfaces', async () => {
    stageQueryResult({ rows: [], rowCount: 0 });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: 'SELECT * FROM fx_usd_eur WHERE rate < 0',
    });
    const structured = result.structuredContent as { rows: unknown[]; row_count: number };
    const text = (result.content[0] as { text: string }).text;

    expect(structured.rows).toHaveLength(0);
    expect(structured.row_count).toBe(0);
    expect(text).toContain('0 rows');
  });
});

describe('fx_dataframe_query cell escaping', () => {
  /** Splits a rendered row on its unescaped cell delimiters. */
  const cellsOf = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/);

  const render = (row: Record<string, unknown>) =>
    (
      fxDataframeQuery.format!({
        rows: [row],
        row_count: 1,
        truncated: false,
        canvas_id: 'abc1234567',
      })[0] as { text: string }
    ).text;

  it('keeps a pipe inside one cell so the row still has one cell per header', () => {
    const text = render({ note: 'a|b', html: '<tag>', md: '*bold*' });
    const [header, , data] = text.split('\n').filter((line) => line.startsWith('|'));

    expect(cellsOf(header!)).toHaveLength(3);
    expect(cellsOf(data!)).toHaveLength(3);
    expect(data).toContain('a\\|b');
  });

  it.each([
    ['angle brackets', '<tag>', '\\<tag\\>'],
    ['emphasis', '*bold* _it_', '\\*bold\\* \\_it\\_'],
    ['a backslash', 'back\\slash', 'back\\\\slash'],
    ['a Markdown link', '[link](http://x)', '\\[link\\](http://x)'],
    ['inline code', '`code`', '\\`code\\`'],
  ])('renders %s literally', (_label, value, escaped) => {
    const [, , data] = render({ v: value })
      .split('\n')
      .filter((line) => line.startsWith('|'));
    expect(data).toBe(`| ${escaped} |`);
  });

  it('keeps an embedded line break inside the same table row', () => {
    const text = render({ v: 'line1\nline2', w: 'crlf\r\nend' });
    const tableLines = text.split('\n').filter((line) => line.startsWith('|'));

    expect(tableLines).toHaveLength(3);
    expect(tableLines[2]).toBe('| line1<br>line2 | crlf<br>end |');
  });

  it('leaves structuredContent carrying the raw values', async () => {
    const raw = { note: 'a|b', html: '<tag>', text: 'line1\nline2' };
    stageQueryResult({ rows: [raw], rowCount: 1 });
    const result = await runToolContract(fxDataframeQuery, {
      canvas_id: 'abc1234567',
      query: "SELECT 'a|b' AS note",
    });
    expect((result.structuredContent as { rows: unknown[] }).rows).toEqual([raw]);
  });
});

/**
 * Every refusal the real SQL gate and engine raise keeps `invalid_query`, but its recovery is
 * the gate's own hint for that refusal — a denied function, a file, a non-SELECT, the engine's
 * error class — followed by the declared recovery, which reads true for all of them.
 */
describe('fx_dataframe_query refusals on a DuckDB canvas', () => {
  const tenantId = 'refusals';
  const provider = new DuckdbProvider({
    defaultRowLimit: 10_000,
    exportRootPath: tmpdir(),
    memoryLimitMb: 256,
    schemaSniffRows: 100,
    tempRootPath: tmpdir(),
  });
  const canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
  );
  const DECLARED = 'fx_dataframe_describe lists the staged tables and their columns.';
  let canvasId: string;

  beforeAll(async () => {
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId }));
    await instance.registerTable('fx_usd_eur', [
      { date: '2024-06-03', rate: 0.91, base_currency: 'USD', quote_currency: 'EUR' },
    ]);
    canvasId = instance.canvasId;
  });

  beforeEach(() => {
    mockGetCanvas.mockReturnValue(canvas);
  });

  afterAll(async () => {
    await canvas.shutdown(createMockContext());
  });

  const deniedHint =
    'Remove the function the message names — only the staged tables are queryable.';
  it.each([
    {
      name: 'a quoted pragma_version in an unreferenced CTE',
      query: 'WITH unused AS (SELECT * FROM "pragma_version"()) SELECT * FROM fx_usd_eur',
      message:
        'Canvas query references disallowed table function: pragma_version. PRAGMA metadata functions are not permitted.',
      hint: deniedHint,
    },
    {
      name: 'a file reader',
      query: "SELECT * FROM read_csv('/etc/hosts')",
      message:
        'Canvas query references disallowed table function: read_csv. File-reading and external-data functions are not permitted.',
      hint: deniedHint,
    },
    {
      name: 'a file path',
      query: "SELECT * FROM '/etc/hosts'",
      message: 'Canvas SQL rejected: "/etc/hosts" names a file, not a staged table.',
      hint: "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
    },
    {
      name: 'a non-SELECT statement',
      query: 'DROP TABLE fx_usd_eur',
      message: 'Canvas query must be SELECT.',
      hint: 'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
    },
    {
      name: 'a PIVOT without an IN list',
      query: 'PIVOT fx_usd_eur ON base_currency USING sum(rate)',
      message: 'Canvas query must be SELECT.',
      hint: 'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
    },
    {
      name: 'two statements',
      query: 'SELECT 1; SELECT 2',
      message: 'Canvas query must contain exactly one SQL statement.',
      hint: 'Send exactly one SELECT statement; split multi-statement SQL into separate calls.',
    },
    {
      name: 'a syntax error',
      query: 'SELECT * FROM fx_usd_eur WHERE',
      message:
        'Canvas query failed to prepare: Failed to extract statements: Parser Error: syntax error at end of input',
      hint: 'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.',
    },
    {
      name: 'an unknown column (binder error)',
      query: 'SELECT rat FROM fx_usd_eur',
      message:
        'Canvas query failed to prepare: Binder Error: Referenced column "rat" not found in FROM clause!',
      hint: "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.",
    },
    {
      name: 'a value the engine cannot convert (execution error)',
      query: 'SELECT CAST(date AS INTEGER) FROM fx_usd_eur',
      message:
        "Canvas query failed: Conversion Error: Could not convert string '2024-06-03' to INT32",
      hint: 'Wrap the cast in TRY_CAST, or filter out the rows the message names before converting them.',
    },
  ])('$name keeps invalid_query and forwards the gate hint on both surfaces', async (refusal) => {
    const result = await runToolContract(
      fxDataframeQuery,
      { canvas_id: canvasId, query: refusal.query },
      { context: { tenantId } },
    );
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      }
    ).error;
    const hint = `${refusal.hint} ${DECLARED}`;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message.startsWith(`SQL query rejected: ${refusal.message}`)).toBe(true);
    expect(error.data).toMatchObject({ reason: 'invalid_query', recovery: { hint } });
    const text = result.content.map((block) => (block as { text: string }).text).join('\n');
    expect(text).toContain(hint);
    expect(text).not.toContain('verify table and column names');
  });

  /**
   * A query its caller cancelled fails as the canvas cancellation (Timeout, reason `cancelled`),
   * never as a rejected statement blaming the caller's SQL.
   */
  it('rethrows a cancelled query as the canvas cancellation, never invalid_query', async () => {
    const caller = new AbortController();
    const reason = new Error('caller left mid-query');
    caller.abort(reason);
    const ctx = createMockContext({
      tenantId,
      signal: caller.signal,
      errors: fxDataframeQuery.errors,
    });
    await expect(
      fxDataframeQuery.handler(queryInput('SELECT * FROM fx_usd_eur', canvasId), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'Canvas query was cancelled.',
      data: { reason: 'cancelled' },
      cause: reason,
    });
    const wire = await runToolContract(
      fxDataframeQuery,
      { canvas_id: canvasId, query: 'SELECT * FROM fx_usd_eur' },
      { context: { tenantId, signal: caller.signal } },
    );
    expect(wire.isError).toBe(true);
    expect((wire.structuredContent as { error: object }).error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'Canvas query was cancelled.',
    });
    const text = wire.content.map((block) => (block as { text: string }).text).join('\n');
    expect(text).toContain('Canvas query was cancelled.');
    expect(text).not.toContain('SQL query rejected');
  });
});

/**
 * A deployment that lowers CANVAS_DEFAULT_ROW_LIMIT gets a provider that refuses any larger
 * rowLimit. The tool clamps row_limit — the default 150 included — to that configured cap,
 * so the call answers with a clamp notice instead of failing. The canvas is built from the
 * same framework config the server builds it from.
 */
describe('fx_dataframe_query under a lowered canvas row cap', () => {
  const tenantId = 'row-cap';
  const ROW_CAP = 100;
  let canvas: DataCanvas;
  let canvasId: string;

  beforeAll(async () => {
    resetConfig({
      CANVAS_PROVIDER_TYPE: 'duckdb',
      CANVAS_DEFAULT_ROW_LIMIT: String(ROW_CAP),
      CANVAS_EXPORT_PATH: tmpdir(),
      CANVAS_TEMP_PATH: tmpdir(),
      CANVAS_SWEEPER_INTERVAL_MS: '0',
    });
    canvas = createCanvasService(config)!;
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId }));
    await instance.registerTable('fx_usd_eur', seriesRows(120));
    canvasId = instance.canvasId;
  });

  beforeEach(() => {
    mockGetCanvas.mockReturnValue(canvas);
  });

  afterAll(async () => {
    await canvas.shutdown(createMockContext());
    resetConfig();
  });

  const run = (args: Record<string, unknown>) =>
    runToolContract(fxDataframeQuery, { canvas_id: canvasId, ...args } as never, {
      context: { tenantId },
    });
  const surfacesOf = (result: Awaited<ReturnType<typeof run>>) => {
    const structured = result.structuredContent as {
      rows: unknown[];
      row_count: number;
      truncated: boolean;
      notice?: string;
    };
    const text = result.content.map((block) => (block as { text: string }).text).join('\n');
    return { structured, text };
  };

  it('clamps an over-cap row_limit to the configured cap and still pages', async () => {
    const result = await run({ query: 'SELECT * FROM fx_usd_eur ORDER BY date', row_limit: 500 });
    expect(result.isError).toBeFalsy();
    const { structured, text } = surfacesOf(result);
    expect(structured).toMatchObject({ row_count: ROW_CAP, truncated: true });
    expect(structured.rows).toHaveLength(ROW_CAP);
    expect(tableDataLines(text)).toHaveLength(ROW_CAP);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain("row_limit 500 was clamped to this server's row cap of 100.");
      expect(surface).not.toContain('Requested');
      expect(surface).toContain('LIMIT 100 OFFSET 100');
    }
  });

  it('clamps the default row_limit to a configured cap below it', async () => {
    const result = await run({ query: 'SELECT count(*)::INTEGER AS n FROM fx_usd_eur' });
    expect(result.isError).toBeFalsy();
    const { structured, text } = surfacesOf(result);
    expect(structured).toMatchObject({ rows: [{ n: 120 }], row_count: 1, truncated: false });
    expect(structured.notice).toBe("row_limit 150 was clamped to this server's row cap of 100.");
    expect(text).toContain("row_limit 150 was clamped to this server's row cap of 100.");
    expect(text).not.toContain('Requested');
  });

  it('passes a row_limit at the configured cap through without a notice', async () => {
    const result = await run({ query: 'SELECT * FROM fx_usd_eur', row_limit: ROW_CAP });
    const { structured, text } = surfacesOf(result);
    expect(structured).toMatchObject({ row_count: ROW_CAP, truncated: true });
    expect(structured.notice).not.toContain('clamped');
    expect(text).not.toContain('clamped');
  });
});
