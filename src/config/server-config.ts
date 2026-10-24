/**
 * @fileoverview Server-specific configuration schema for exchange-rates-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  frankfurterBaseUrl: z
    .string()
    .url()
    .default('https://api.frankfurter.dev/v1')
    .describe('Frankfurter API base URL. Override for local testing or self-hosted instances.'),
  timeseriesCanvasThresholdDays: z.coerce
    .number()
    .default(90)
    .describe(
      'Day count above which fx_get_timeseries considers automatic DataCanvas staging; without canvas_id, series that fit the preview remain inline.',
    ),
  enableCanvasDrop: z
    .stringbool()
    .default(false)
    .describe('Enable fx_dataframe_drop, which destructively removes a staged DataCanvas table.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Read only the registration flag; setup validates invalid values through the startup boundary. */
export function isCanvasDropEnabled(): boolean {
  const flag = ServerConfigSchema.shape.enableCanvasDrop.safeParse(
    normalizeEnv({ FX_ENABLE_CANVAS_DROP: process.env.FX_ENABLE_CANVAS_DROP })
      .FX_ENABLE_CANVAS_DROP,
  );
  return flag.success && flag.data;
}

/** Return the parsed, validated server config (lazy-init on first call). */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    frankfurterBaseUrl: 'FRANKFURTER_BASE_URL',
    timeseriesCanvasThresholdDays: 'FX_TIMESERIES_CANVAS_THRESHOLD_DAYS',
    enableCanvasDrop: 'FX_ENABLE_CANVAS_DROP',
  });
  return _config;
}
