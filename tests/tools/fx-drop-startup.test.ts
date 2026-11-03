/**
 * @fileoverview Drop registration and setup validation in real startup subprocesses.
 * @module tests/tools/fx-drop-startup.test
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const entry = new URL('../../dist/index.js', import.meta.url).pathname;

it.each([
  ['blank', '', undefined, 'duckdb'],
  ['whitespace', '   ', undefined, 'duckdb'],
  ['placeholder', `\${CANVAS_PROVIDER_TYPE}`, undefined, 'duckdb'],
  ['explicit none', 'none', undefined, 'none'],
  ['dotenv-only none', undefined, 'CANVAS_PROVIDER_TYPE=none\n', 'none'],
])('aligns canvas registration and provider for %s', (_label, value, dotenv, provider) => {
  const cwd = mkdtempSync(join(tmpdir(), 'fx-canvas-startup-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    MCP_TRANSPORT_TYPE: 'stdio',
    FX_ENABLE_CANVAS_DROP: 'false',
    MCP_LOG_LEVEL: 'debug',
  };
  delete env.CANVAS_PROVIDER_TYPE;
  if (value !== undefined) env.CANVAS_PROVIDER_TYPE = value;
  const builtEntry = new URL('../../dist/index.js', import.meta.url).href;
  const config = new URL(
    '../../node_modules/@cyanheads/mcp-ts-core/dist/config/index.js',
    import.meta.url,
  ).href;
  try {
    cpSync(join(root, 'skills'), join(cwd, 'skills'), { recursive: true });
    if (dotenv) writeFileSync(join(cwd, '.env'), dotenv);
    const child = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(builtEntry)}); const { config } = await import(${JSON.stringify(config)}); console.log('PROVIDER=' + config.canvas.providerType);`,
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
    expect(child.stdout).toContain(`PROVIDER=${provider}`);
    const startup = child.stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((line) => line?.operation === 'ServerInit');
    expect(startup).toBeDefined();
    expect(startup.tools.includes('fx_dataframe_query')).toBe(provider === 'duckdb');
    expect(startup.skills).toEqual(['exchange-rates-guide']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('reports invalid framework config inside the startup boundary', () => {
  const child = spawnSync('node', [entry], {
    cwd: root,
    env: { ...process.env, MCP_HTTP_PORT: 'not-a-port', MCP_TRANSPORT_TYPE: 'stdio' },
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('MCP_HTTP_PORT');
  expect(child.stderr).not.toContain('file://');
  expect(child.stderr).not.toContain('at parseConfig');
});

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
