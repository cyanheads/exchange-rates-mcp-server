/**
 * @fileoverview DataCanvas accessor — module-level singleton for the canvas service.
 * @module services/canvas/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Set the canvas instance (called from createApp setup callback). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Get the canvas instance, or undefined if canvas is not enabled. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
