/**
 * @module ol/layer/VexVector
 */
import VectorLayer from './Vector.js';

/**
 * @template {import("../source/Vector.js").default<FeatureType>} [VectorSourceType=import("../source/Vector.js").default<*>]
 * @template {import('../Feature.js').FeatureLike} [FeatureType=import("./BaseVector.js").ExtractedFeatureType<VectorSourceType>]
 * @typedef {import('./Vector.js').Options<VectorSourceType, FeatureType>} Options
 */

/**
 * @classdesc
 * Convenience layer that defaults to the experimental Vex renderer and exposes
 * the automatic Canvas/Vex switching behaviour without extra configuration.
 *
 * @template {import("../source/Vector.js").default<FeatureType>} [VectorSourceType=import("../source/Vector.js").default<*>]
 * @template {import('../Feature.js').FeatureLike} [FeatureType=import("./BaseVector.js").ExtractedFeatureType<VectorSourceType>]
 * @extends {VectorLayer<VectorSourceType, FeatureType>}
 * @api
 */
class VexVectorLayer extends VectorLayer {
  /**
   * @param {Options<VectorSourceType, FeatureType>} [options] Options.
   */
  constructor(options) {
    const vexOptions = Object.assign({}, options, {rendererHint: 'vex'});
    super(vexOptions);
    this.set('isVex', true, true);
  }
}

export default VexVectorLayer;
