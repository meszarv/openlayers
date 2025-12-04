/**
 * @module ol/render/vex/VectorContext
 */

import {create as createTransform} from '../../transform.js';
import CanvasImmediateRenderer from '../canvas/Immediate.js';

const FULL_SCENE_EXTENT = [-Infinity, -Infinity, Infinity, Infinity];

/**
 * Create a vector context that records drawing commands into the Vex backing canvas.
 * @param {import('./context.js').VexContext} vexContext Vex context.
 * @param {import('../../Map.js').FrameState} frameState Frame state.
 * @param {{
 *  pixelRatio?: number,
 *  rotation?: number,
 *  transform?: import('../../transform.js').Transform
 * }} [options] Optional overrides for recording transform.
 * @return {CanvasImmediateRenderer} Vector context recorder.
 */
export function createVexVectorContext(vexContext, frameState, options = {}) {
  console.log("VEX: createVexVectorContext")
  const {
    pixelRatio = frameState.pixelRatio || 1,
    rotation = frameState.viewState ? frameState.viewState.rotation : 0,
    transform,
    extent = FULL_SCENE_EXTENT,
  } = options;
  const contextTransform =
    transform || frameState.coordinateToPixelTransform || createTransform();
  const renderer = new CanvasImmediateRenderer(
    vexContext,
    pixelRatio,
    extent,
    contextTransform,
    rotation,
  )
  console.log('VEX: renderer',[renderer])
  return renderer;
}

export default createVexVectorContext;
