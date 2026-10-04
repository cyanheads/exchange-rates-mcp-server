/**
 * @fileoverview Every declared failure reason a tool handler raises reaches the wire with
 * its declared recovery hint, on both consumption paths. Driven through `runToolContract`,
 * which applies the framework's declared-hint fill exactly as production does, so the hint
 * is asserted where a client reads it — `structuredContent.error.data.recovery.hint` and
 * the `content[]` text — rather than on the handler's raw throw. Sibling data the throw
 * site attaches (the offending `field`) must survive alongside the hint.
 * @module tests/tools/fx-recovery-hints.test
 */

import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fxConvertCurrency } from '@/mcp-server/tools/definitions/fx-convert-currency.tool.js';
import { fxDataframeDescribe } from '@/mcp-server/tools/definitions/fx-dataframe-describe.tool.js';
import { fxDataframeDrop } from '@/mcp-server/tools/definitions/fx-dataframe-drop.tool.js';
import { fxDataframeQuery } from '@/mcp-server/tools/definitions/fx-dataframe-query.tool.js';
import { fxGetRate } from '@/mcp-server/tools/definitions/fx-get-rate.tool.js';
import { fxGetRates } from '@/mcp-server/tools/definitions/fx-get-rates.tool.js';
import { fxGetTimeseries } from '@/mcp-server/tools/definitions/fx-get-timeseries.tool.js';
import * as canvasModule from '@/services/canvas/canvas-accessor.js';
import { unsupportedCurrency, upstreamNoData } from '@/services/frankfurter/errors.js';
import * as serviceModule from '@/services/frankfurter/frankfurter-service.js';

const mockGetRate = vi.fn();
const mockGetRates = vi.fn();
const mockGetTimeSeries = vi.fn();
vi.spyOn(serviceModule, 'getFrankfurterService').mockReturnValue({
  getRate: mockGetRate,
  getRates: mockGetRates,
  getTimeSeries: mockGetTimeSeries,
} as unknown as ReturnType<typeof serviceModule.getFrankfurterService>);

const mockAcquire = vi.fn();
const mockQuery = vi.fn();
const mockDrop = vi.fn();
const mockGetCanvas = vi.spyOn(canvasModule, 'getCanvas');

const ACCEPTED = ['EUR', 'GBP', 'USD'];
const expiredCanvas = () =>
  notFound('Canvas not found or expired.', { canvasId: 'abc1234567', reason: 'canvas_not_found' });

/** Wire `getCanvas()` to a live instance whose query/drop are the mocks above. */
const withCanvas = () => {
  mockAcquire.mockResolvedValue({
    canvasId: 'abc1234567',
    isNew: false,
    expiresAt: '2026-06-05T00:00:00.000Z',
    query: mockQuery,
    drop: mockDrop,
  });
  mockGetCanvas.mockReturnValue({
    acquire: mockAcquire,
  } as unknown as ReturnType<typeof canvasModule.getCanvas>);
};

interface HintCase {
  /** Sibling data the throw site attaches beside the hint. */
  data?: Record<string, unknown>;
  input: Record<string, unknown>;
  name: string;
  reason: string;
  setup?: () => void;
  tool: { errors?: readonly { reason: string; recovery: string }[]; name: string };
}

const rateWindow = { start_date: '2024-06-03', end_date: '2024-06-04' };

/** The four failures the three point-in-time rate tools share. */
const pointInTimeCases = (
  tool: HintCase['tool'],
  pair: Record<string, unknown>,
  fetch: ReturnType<typeof vi.fn>,
): HintCase[] => [
  {
    name: 'a malformed date',
    tool,
    reason: 'invalid_date_format',
    input: { ...pair, date: '2024-6-1' },
    data: { field: 'date' },
  },
  {
    name: 'a date before the ECB epoch',
    tool,
    reason: 'date_out_of_range',
    input: { ...pair, date: '1998-12-31' },
  },
  {
    name: 'a future date',
    tool,
    reason: 'date_out_of_range',
    input: { ...pair, date: '2999-01-01' },
  },
  {
    name: 'an unsupported currency',
    tool,
    reason: 'unsupported_currency',
    input: pair,
    data: { field: 'base_currency', rejected_codes: ['XYZ'] },
    setup: () => fetch.mockRejectedValue(unsupportedCurrency('base_currency', ['XYZ'], ACCEPTED)),
  },
  {
    name: 'a date the ECB published nothing for',
    tool,
    reason: 'upstream_no_data',
    input: pair,
    setup: () => fetch.mockRejectedValue(upstreamNoData()),
  },
];

const cases: HintCase[] = [
  ...pointInTimeCases(fxGetRate, { base_currency: 'XYZ', quote_currency: 'EUR' }, mockGetRate),
  ...pointInTimeCases(fxGetRates, { base_currency: 'XYZ' }, mockGetRates),
  ...pointInTimeCases(
    fxConvertCurrency,
    { base_currency: 'XYZ', quote_currency: 'EUR', amount: 10 },
    mockGetRate,
  ),
  {
    name: 'a malformed end_date',
    tool: fxGetTimeseries,
    reason: 'invalid_date_format',
    input: { base_currency: 'USD', quote_currency: 'EUR', ...rateWindow, end_date: '2024-6-4' },
    data: { field: 'end_date' },
  },
  {
    name: 'a start_date before the ECB epoch',
    tool: fxGetTimeseries,
    reason: 'date_out_of_range',
    input: { base_currency: 'USD', quote_currency: 'EUR', ...rateWindow, start_date: '1998-12-31' },
  },
  {
    name: 'a future end_date',
    tool: fxGetTimeseries,
    reason: 'date_out_of_range',
    input: { base_currency: 'USD', quote_currency: 'EUR', ...rateWindow, end_date: '2999-01-01' },
  },
  {
    name: 'a reversed range',
    tool: fxGetTimeseries,
    reason: 'invalid_range',
    input: {
      base_currency: 'USD',
      quote_currency: 'EUR',
      start_date: '2024-06-05',
      end_date: '2024-06-03',
    },
  },
  {
    name: 'an unsupported currency',
    tool: fxGetTimeseries,
    reason: 'unsupported_currency',
    input: { base_currency: 'USD', quote_currency: 'XYZ', ...rateWindow },
    data: { field: 'quote_currency', rejected_codes: ['XYZ'] },
    setup: () =>
      mockGetTimeSeries.mockRejectedValue(unsupportedCurrency('quote_currency', ['XYZ'], ACCEPTED)),
  },
  {
    name: 'a range the ECB published nothing for',
    tool: fxGetTimeseries,
    reason: 'upstream_no_data',
    input: { base_currency: 'USD', quote_currency: 'EUR', ...rateWindow },
    setup: () => mockGetTimeSeries.mockRejectedValue(upstreamNoData()),
  },
  {
    name: 'an expired canvas',
    tool: fxDataframeDescribe,
    reason: 'canvas_not_found',
    input: { canvas_id: 'abc1234567' },
    setup: () => {
      withCanvas();
      mockAcquire.mockRejectedValue(expiredCanvas());
    },
  },
  {
    name: 'an expired canvas at acquire',
    tool: fxDataframeQuery,
    reason: 'canvas_not_found',
    input: { canvas_id: 'abc1234567', query: 'SELECT * FROM fx_usd_eur' },
    setup: () => {
      withCanvas();
      mockAcquire.mockRejectedValue(expiredCanvas());
    },
  },
  {
    name: 'a canvas evicted mid-query',
    tool: fxDataframeQuery,
    reason: 'canvas_not_found',
    input: { canvas_id: 'abc1234567', query: 'SELECT * FROM fx_usd_eur' },
    setup: () => {
      withCanvas();
      mockQuery.mockRejectedValue(expiredCanvas());
    },
  },
  {
    name: 'an unstaged table',
    tool: fxDataframeQuery,
    reason: 'missing_table',
    input: { canvas_id: 'abc1234567', query: 'SELECT * FROM fx_nope' },
    setup: () => {
      withCanvas();
      mockQuery.mockRejectedValue(
        notFound('Canvas table "fx_nope" does not exist.', {
          reason: 'missing_table',
          tableName: 'fx_nope',
        }),
      );
    },
  },
  {
    name: 'a non-SELECT statement',
    tool: fxDataframeQuery,
    reason: 'invalid_query',
    input: { canvas_id: 'abc1234567', query: 'DROP TABLE fx_usd_eur' },
    setup: () => {
      withCanvas();
      mockQuery.mockRejectedValue(
        validationError('Only SELECT statements are allowed.', {
          reason: 'non_select_statement',
        }),
      );
    },
  },
  {
    name: 'no canvas configured',
    tool: fxDataframeDrop,
    reason: 'canvas_unavailable',
    input: { canvas_id: 'abc1234567', table_name: 'fx_usd_eur' },
    setup: () => mockGetCanvas.mockReturnValue(undefined),
  },
  {
    name: 'an expired canvas',
    tool: fxDataframeDrop,
    reason: 'canvas_not_found',
    input: { canvas_id: 'abc1234567', table_name: 'fx_usd_eur' },
    setup: () => {
      withCanvas();
      mockAcquire.mockRejectedValue(expiredCanvas());
    },
  },
];

describe('declared recovery hints on the wire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRate.mockReset();
    mockGetRates.mockReset();
    mockGetTimeSeries.mockReset();
    mockAcquire.mockReset();
    mockQuery.mockReset();
    mockDrop.mockReset();
  });

  it.each(cases.map((c) => [c.tool.name, c.reason, c.name, c] as const))(
    '%s %s (%s) carries its declared hint on both surfaces',
    async (_tool, _reason, _name, { tool, reason, input, data, setup }) => {
      setup?.();
      const declared = tool.errors?.find((entry) => entry.reason === reason)?.recovery;
      expect(declared).toBeDefined();

      const result = await runToolContract(tool as typeof fxGetRate, input as never);
      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');

      expect(result.isError).toBe(true);
      expect(error.data).toMatchObject({
        reason,
        recovery: { hint: declared },
        ...data,
      });
      expect(text).toContain(declared);
    },
  );
});
