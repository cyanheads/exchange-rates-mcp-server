/**
 * @fileoverview fx_dataframe_query — run SQL against DataCanvas tables from fx_get_timeseries.
 * @module mcp-server/tools/definitions/fx-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const fxDataframeQuery = tool('fx_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against DataCanvas tables staged by fx_get_timeseries. ' +
    'Supports aggregations, GROUP BY, window functions, and JOINs across multiple registered tables. ' +
    'Run fx_dataframe_describe first to discover table names and column schemas.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: z
      .string()
      .describe(
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
  }),
  output: z.object({
    rows: z
      .array(
        z
          .record(z.string(), z.unknown())
          .describe('One result row — column-name → value pairs matching the SELECT columns.'),
      )
      .describe(
        'Result rows, capped at the canvas row limit (default 10 000). Each key is a column name from the query.',
      ),
    row_count: z
      .number()
      .describe('Total rows in the full result set before the row cap was applied.'),
    canvas_id: z
      .string()
      .describe(
        'The canvas ID used — pass to a subsequent fx_dataframe_query or fx_dataframe_describe call.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not exist or has been evicted.',
      recovery: 'Re-run fx_get_timeseries to obtain a fresh canvas_id.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'SQL is not a SELECT, references unknown tables/columns, or has a syntax error.',
      recovery: 'Run fx_dataframe_describe first to verify table and column names.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw serviceUnavailable('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
    }

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('not found') || msg.includes('NotFound')) {
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
      result = await instance.query(input.query, { signal: ctx.signal });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // ValidationError from the four-layer gate, or DuckDB parse errors
      if (
        msg.includes('ValidationError') ||
        msg.includes('SELECT') ||
        msg.includes('syntax') ||
        msg.includes('not found') ||
        msg.includes('does not exist') ||
        msg.includes('read_csv') ||
        msg.includes('register_as_clash') ||
        (err as { code?: string }).code === 'ValidationError'
      ) {
        throw ctx.fail('invalid_query', `SQL query rejected: ${msg}`, {
          ...ctx.recoveryFor('invalid_query'),
        });
      }
      throw err;
    }

    ctx.log.info('Executed dataframe query', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
    });

    return {
      rows: result.rows,
      row_count: result.rowCount,
      canvas_id: input.canvas_id,
    };
  },

  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: `Query returned 0 rows (canvas \`${result.canvas_id}\`).` }];
    }
    const cols = Object.keys(result.rows[0] ?? {});
    const header = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const rowLines = result.rows
      .slice(0, 50)
      .map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);
    const note =
      result.row_count > 50
        ? `\n*Showing 50 of ${result.row_count} rows*`
        : `\n*${result.row_count} rows*`;
    return [
      {
        type: 'text',
        text: [header, sep, ...rowLines].join('\n') + note + ` · canvas \`${result.canvas_id}\``,
      },
    ];
  },
});
