/**
 * @fileoverview Tests for fx_dataframe_query tool.
 * @module tests/tools/fx-dataframe-query.tool.test
 */

import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
        statementType: 'DROP',
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
    ).rejects.toMatchObject({
      data: {
        reason: 'missing_table',
        recovery: { hint: expect.stringContaining('fx_dataframe_describe') },
      },
    });
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
    ['a value above the 10,000 canvas ceiling', 10_001],
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
