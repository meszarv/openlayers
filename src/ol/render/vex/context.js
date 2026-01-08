/**
 * @module ol/render/vex/context
 */
import {shouldUseRealVexRenderer} from './config.js';
import {createVexContext as createMockContext} from './context_mock.js';
import {createVexContext as createRealContext} from './context_real.js';

/**
 * @param {HTMLCanvasElement} canvas Canvas element.
 * @return {Promise<import('./context_mock.js').VexContext>} Vex context promise.
 */
export function createVexContext(canvas) {
  if (shouldUseRealVexRenderer()) {
    return createRealContext(canvas).catch((error) => {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          'Falling back to the Canvas-based Vex mock because the real library is unavailable.',
          error,
        );
      }
      return createMockContext(canvas);
    });
  }
  return createMockContext(canvas);
}

export default createVexContext;
