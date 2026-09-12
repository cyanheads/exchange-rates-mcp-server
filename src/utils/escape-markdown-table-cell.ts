/**
 * @fileoverview Escapes a value for one cell of a GFM Markdown table.
 * @module utils/escape-markdown-table-cell
 */

/**
 * Markdown and HTML metacharacters that would split a table row (`|`), open a tag
 * (`<`, `>`), or turn data into emphasis, code, links, strikethrough, or an entity.
 * Backslash is in the set so an escape already present in the data stays literal.
 */
const METACHARACTERS = /[\\|<>*_`[\]~&]/g;

/**
 * Renders `value` as the literal text of a single table cell: every metacharacter is
 * backslash-escaped and each line break becomes `<br>`, so the value never leaves its
 * row. A literal `<br>` in the data is escaped first and stays distinguishable from one.
 */
export function escapeMarkdownTableCell(value: string): string {
  return value.replace(METACHARACTERS, '\\$&').replace(/\r\n|\r|\n/g, '<br>');
}
