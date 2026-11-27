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
    'Frankfurter v1 market history starts on 1999-01-04. On the official source, explicit euro predecessor codes use statutory conversion rates from adoption. Check source and rate_type for fixed and market legs. Market fixes can snap to an earlier publication date. Fully fixed series include calendar days. Use fx_list_currencies for current discovery and as_of. Set include_retired=true for statutory factors, adoption dates and available historical coverage bounds. fx://currencies lists current market currencies. Respect unit notices for historical RON and TRY. Cross-rates divide EUR legs without intermediate rounding. Point dates accept YYYY-MM-DD or latest. Range dates require YYYY-MM-DD. Series summaries cover all observations before paging or staging. Read coverage notices for missing currencies and dates. limit defaults to 500 and accepts 0 for summary only. Continue inline with next_start_date and a positive limit. Large series can stage automatically. With DataCanvas enabled, stage: true creates a new canvas, and canvas_id adds a uniquely named table to an existing canvas. Use fx_dataframe_describe before fx_dataframe_query. With DataCanvas disabled, omit stage and canvas_id and page inline.',

  setup(core) {
    getServerConfig();
    setCanvas(core.canvas);
  },
});
