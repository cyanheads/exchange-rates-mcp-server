/**
 * @fileoverview fx_dataframe_drop — remove one staged table or view from a DataCanvas.
 * @module mcp-server/tools/definitions/fx-dataframe-drop.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const fxDataframeDropDefinition = tool('fx_dataframe_drop', {
  description:
    'Permanently remove one table or view staged on a DataCanvas by fx_get_timeseries. ' +
    'This deletes staged analytical data only; ECB rate data is never affected and the same ' +
    'series can be re-staged by re-running fx_get_timeseries. ' +
    'Call fx_dataframe_describe first to get the exact table name. ' +
    'Disabled unless the deployment sets FX_ENABLE_CANVAS_DROP=true.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
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
    table_name: z
      .string()
      .describe('Exact table or view name as returned by fx_dataframe_describe.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('The canvas ID the table or view was removed from.'),
    table_name: z.string().describe('The requested table or view name.'),
    dropped: z
      .boolean()
      .describe('True when the table or view existed and was removed; false when it was absent.'),
  }),

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not exist or has been evicted.',
      recovery: 'Re-run fx_get_timeseries to obtain a fresh canvas_id.',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      when: 'DataCanvas is not configured on this deployment.',
      recovery:
        'Self-hosted operators can enable DataCanvas by setting CANVAS_PROVIDER_TYPE=duckdb.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_unavailable',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use fx_dataframe_drop.',
        { ...ctx.recoveryFor('canvas_unavailable') },
      );
    }

    let dropped: boolean;
    try {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      dropped = await instance.drop(input.table_name);
    } catch (err) {
      /** The canvas layer stamps a contract `reason` on its own throws — read that, don't match prose. */
      const reason =
        err instanceof McpError ? (err.data as { reason?: string } | undefined)?.reason : undefined;
      if (reason === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas "${input.canvas_id}" not found or has expired.`,
          { ...ctx.recoveryFor('canvas_not_found') },
        );
      }
      throw err;
    }

    ctx.log.info('Dropped canvas table', {
      canvasId: input.canvas_id,
      tableName: input.table_name,
      dropped,
    });

    return { canvas_id: input.canvas_id, table_name: input.table_name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped \`${result.table_name}\` from canvas \`${result.canvas_id}\`.`
        : `No table or view named \`${result.table_name}\` exists on canvas \`${result.canvas_id}\` — nothing to drop.`,
    },
  ],
});

/**
 * Deletion is the one destructive verb on the canvas surface, so it ships
 * disabled: the tool stays visible in the manifest carrying its enable hint,
 * and answers uncallable until an operator opts in.
 */
export const fxDataframeDrop = getServerConfig().enableCanvasDrop
  ? fxDataframeDropDefinition
  : disabledTool(fxDataframeDropDefinition, {
      reason: 'DataCanvas table deletion is disabled on this deployment.',
      hint: 'FX_ENABLE_CANVAS_DROP=true',
    });
