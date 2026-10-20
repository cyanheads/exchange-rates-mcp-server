/**
 * @fileoverview Drop registration and setup validation in real startup subprocesses.
 * @module tests/tools/fx-drop-startup.test
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const entry = new URL('../../dist/index.js', import.meta.url).pathname;

it.each([
  ['FX_ENABLE_CANVAS_DROP', 'maybe'],
  ['FRANKFURTER_BASE_URL', 'not a URL'],
  ['FX_TIMESERIES_CANVAS_THRESHOLD_DAYS', 'not a number'],
])('reports invalid %s inside the startup boundary', (key, value) => {
  const child = spawnSync('node', [entry], {
    cwd: root,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      CANVAS_PROVIDER_TYPE: 'none',
      FX_ENABLE_CANVAS_DROP: 'false',
      FRANKFURTER_BASE_URL: 'https://api.frankfurter.dev/v1',
      FX_TIMESERIES_CANVAS_THRESHOLD_DAYS: '90',
      [key]: value,
    },
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain(key);
  expect(child.stderr).toContain('Server config validation failed');
  expect(child.stderr).not.toContain('at parseEnvConfig');
  expect(child.stderr).not.toContain('file://');
});

it.each(['true', 'false'])('loads drop=%s from .env before registration', (flag) => {
  const cwd = mkdtempSync(join(tmpdir(), 'fx-drop-env-'));
  const env = { ...process.env };
  delete env.FX_ENABLE_CANVAS_DROP;
  const definition = new URL(
    '../../dist/mcp-server/tools/definitions/fx-dataframe-drop.tool.js',
    import.meta.url,
  ).href;
  try {
    writeFileSync(join(cwd, '.env'), `FX_ENABLE_CANVAS_DROP=${flag}\nCANVAS_PROVIDER_TYPE=none\n`);
    const child = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `const { fxDataframeDrop } = await import(${JSON.stringify(definition)}); console.log('DROP_ENABLED=' + !fxDataframeDrop.__mcpDisabled);`,
      ],
      {
        cwd,
        env,
        input: '',
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(`DROP_ENABLED=${flag}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
