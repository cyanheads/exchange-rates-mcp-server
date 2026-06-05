/**
 * @fileoverview fx_dataframe_describe — list tables and columns on a DataCanvas.
 * @module mcp-server/tools/definitions/fx-dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const fxDataframeDescribe = tool('fx_dataframe_describe', {
  description:
    'List tables and columns staged on a DataCanvas from a prior fx_get_timeseries call. ' +
    'Required first step before fx_dataframe_query — use it to discover table names and column schemas.',
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
  }),
  output: z.object({
    canvas_id: z.string().describe('The canvas ID echoed back — use this in fx_dataframe_query.'),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table or view name.'),
            kind: z.string().describe('Either "table" or "view".'),
            row_count: z.number().describe('Number of rows in this table or view.'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('DuckDB column type (e.g. VARCHAR, DOUBLE, BIGINT).'),
                    nullable: z.boolean().describe('Whether the column accepts NULL values.'),
                  })
                  .describe('A single column descriptor.'),
              )
              .describe('Column schema for this table.'),
          })
          .describe('A single table or view staged on the canvas.'),
      )
      .describe('All tables and views currently staged on this canvas.'),
    expires_at: z.string().describe('ISO 8601 timestamp when this canvas will be evicted.'),
  }),

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not exist or has been evicted.',
      recovery: 'Re-run fx_get_timeseries to obtain a fresh canvas_id.',
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

    const tableInfos = await instance.describe();

    ctx.log.info('Described canvas', {
      canvasId: input.canvas_id,
      tableCount: tableInfos.length,
    });

    const tables = tableInfos.map((t) => ({
      name: t.name,
      kind: t.kind,
      row_count: t.rowCount,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable ?? false,
      })),
    }));

    return {
      canvas_id: input.canvas_id,
      tables,
      expires_at: instance.expiresAt,
    };
  },

  format: (result) => {
    if (result.tables.length === 0) {
      return [{ type: 'text', text: `Canvas \`${result.canvas_id}\` has no staged tables.` }];
    }
    const lines: string[] = [`**Canvas \`${result.canvas_id}\`** — expires ${result.expires_at}\n`];
    for (const t of result.tables) {
      lines.push(`### ${t.name} (${t.kind}, ${t.row_count} rows)`);
      for (const col of t.columns) {
        lines.push(`- \`${col.name}\` ${col.type}${col.nullable ? ' (nullable)' : ''}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
