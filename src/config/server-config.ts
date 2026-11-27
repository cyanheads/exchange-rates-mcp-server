/**
 * @fileoverview Server-specific configuration schema for exchange-rates-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const CANVAS_DROP_ENV = 'FX_ENABLE_CANVAS_DROP';

/** The public v1 source whose ECB coverage and historical units are known. */
export const OFFICIAL_FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';

const ServerConfigSchema = z.object({
  frankfurterBaseUrl: z
    .string()
    .url()
    .default(OFFICIAL_FRANKFURTER_BASE_URL)
    .describe('Frankfurter API base URL. Override for local testing or self-hosted instances.'),
  timeseriesCanvasThresholdDays: z.coerce
    .number()
    .default(90)
    .describe(
      'Day count above which fx_get_timeseries considers automatic DataCanvas staging; without canvas_id or stage: true, series that fit the preview remain inline.',
    ),
  enableCanvasDrop: z
    .stringbool()
    .default(false)
    .describe('Enable fx_dataframe_drop, which destructively removes a staged DataCanvas table.'),
});

const CanvasDropGateSchema = z.object({
  enableCanvasDrop: ServerConfigSchema.shape.enableCanvasDrop.catch(false),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Read only the registration flag; setup validates invalid values through the startup boundary. */
export function isCanvasDropEnabled(): boolean {
  return parseEnvConfig(CanvasDropGateSchema, { enableCanvasDrop: CANVAS_DROP_ENV })
    .enableCanvasDrop;
}

/** Return the parsed, validated server config (lazy-init on first call). */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    frankfurterBaseUrl: 'FRANKFURTER_BASE_URL',
    timeseriesCanvasThresholdDays: 'FX_TIMESERIES_CANVAS_THRESHOLD_DAYS',
    enableCanvasDrop: CANVAS_DROP_ENV,
  });
  return _config;
}
