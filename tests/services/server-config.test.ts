/**
 * @fileoverview The drop registration flag shares setup's schema and env normalization.
 * @module tests/services/server-config.test
 */
import { afterEach, expect, it, vi } from 'vitest';
import { isCanvasDropEnabled } from '@/config/server-config.js';

afterEach(() => vi.unstubAllEnvs());

it.each(['true', '1', 'yes', 'on', 'y', 'enabled', 'TRUE', 'Yes'])(
  'enables drop for %s',
  (value) => {
    vi.stubEnv('FX_ENABLE_CANVAS_DROP', value);
    expect(isCanvasDropEnabled()).toBe(true);
  },
);

it.each([
  'false',
  '0',
  'no',
  'off',
  'n',
  'disabled',
  'FALSE',
  '',
  '  ',
  `\${user_config.flag}`,
  undefined,
  'maybe',
])('keeps drop unregistered for %s', (value) => {
  vi.stubEnv('FX_ENABLE_CANVAS_DROP', value);
  expect(isCanvasDropEnabled()).toBe(false);
});

it('does not parse unrelated server configuration at registration', () => {
  vi.stubEnv('FX_ENABLE_CANVAS_DROP', 'true');
  vi.stubEnv('FRANKFURTER_BASE_URL', 'invalid');
  vi.stubEnv('FX_TIMESERIES_CANVAS_THRESHOLD_DAYS', 'invalid');
  expect(isCanvasDropEnabled()).toBe(true);
});
