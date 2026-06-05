/**
 * @fileoverview Server-specific configuration schema for exchange-rates-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

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
      'Day count above which fx_get_timeseries spills the result to DataCanvas instead of inlining.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Return the parsed, validated server config (lazy-init on first call). */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    frankfurterBaseUrl: 'FRANKFURTER_BASE_URL',
    timeseriesCanvasThresholdDays: 'FX_TIMESERIES_CANVAS_THRESHOLD_DAYS',
  });
  return _config;
}
