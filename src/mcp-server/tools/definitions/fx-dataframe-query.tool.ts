/**
 * @fileoverview fx_dataframe_query — run SQL against DataCanvas tables from fx_get_timeseries.
 * @module mcp-server/tools/definitions/fx-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type CanvasInstance,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { escapeMarkdownTableCell } from '@/utils/escape-markdown-table-cell.js';

/**
 * Rows returned when the caller sets no row_limit. Every returned row renders on both
 * response surfaces (~125 B/row serialized for the staged date/rate table), so 150 rows
 * is ~19 KB on the wire — inside the framework's 24 KB outline budget, where 200 is not.
 */
const DEFAULT_ROW_LIMIT = 150;
/** DataCanvas's own materialization ceiling — raising row_limit can never exceed an unbounded query. */
const MAX_ROW_LIMIT = 10_000;

export const fxDataframeQuery = tool('fx_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against DataCanvas tables staged by fx_get_timeseries. ' +
    'Supports aggregations, GROUP BY, window functions, and JOINs across multiple registered tables. ' +
    'Run fx_dataframe_describe first to discover table names and column schemas. ' +
    'Requires DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) — without it this tool is not listed at all ' +
    'and fx_get_timeseries returns every range inline.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by fx_get_timeseries. ' +
        'Re-run fx_get_timeseries to obtain a fresh canvas_id if this one has expired.',
    ),
    query: z
      .string()
      .describe(
        'Read-only SQL SELECT statement. Reference tables by the names returned by fx_dataframe_describe ' +
          'or the table_name field from fx_get_timeseries. ' +
          "Example: SELECT date, rate FROM fx_usd_eur WHERE date > '2024-01-01' ORDER BY date",
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROW_LIMIT)
      .default(DEFAULT_ROW_LIMIT)
      .describe(
        `Most rows to return (1–${MAX_ROW_LIMIT}, default ${DEFAULT_ROW_LIMIT}). When the query ` +
          'produces more, truncated is true — page with ORDER BY <column> LIMIT <n> OFFSET <m> in the ' +
          'SQL, or aggregate, rather than raising this toward the maximum.',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .record(z.string(), z.unknown())
          .describe('One result row — column-name → value pairs matching the SELECT columns.'),
      )
      .describe(
        `Result rows, at most row_limit (default ${DEFAULT_ROW_LIMIT}). Each key is a column name from the query.`,
      ),
    row_count: z
      .number()
      .describe(
        'Rows returned — always the length of rows. When truncated is true this equals row_limit, ' +
          'not the full result size.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the query produced more rows than row_limit and rows holds only the first ' +
          'row_limit of them. Fetch the rest with ORDER BY <column> LIMIT <n> OFFSET <m> — ORDER BY is ' +
          'required for deterministic paging — or aggregate to shrink the result.',
      ),
    canvas_id: z
      .string()
      .describe(
        'The canvas ID used — pass to a subsequent fx_dataframe_query or fx_dataframe_describe call.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when truncated is true: how many rows came back and the ORDER BY … LIMIT … OFFSET ' +
          'query shape that fetches the next page.',
      ),
  },

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not exist or has been evicted.',
      recovery: 'Re-run fx_get_timeseries to obtain a fresh canvas_id.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL references a table that is not staged on this canvas, or whose TTL expired.',
      recovery:
        'Call fx_dataframe_describe to list the staged tables, or re-run fx_get_timeseries.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL is not a SELECT, references unknown columns, or has a syntax error.',
      recovery: 'Run fx_dataframe_describe first to verify table and column names.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw serviceUnavailable('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
    }

    /** The canvas layer stamps a contract `reason` on its own throws — read that, don't match prose. */
    const reasonOf = (err: unknown): string | undefined =>
      err instanceof McpError ? (err.data as { reason?: string } | undefined)?.reason : undefined;

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      if (reasonOf(err) === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas "${input.canvas_id}" not found or has expired.`,
          {
            ...ctx.recoveryFor('canvas_not_found'),
          },
        );
      }
      throw err;
    }

    let result: QueryResult;
    try {
      result = await instance.query(input.query, {
        rowLimit: input.row_limit,
        signal: ctx.signal,
      });
    } catch (err) {
      const reason = reasonOf(err);
      if (reason === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas "${input.canvas_id}" not found or has expired.`,
          {
            ...ctx.recoveryFor('canvas_not_found'),
          },
        );
      }
      if (reason === 'missing_table') {
        throw ctx.fail('missing_table', (err as Error).message, {
          ...ctx.recoveryFor('missing_table'),
        });
      }
      /** An aborted query is a Timeout, not a rejected statement — don't blame the caller's SQL for it. */
      if (reason === 'cancelled') throw err;
      const msg = (err as Error).message ?? '';
      // Remaining SQL-gate rejections: non-SELECT statements, binder and syntax errors.
      if (
        reason !== undefined ||
        msg.includes('SELECT') ||
        msg.includes('syntax') ||
        msg.includes('does not exist') ||
        (err as { code?: string }).code === 'ValidationError'
      ) {
        throw ctx.fail('invalid_query', `SQL query rejected: ${msg}`, {
          ...ctx.recoveryFor('invalid_query'),
        });
      }
      throw err;
    }

    const truncated = result.truncated ?? false;
    ctx.log.info('Executed dataframe query', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
      truncated,
    });

    if (truncated) {
      ctx.enrich.notice(
        `The query produced more than ${input.row_limit} rows; rows holds the first ${input.row_limit}. ` +
          `For the next page re-run it with ORDER BY <column> LIMIT ${input.row_limit} OFFSET ${input.row_limit} ` +
          '(raise OFFSET by the limit each page). ORDER BY is required: without it DuckDB does not ' +
          'guarantee the same row order across pages. Aggregating or filtering shrinks the result instead.',
      );
    }

    return {
      rows: result.rows,
      row_count: result.rowCount,
      truncated,
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    const capNote = result.truncated
      ? '\n⚠️ *truncated: yes — the query produced more rows than row_limit; only these were returned.*'
      : '\n*truncated: no*';
    if (result.rows.length === 0) {
      return [
        {
          type: 'text',
          text: `Query returned 0 rows (canvas \`${result.canvas_id}\`).${capNote}`,
        },
      ];
    }
    const cols = Object.keys(result.rows[0] ?? {});
    const toRow = (cells: string[]) => `| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`;
    const table = [
      toRow(cols),
      `| ${cols.map(() => '---').join(' | ')} |`,
      ...result.rows.map((r) => toRow(cols.map((c) => String(r[c] ?? '')))),
    ].join('\n');
    return [
      {
        type: 'text',
        text: `${table}\n*${result.row_count} rows* · canvas \`${result.canvas_id}\`${capNote}`,
      },
    ];
  },
});
