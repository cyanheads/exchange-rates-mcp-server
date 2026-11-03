#!/usr/bin/env node
/**
 * @fileoverview exchange-rates-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
import {
  fxCurrenciesResource,
  fxRatesLatestResource,
} from './mcp-server/resources/definitions/index.js';
import {
  fxConvertCurrency,
  fxDataframeDescribe,
  fxDataframeDrop,
  fxDataframeQuery,
  fxGetRate,
  fxGetRates,
  fxGetTimeseries,
  fxListCurrencies,
} from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';

// DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it.
process.env.CANVAS_PROVIDER_TYPE =
  normalizeEnv({ CANVAS_PROVIDER_TYPE: process.env.CANVAS_PROVIDER_TYPE }).CANVAS_PROVIDER_TYPE ??
  'duckdb';

/**
 * The dataframe tools are useless without a canvas to read — every call fails
 * with "DataCanvas is not enabled", which is a worse client experience than not
 * advertising them at all. Gate on the normalized environment, not
 * on `core.canvas` from `setup()`: this `tools` array is evaluated as part of
 * the `createApp()` argument, so it is fully built before `setup()` ever runs.
 */
const canvasEnabled = process.env.CANVAS_PROVIDER_TYPE !== 'none';
const canvasGate = {
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
  reason: 'DataCanvas is not configured here, so fx_get_timeseries never stages a table to query.',
} as const;

await createApp({
  name: 'exchange-rates-mcp-server',
  title: 'exchange-rates-mcp-server',

  /**
   * No handler here asks the caller for input mid-call, so nothing needs a session
   * to resume. Declared in source rather than left to `.env.example` and the
   * Dockerfile alone, which a deployment can drop; `MCP_SESSION_MODE` still wins
   * when it carries a value.
   */
  sessionMode: 'stateless',

  tools: [
    fxListCurrencies,
    fxGetRates,
    fxGetRate,
    fxConvertCurrency,
    fxGetTimeseries,
    canvasEnabled ? fxDataframeDescribe : disabledTool(fxDataframeDescribe, canvasGate),
    canvasEnabled ? fxDataframeQuery : disabledTool(fxDataframeQuery, canvasGate),
    canvasEnabled ? fxDataframeDrop : disabledTool(fxDataframeDrop, canvasGate),
  ],
  resources: [fxCurrenciesResource, fxRatesLatestResource],
  prompts: [],
  skills: 'skills',

  instructions:
    'Daily exchange rates from Frankfurter v1 (keyless, history from 1999-01-04). Responses identify Frankfurter v1 without asserting providers the response does not identify. Use fx_list_currencies for current discovery and as_of; include_retired=true adds historical codes with optional coverage outer bounds, which may contain gaps. fx://currencies stays current-only. Historical availability is validated from the requested v1 data. Cross-rates use same-date EUR legs without intermediate rounding; converted amounts retain JavaScript-number product precision. Currency values are trimmed and uppercased. Point dates accept YYYY-MM-DD or latest; range dates require YYYY-MM-DD. Time-series summaries cover all observed days before delivery, with notices for missing-leg served days. limit bounds returned observations (default/max 500); limit=0 returns summary only, and inline next_start_date requires a positive limit to advance. Long ranges stage when they exceed the preview budget regardless of limit; explicit canvas_id always stages the full series with a unique table name. Call fx_dataframe_describe, then fx_dataframe_query for SQL. With DataCanvas disabled, omit canvas_id and page inline.',

  setup(core) {
    getServerConfig();
    setCanvas(core.canvas);
  },
});
