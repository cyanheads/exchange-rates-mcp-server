/**
 * @fileoverview Bundle selectors preserve SDK runtime skill modules while stripping development guidance.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation', () => {
  it('strips package-root development trees and keeps runtime modules', () => {
    const docs = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/check/SKILL.md',
      'node_modules/example/.claude/instructions.md',
      'node_modules/example/SKILL.md',
    ];
    const runtime = [
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'skills/analyze-fx/SKILL.md',
    ];
    expect(filterAgentDocEntries([...docs, ...runtime])).toEqual(docs);
    expect([...docs, ...runtime].filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(docs);
  });
});
