/**
 * @fileoverview Tests for the Markdown table-cell escaper used by fx_dataframe_query's format().
 * @module tests/utils/escape-markdown-table-cell.test
 */

import { describe, expect, it } from 'vitest';
import { escapeMarkdownTableCell } from '@/utils/escape-markdown-table-cell.js';

describe('escapeMarkdownTableCell', () => {
  it.each([
    ['pipe', 'a|b', 'a\\|b'],
    ['backslash', 'back\\slash', 'back\\\\slash'],
    ['angle brackets', '<script>', '\\<script\\>'],
    ['asterisk emphasis', '*bold*', '\\*bold\\*'],
    ['underscore emphasis', '_it_', '\\_it\\_'],
    ['backtick code span', '`x`', '\\`x\\`'],
    ['link brackets', '[t](u)', '\\[t\\](u)'],
    ['strikethrough tildes', '~~gone~~', '\\~\\~gone\\~\\~'],
    ['entity ampersand', '&amp;', '\\&amp;'],
  ])('escapes %s', (_label, input, expected) => {
    expect(escapeMarkdownTableCell(input)).toBe(expected);
  });

  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['CR', 'a\rb'],
  ])('turns a %s line break into one <br> so the value stays on one row', (_label, input) => {
    expect(escapeMarkdownTableCell(input)).toBe('a<br>b');
  });

  it('escapes a backslash before the character it precedes, so neither is reinterpreted', () => {
    expect(escapeMarkdownTableCell('\\|')).toBe('\\\\\\|');
  });

  it('distinguishes a literal <br> in the data from an escaped line break', () => {
    expect(escapeMarkdownTableCell('<br>')).toBe('\\<br\\>');
  });

  it.each(['plain text', '2024-06-03', '-0.91234', '1e-7', ''])('leaves %j unchanged', (value) => {
    expect(escapeMarkdownTableCell(value)).toBe(value);
  });
});
