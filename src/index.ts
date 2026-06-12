#!/usr/bin/env node
/**
 * @fileoverview exchange-rates-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
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

await createApp({
  name: 'exchange-rates-mcp-server',
  title: 'exchange-rates-mcp-server',
  tools: [
    fxListCurrencies,
    fxGetRates,
    fxGetRate,
    fxConvertCurrency,
    fxGetTimeseries,
    fxDataframeDescribe,
    fxDataframeQuery,
  ],
  resources: [fxCurrenciesResource, fxRatesLatestResource],
  prompts: [],

  instructions:
    'ECB reference FX rates via Frankfurter (keyless, ~30 currencies, 1999-01-04 to present).\n' +
    '- Rates are mid-market ECB reference rates — not tradeable bid/ask.\n' +
    '- Use fx_list_currencies first to disambiguate "dollars" (USD/AUD/CAD/HKD/SGD).\n' +
    '- Cross-rates (e.g. USD→JPY) are triangulated through EUR automatically.\n' +
    '- Long time-series (>90 days) spill to DataCanvas; use fx_dataframe_query for SQL.',

  setup(core) {
    setCanvas(core.canvas);
  },
});
