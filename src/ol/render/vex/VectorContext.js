/**
 * @module ol/render/vex/VectorContext
 */

import CanvasImmediateRenderer from '../canvas/Immediate.js';
import {create as createTransform} from '../../transform.js';

/**
 * Create a vector context that records drawing commands in map coordinates.
 * @param {import('./context.js').VexContext} vexContext Vex context.
 * @param {import('../../Map.js').FrameState} frameState Frame state.
 * @return {CanvasImmediateRenderer} Vector context recorder.
 */
export function createVexVectorContext(vexContext, frameState) {
  const identity = createTransform();
  return new CanvasImmediateRenderer(
    vexContext,
    1,
    frameState.extent,
    identity,
    0,
  );
}

export default createVexVectorContext;
