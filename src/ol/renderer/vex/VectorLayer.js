/**
 * @module ol/renderer/vex/VectorLayer
 */

import LayerRenderer from '../Layer.js';
import {createVexContext} from '../../render/vex/context.js';
import {createVexVectorContext} from '../../render/vex/VectorContext.js';
import RenderEvent from '../../render/Event.js';
import RenderEventType from '../../render/EventType.js';
import {listen, unlistenByKey} from '../../events.js';
import {getUid} from '../../util.js';

/**
 * Simple container factory for the Vex renderer.
 * @param {import('../../layer/Layer.js').default} layer Layer.
 * @return {HTMLDivElement} Container element.
 */
function createContainer(layer) {
  const container = document.createElement('div');
  container.className = layer.getClassName();
  const style = container.style;
  style.position = 'absolute';
  style.width = '100%';
  style.height = '100%';
  style.left = '0';
  style.top = '0';
  style.pointerEvents = 'none';
  return container;
}

/**
 * Vex-powered renderer for vector layers.
 */
class VexVectorLayerRenderer extends LayerRenderer {
  /**
   * @param {import('../../layer/BaseVector.js').default} vectorLayer Vector layer.
   */
  constructor(vectorLayer) {
    super(vectorLayer);

    /** @private */
    this.container_ = createContainer(vectorLayer);

    /** @private */
    this.canvas_ = document.createElement('canvas');
    Object.assign(this.canvas_.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: 'top left',
    });
    this.container_.appendChild(this.canvas_);

    /**
     * @type {import('../../render/vex/context.js').VexContext|null}
     * @private
     */
    this.vexContext_ = null;

    /**
     * @type {Promise<import('../../render/vex/context.js').VexContext>|null}
     * @private
     */
    this.vexInitPromise_ = null;

    /**
     * @type {Set<string>}
     * @private
     */
    this.recordedFeatureUids_ = new Set();

    /**
     * @type {import('../events').EventsKey|null}
     * @private
     */
    this.featureListenerKey_ = null;

    /**
     * @type {import('../../source/Vector.js').default|null}
     * @private
     */
    this.currentSource_ = null;

  }

  /**
   * @param {import('../../events/Event.js').default} event Event.
   * @private
   */
  handleSourceFeature_(event) {
    this.getLayer().changed();
  }

  /**
   * @param {import('../../source/Vector.js').default} source Source.
   * @private
   */
  attachSourceListener_(source) {
    if (this.featureListenerKey_) {
      return;
    }
    this.featureListenerKey_ = listen(
      source,
      'addfeature',
      this.handleSourceFeature_,
      this,
    );
  }

  /**
   * @private
   */
  detachSourceListener_() {
    if (!this.featureListenerKey_) {
      return;
    }
    unlistenByKey(this.featureListenerKey_);
    this.featureListenerKey_ = null;
  }

  /**
   * @private
   */
  ensureVexContext_() {
    if (this.vexContext_ || this.vexInitPromise_) {
      return;
    }
    this.vexInitPromise_ = createVexContext(this.canvas_).then((ctx) => {
      this.vexContext_ = ctx;
      this.vexInitPromise_ = null;
      this.getLayer().changed();
    });
  }

  /**
   * @param {import('../../source/Vector.js').default} source Source.
   * @private
   */
  syncSourceListeners_(source) {
    if (this.currentSource_ === source) {
      return;
    }
    this.detachSourceListener_();
    this.currentSource_ = source;
    if (source) {
      this.attachSourceListener_(source);
    }
  }

  /**
   * @override
   */
  disposeInternal() {
    this.detachSourceListener_();
    this.container_.remove();
    this.canvas_.width = 0;
    this.canvas_.height = 0;
    super.disposeInternal();
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @private
   */
  resizeCanvas_(frameState) {
    const size = frameState.size;
    const pixelRatio = frameState.pixelRatio;
    const width = Math.round(size[0] * pixelRatio);
    const height = Math.round(size[1] * pixelRatio);

    if (this.canvas_.width !== width || this.canvas_.height !== height) {
      this.canvas_.width = width;
      this.canvas_.height = height;
      if (this.vexContext_ && typeof this.vexContext_.resize === 'function') {
        this.vexContext_.resize(width, height);
      }
    }
    this.canvas_.style.width = `${size[0]}px`;
    this.canvas_.style.height = `${size[1]}px`;
  }

  /**
   * @param {import('../../Feature.js').FeatureLike} feature Feature.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @return {boolean} True when something was rendered.
   * @private
   */
  recordFeatures_(features, frameState) {
    const layer = this.getLayer();
    const styleFunction = layer.getStyleFunction();
    if (!styleFunction || !features.length) {
      if (!styleFunction) {
        console.warn('[VexRenderer] No style function available.');
      }
      if (!features.length) {
        console.warn('[VexRenderer] No features to record.');
      }
      return false;
    }
    const resolution = frameState.viewState.resolution;
    let vectorContext = null;
    let recorded = false;

    for (const feature of features) {
      const uid = getUid(feature);
      if (this.recordedFeatureUids_.has(uid)) {
        console.log('[VexRenderer] Feature already recorded', uid);
        continue;
      }
      const styles = styleFunction(feature, resolution);
      if (!styles) {
        console.warn('[VexRenderer] Feature returned no style', uid);
        this.recordedFeatureUids_.add(uid);
        continue;
      }
      const styleArray = Array.isArray(styles) ? styles : [styles];
      if (!styleArray.length) {
        console.warn('[VexRenderer] Style array empty for feature', uid);
        this.recordedFeatureUids_.add(uid);
        continue;
      }
      if (!vectorContext) {
        vectorContext = createVexVectorContext(this.vexContext_, frameState);
      }
      for (const style of styleArray) {
        if (!style) {
          continue;
        }
        console.log('[VexRenderer] Drawing feature', {
          uid,
          geometryType: feature.getGeometry().getType(),
        });
        vectorContext.drawFeature(feature, style);
        recorded = true;
      }
      this.recordedFeatureUids_.add(uid);
    }

    return recorded;
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @private
   */
  updateSceneView_(frameState) {
    if (!this.vexContext_) {
      return;
    }
    const {center, resolution} = frameState.viewState;
    const pixelRatio = frameState.pixelRatio;
    const halfSpanX = (frameState.size[0] * resolution) / 2;
    const halfSpanY = (frameState.size[1] * resolution) / 2;
    const x = center[0] - halfSpanX;
    const y = center[1] + halfSpanY;
    const zoom = resolution === 0 ? 1 : pixelRatio / resolution;
    this.vexContext_.setSceneView(x, y, zoom);
  }

  /**
   * @param {import('../../render/EventType.js').default} type Type.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @private
   */
  dispatchRenderEvent_(type, frameState) {
    const layer = this.getLayer();
    if (!layer.hasListener(type)) {
      return;
    }
    if (!this.vexContext_) {
      return;
    }
    const identityTransform = [1, 0, 0, 1, 0, 0];
    const event = new RenderEvent(
      type,
      identityTransform,
      frameState,
      this.vexContext_,
    );
    layer.dispatchEvent(event);
  }

  /**
   * @override
   */
  prepareFrame(frameState) {
    const layer = this.getLayer();
    const source = layer.getSource();
    if (!source) {
      return false;
    }

    this.resizeCanvas_(frameState);
    this.ensureVexContext_();
    this.syncSourceListeners_(source);

    if (!this.vexContext_) {
      return true;
    }

    const features = source.getFeatures();
    const recorded = this.recordFeatures_(features, frameState);
    if (recorded) {
      console.log('[VexRenderer] Recorded features', {
        count: features.length,
      });
      this.vexContext_.commit();
    }

    this.updateSceneView_(frameState);

    return true;
  }

  /**
   * @override
   */
  renderFrame(frameState, target) {
    this.dispatchRenderEvent_(RenderEventType.PRERENDER, frameState);
    this.dispatchRenderEvent_(RenderEventType.POSTRENDER, frameState);
    if (target && target !== this.container_) {
      const parent = target.parentNode;
      if (parent) {
        parent.replaceChild(this.container_, target);
      }
    }
    return this.container_;
  }

  /**
   * @override
   */
  forEachFeatureAtCoordinate(
    coordinate,
    frameState,
    hitTolerance,
    callback,
    matches,
  ) {
    return undefined;
  }

  /**
   * @override
   */
  getData(pixel) {
    return null;
  }

  /**
   * @override
   */
  handleFontsChanged() {
    const layer = this.getLayer();
    if (!layer) {
      return;
    }
    layer.changed();
  }
}

export default VexVectorLayerRenderer;
