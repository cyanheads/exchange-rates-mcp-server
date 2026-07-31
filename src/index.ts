#!/usr/bin/env node
/**
 * @fileoverview exchange-rates-mcp-server MCP server entry point.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  fxCurrenciesResource,
  fxRatesLatestResource,
} from './mcp-server/resources/definitions/index.js';
import {
  fxConvertCurrency,
  fxDataframeDescribe,
  fxDataframeQuery,
  fxGetRate,
  fxGetRates,
  fxGetTimeseries,
  fxListCurrencies,
} from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';

/**
 * The dataframe tools are useless without a canvas to read — every call fails
 * with "DataCanvas is not enabled", which is a worse client experience than not
 * advertising them at all. Gate on the synchronously-parsed global config, not
 * on `core.canvas` from `setup()`: this `tools` array is evaluated as part of
 * the `createApp()` argument, so it is fully built before `setup()` ever runs.
 */
const canvasEnabled = config.canvas.providerType !== 'none';
const canvasGate = {
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
  reason: 'DataCanvas is not configured here, so fx_get_timeseries never stages a table to query.',
} as const;

await createApp({
  name: 'exchange-rates-mcp-server',
  title: 'exchange-rates-mcp-server',
  tools: [
    fxListCurrencies,
    fxGetRates,
    fxGetRate,
    fxConvertCurrency,
    fxGetTimeseries,
    canvasEnabled ? fxDataframeDescribe : disabledTool(fxDataframeDescribe, canvasGate),
    canvasEnabled ? fxDataframeQuery : disabledTool(fxDataframeQuery, canvasGate),
  ],
  resources: [fxCurrenciesResource, fxRatesLatestResource],
  prompts: [],

  instructions:
    'ECB reference FX rates via Frankfurter (keyless, ~30 currencies, 1999-01-04 to present).\n' +
    '- Rates are mid-market ECB reference rates — not tradeable bid/ask.\n' +
    '- Use fx_list_currencies first to disambiguate "dollars" (USD/AUD/CAD/HKD/SGD).\n' +
    '- Cross-rates (e.g. USD→JPY) are triangulated through EUR automatically.\n' +
    '- Long time-series (>90 days) spill to DataCanvas when it is enabled (CANVAS_PROVIDER_TYPE=duckdb);\n' +
    '  use fx_dataframe_query for SQL. Without it, long ranges return inline and the dataframe tools are not listed.',

  setup(core) {
    setCanvas(core.canvas);
  },
});
