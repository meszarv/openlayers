/**
 * @module ol/renderer/vex/VectorLayer
 */

import {listen, unlistenByKey} from '../../events.js';
import {buffer as bufferExtent, intersects} from '../../extent.js';
import RenderEvent from '../../render/Event.js';
import RenderEventType from '../../render/EventType.js';
import {createVexVectorContext} from '../../render/vex/VectorContext.js';
import {createVexContext} from '../../render/vex/context.js';
import VectorSourceEventType from '../../source/VectorEventType.js';
import {
  compose as composeTransform,
  create as createTransform,
  makeInverse,
  multiply as multiplyTransform,
} from '../../transform.js';
import {getUid} from '../../util.js';
import LayerRenderer from '../Layer.js';

const SCENE_METERS_PER_PIXEL = 10;

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
     * @type {import('../events').EventsKey|null}
     * @private
     */
    this.clearListenerKey_ = null;

    /**
     * @type {import('../../source/Vector.js').default|null}
     * @private
     */
    this.currentSource_ = null;

    /**
     * @type {?import('../../transform.js').Transform}
     * @private
     */
    this.sceneTransform_ = null;

    /**
     * @type {?import('../../transform.js').Transform}
     * @private
     */
    this.sceneInverseTransform_ = null;

    /**
     * Track pixel size separately so OffscreenCanvas-backed elements can signal resizes
     * without touching the HTMLCanvasElement width/height (which would throw after transfer).
     * @type {number}
     * @private
     */
    this.sceneRotation_ = 0;

    /**
     * @type {number}
     * @private
     */
    this.scenePixelRatio_ = 1;

    /**
     * @type {number|null}
     * @private
     */
    this.sceneResolution_ = null;

    /**
     * @type {number}
     * @private
     */
    this.canvasPixelWidth_ = 0;

    /**
     * @type {number}
     * @private
     */
    this.canvasPixelHeight_ = 0;
  }

  /**
   * Clear cached drawing instructions so features will be re-recorded.
   */
  invalidateCache() {
    this.recordedFeatureUids_.clear();
    if (this.vexContext_) {
      this.vexContext_.clear();
    }
  }

  /**
   * @param {import('../../events/Event.js').default} event Event.
   * @private
   */
  handleSourceFeature_(event) {
    this.getLayer().changed();
  }

  /**
   * @private
   */
  handleSourceClear_() {
    this.recordedFeatureUids_.clear();
    if (this.vexContext_) {
      this.vexContext_.clear();
    }
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
      VectorSourceEventType.ADDFEATURE,
      this.handleSourceFeature_,
      this,
    );
    this.clearListenerKey_ = listen(
      source,
      VectorSourceEventType.CLEAR,
      this.handleSourceClear_,
      this,
    );
  }

  /**
   * @private
   */
  detachSourceListener_() {
    if (this.featureListenerKey_) {
      unlistenByKey(this.featureListenerKey_);
      this.featureListenerKey_ = null;
    }
    if (this.clearListenerKey_) {
      unlistenByKey(this.clearListenerKey_);
      this.clearListenerKey_ = null;
    }
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
    if (!this.canvas_.__olOffscreenTransferred) {
      this.canvas_.width = 0;
      this.canvas_.height = 0;
    }
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

    const sizeChanged =
      this.canvasPixelWidth_ !== width || this.canvasPixelHeight_ !== height;
    if (sizeChanged) {
      this.canvasPixelWidth_ = width;
      this.canvasPixelHeight_ = height;
      const canResizeHtmlCanvas = !this.canvas_.__olOffscreenTransferred;
      if (canResizeHtmlCanvas) {
        this.canvas_.width = width;
        this.canvas_.height = height;
      }
      if (this.vexContext_ && typeof this.vexContext_.resize === 'function') {
        this.vexContext_.resize(width, height);
      }
    }
    this.canvas_.style.width = `${size[0]}px`;
    this.canvas_.style.height = `${size[1]}px`;
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @return {import('../../transform.js').Transform} Device-space transform.
   * @private
   */
  createDeviceTransform_(frameState) {
    const transform = frameState.coordinateToPixelTransform.slice();
    const pixelRatio = frameState.pixelRatio;
    if (pixelRatio !== 1) {
      for (let i = 0; i < 6; i += 1) {
        transform[i] *= pixelRatio;
      }
    }
    return transform;
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} resolution Scene resolution in map units / pixel.
   * @return {import('../../transform.js').Transform} Scene transform in device pixels.
   * @private
   */
  createSceneTransform_(frameState, resolution) {
    const transform = createTransform();
    const viewState = frameState.viewState;
    composeTransform(
      transform,
      frameState.size[0] / 2,
      frameState.size[1] / 2,
      1 / resolution,
      -1 / resolution,
      -viewState.rotation,
      -viewState.center[0],
      -viewState.center[1],
    );
    const pixelRatio = frameState.pixelRatio;
    if (pixelRatio !== 1) {
      for (let i = 0; i < 6; i += 1) {
        transform[i] *= pixelRatio;
      }
    }
    return transform;
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @return {number} Target scene resolution (map units / pixel).
   * @private
   */
  computeSceneResolution_(frameState) {
    const projection = frameState.viewState.projection;
    const metersPerUnit =
      (projection && projection.getMetersPerUnit()) || 1;
    const resolution = SCENE_METERS_PER_PIXEL / metersPerUnit;
    return resolution > 0 ? resolution : frameState.viewState.resolution;
  }

  /**
   * Ensure the cached scene transform matches the current recording parameters.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @private
   */
  ensureSceneState_(frameState) {
    const rotation = frameState.viewState.rotation;
    const pixelRatio = frameState.pixelRatio;
    const sceneResolution = this.computeSceneResolution_(frameState);
    const shouldReset =
      !this.sceneTransform_ ||
      rotation !== this.sceneRotation_ ||
      pixelRatio !== this.scenePixelRatio_ ||
      sceneResolution !== this.sceneResolution_;
    if (!shouldReset) {
      return;
    }

    const hadScene = !!this.sceneTransform_;
    this.sceneRotation_ = rotation;
    this.scenePixelRatio_ = pixelRatio;
    this.sceneResolution_ = sceneResolution;
    this.sceneTransform_ = this.createSceneTransform_(
      frameState,
      sceneResolution,
    );
    if (!this.sceneInverseTransform_) {
      this.sceneInverseTransform_ = createTransform();
    }
    makeInverse(this.sceneInverseTransform_, this.sceneTransform_);

    if (hadScene) {
      this.recordedFeatureUids_.clear();
      if (this.vexContext_) {
        this.vexContext_.clear();
      }
    }
  }

  /**
   * @param {Array<import('../../Feature.js').FeatureLike>} features Features.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @return {boolean} True when something was rendered.
   * @private
   */
  recordFeatures_(features, frameState) {
    const layer = this.getLayer();
    if (!features.length) {
      return false;
    }
    const viewExtent = frameState.extent;
    const viewState = frameState.viewState;
    let renderExtent = null;
    if (viewExtent && viewState && Number.isFinite(viewState.resolution)) {
      const renderBuffer = layer.getRenderBuffer
        ? layer.getRenderBuffer()
        : 0;
      if (renderBuffer > 0) {
        const bufferedExtent = viewExtent.slice();
        bufferExtent(bufferedExtent, renderBuffer * viewState.resolution);
        renderExtent = bufferedExtent;
      } else {
        renderExtent = viewExtent;
      }
    }
    const resolution =
      this.sceneResolution_ ?? frameState.viewState.resolution;
    let vectorContext = null;
    let recorded = false;

    for (const feature of features) {
      const uid = getUid(feature);
      if (this.recordedFeatureUids_.has(uid)) {
        continue;
      }
      const geometry = feature.getGeometry();
      if (!geometry) {
        this.recordedFeatureUids_.add(uid);
        continue;
      }
      if (renderExtent && !intersects(renderExtent, geometry.getExtent())) {
        continue;
      }
      const featureStyleFn = feature.getStyleFunction
        ? feature.getStyleFunction()
        : undefined;
      const layerStyleFn = layer.getStyleFunction();
      const styleFunction = featureStyleFn || layerStyleFn;
      if (!styleFunction) {
        this.recordedFeatureUids_.add(uid);
        continue;
      }
      const styles = styleFunction(feature, resolution);
      if (!styles) {
        this.recordedFeatureUids_.add(uid);
        continue;
      }
      const styleArray = Array.isArray(styles) ? styles : [styles];
      if (!styleArray.length) {
        this.recordedFeatureUids_.add(uid);
        continue;
      }
      if (!vectorContext) {
        vectorContext = createVexVectorContext(this.vexContext_, frameState, {
          pixelRatio: this.scenePixelRatio_,
          rotation: this.sceneRotation_,
          transform: this.sceneTransform_,
        });
      }
      for (const style of styleArray) {
        if (!style) {
          continue;
        }
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
    if (
      !this.vexContext_ ||
      !this.sceneTransform_ ||
      !this.sceneInverseTransform_
    ) {
      return;
    }
    const currentTransform = this.createDeviceTransform_(frameState);
    const deltaTransform = multiplyTransform(
      currentTransform,
      this.sceneInverseTransform_,
    );
    const zoomX = deltaTransform[0];
    const zoomY = deltaTransform[3];
    const zoom =
      Number.isFinite(zoomX) && Number.isFinite(zoomY)
        ? (zoomX + zoomY) / 2
        : 1;
    const safeZoom = zoom === 0 ? 1 : zoom;
    const x = deltaTransform[4];
    const y = deltaTransform[5];
    this.vexContext_.setSceneView(x, y, safeZoom);
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

    this.ensureSceneState_(frameState);
    const features = source.getFeatures();
    const recorded = this.recordFeatures_(features, frameState);
    if (recorded) {
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
