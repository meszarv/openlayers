/**
 * @module ol/layer/Vector
 */
import {listen, unlistenByKey} from '../events.js';
import CanvasVectorLayerRenderer from '../renderer/canvas/VectorLayer.js';
import VexVectorLayerRenderer from '../renderer/vex/VectorLayer.js';
import BaseVectorLayer from './BaseVector.js';

const DEFAULT_VEX_SWITCH_ZOOM = 10;

/**
 * @template {import("../source/Vector.js").default<FeatureType>} [VectorSourceType=import("../source/Vector.js").default<*>]
 * @template {import('../Feature.js').FeatureLike} [FeatureType=import("./BaseVector.js").ExtractedFeatureType<VectorSourceType>]
 * @typedef {Object} Options
 * @property {string} [className='ol-layer'] A CSS class name to set to the layer element.
 * @property {number} [opacity=1] Opacity (0, 1).
 * @property {boolean} [visible=true] Visibility.
 * @property {import("../extent.js").Extent} [extent] The bounding extent for layer rendering.  The layer will not be
 * rendered outside of this extent.
 * @property {number} [zIndex] The z-index for layer rendering.  At rendering time, the layers
 * will be ordered, first by Z-index and then by position. When `undefined`, a `zIndex` of 0 is assumed
 * for layers that are added to the map's `layers` collection, or `Infinity` when the layer's `setMap()`
 * method was used.
 * @property {number} [minResolution] The minimum resolution (inclusive) at which this layer will be
 * visible.
 * @property {number} [maxResolution] The maximum resolution (exclusive) below which this layer will
 * be visible.
 * @property {number} [minZoom] The minimum view zoom level (exclusive) above which this layer will be
 * visible.
 * @property {number} [maxZoom] The maximum view zoom level (inclusive) at which this layer will
 * be visible.
 * @property {import("../render.js").OrderFunction} [renderOrder] Render order. Function to be used when sorting
 * features before rendering. By default features are drawn in the order that they are created. Use
 * `null` to avoid the sort, but get an undefined draw order.
 * @property {number} [renderBuffer=100] The buffer in pixels around the viewport extent used by the
 * renderer when getting features from the vector source for the rendering or hit-detection.
 * Recommended value: the size of the largest symbol, line width or label.
 * @property {VectorSourceType} [source] Source.
 * @property {import("../Map.js").default} [map] Sets the layer as overlay on a map. The map will not manage
 * this layer in its layers collection, and the layer will be rendered on top. This is useful for
 * temporary layers. The standard way to add a layer to a map and have it managed by the map is to
 * use [map.addLayer()]{@link import("../Map.js").default#addLayer}.
 * @property {boolean|string|number} [declutter=false] Declutter images and text. Any truthy value will enable
 * decluttering. Within a layer, a feature rendered before another has higher priority. All layers with the
 * same `declutter` value will be decluttered together. The priority is determined by the drawing order of the
 * layers with the same `declutter` value. Higher in the layer stack means higher priority. To declutter distinct
 * layers or groups of layers separately, use different truthy values for `declutter`.
 * @property {import("../style/Style.js").StyleLike|import("../style/flat.js").FlatStyleLike|null} [style] Layer style. When set to `null`, only
 * features that have their own style will be rendered. See {@link module:ol/style/Style~Style} for the default style
 * which will be used if this is not set.
 * @property {import("./Base.js").BackgroundColor} [background] Background color for the layer. If not specified, no background
 * will be rendered.
 * @property {boolean} [updateWhileAnimating=false] When set to `true`, feature batches will
 * be recreated during animations. This means that no vectors will be shown clipped, but the
 * setting will have a performance impact for large amounts of vector data. When set to `false`,
 * batches will be recreated when no animation is active.
 * @property {boolean} [updateWhileInteracting=false] When set to `true`, feature batches will
 * be recreated during interactions. See also `updateWhileAnimating`.
 * @property {Object<string, *>} [properties] Arbitrary observable properties. Can be accessed with `#get()` and `#set()`.
 * @property {'canvas'|'vex'} [rendererHint='canvas'] Experimental renderer selection.
 * When set to `'vex'`, the layer automatically switches back to canvas rendering when the view zoom
 * is greater than or equal to an internal threshold (default `7`).
 */

/**
 * @classdesc
 * Vector data is rendered client-side, as vectors. This layer type provides most accurate rendering
 * even during animations. Points and labels stay upright on rotated views. For very large
 * amounts of vector data, performance may suffer during pan and zoom animations. In this case,
 * try {@link module:ol/layer/VectorImage~VectorImageLayer}.
 *
 * Note that any property set in the options is set as a {@link module:ol/Object~BaseObject}
 * property on the layer object; for example, setting `title: 'My Title'` in the
 * options means that `title` is observable, and has get/set accessors.
 *
 * @template {import("../source/Vector.js").default<FeatureType>} [VectorSourceType=import("../source/Vector.js").default<*>]
 * @template {import('../Feature.js').FeatureLike} [FeatureType=import("./BaseVector.js").ExtractedFeatureType<VectorSourceType>]
 * @extends {BaseVectorLayer<FeatureType, VectorSourceType, CanvasVectorLayerRenderer>}
 * @api
 */
class VectorLayer extends BaseVectorLayer {
  /**
   * @param {Options<VectorSourceType, FeatureType>} [options] Options.
   */
  constructor(options) {
    super(options);

    /**
     * @type {'canvas'|'vex'}
     * @private
     */
    this.rendererHint_ =
      (options && options.rendererHint) || 'vex';
      // ((options && options['type'] === 'vex' && options['type']) || 'canvas');

    /**
     * @type {boolean}
     * @private
     */
    this.autoVexSwitchEnabled_ = this.rendererHint_ === 'vex';

    /**
     * @type {'canvas'|'vex'}
     * @private
     */
    this.activeRendererHint_ = this.rendererHint_;

    /**
     * @type {?import("../Map.js").default}
     * @private
     */
    this.autoSwitchMap_ = null;

    /**
     * @type {?import("../Map.js").default}
     * @private
     */
    this.manualMapAttachment_ = null;

    /**
     * @type {import("../events.js").EventsKey|null}
     * @private
     */
    this.viewResolutionKey_ = null;

    /**
     * @type {import("../events.js").EventsKey|null}
     * @private
     */
    this.viewChangeKey_ = null;

    /**
     * Detached Vex renderer we keep around for fast reuse after auto-switching.
     * @type {import("../renderer/vex/VectorLayer.js").default|null}
     * @private
     */
    this.cachedVexRenderer_ = null;
  }

  /**
   * @override
   */
  createRenderer() {
    const rendererHint = this.getRendererHintForCurrentZoom_();
    this.activeRendererHint_ = rendererHint;
    const cached = this.acquireCachedRenderer_(rendererHint);
    if (cached) {
      return cached;
    }
    return this.instantiateRenderer_(rendererHint);
  }

  /**
   * @return {'canvas'|'vex'} The renderer currently in use.
   */
  getActiveRendererHint() {
    return this.activeRendererHint_ || this.rendererHint_;
  }

  /**
   * @return {number} Zoom level where the renderer switches from Vex to Canvas.
   */
  getVexSwitchZoom() {
    return DEFAULT_VEX_SWITCH_ZOOM;
  }

  /**
   * @override
   */
  setMap(map) {
    this.manualMapAttachment_ = map;
    super.setMap(map);
    this.handleAutoSwitchMapChange_(map);
  }

  /**
   * @override
   */
  setMapInternal(map) {
    super.setMapInternal(map);
    this.handleAutoSwitchMapChange_(map);
  }

  /**
   * @override
   */
  disposeInternal() {
    this.detachAutoSwitchListeners_();
    if (this.cachedVexRenderer_) {
      this.cachedVexRenderer_.dispose();
      this.cachedVexRenderer_ = null;
    }
    super.disposeInternal();
  }

  /**
   * @private
   */
  handleAutoSwitchMapChange_(map) {
    if (!this.autoVexSwitchEnabled_) {
      return;
    }
    const attachedMap = this.getAttachedMap_() || map || null;
    if (attachedMap === this.autoSwitchMap_) {
      return;
    }
    this.detachAutoSwitchListeners_();
    this.autoSwitchMap_ = attachedMap;
    if (!attachedMap) {
      return;
    }
    this.attachAutoSwitchListeners_(attachedMap);
    this.handleViewResolutionChange_();
  }

  /**
   * @private
   * @return {?import("../Map.js").default}
   */
  getAttachedMap_() {
    return this.getMapInternal() || this.manualMapAttachment_;
  }

  /**
   * @param {import("../Map.js").default} map Map instance.
   * @private
   */
  attachAutoSwitchListeners_(map) {
    if (this.viewChangeKey_) {
      return;
    }
    this.viewChangeKey_ = listen(
      map,
      'change:view',
      this.handleAttachedViewChange_,
      this,
    );
    const view = map.getView();
    if (view) {
      this.viewResolutionKey_ = listen(
        view,
        'change:resolution',
        this.handleViewResolutionChange_,
        this,
      );
    }
  }

  /**
   * @private
   */
  detachAutoSwitchListeners_() {
    if (this.viewResolutionKey_) {
      unlistenByKey(this.viewResolutionKey_);
      this.viewResolutionKey_ = null;
    }
    if (this.viewChangeKey_) {
      unlistenByKey(this.viewChangeKey_);
      this.viewChangeKey_ = null;
    }
    this.autoSwitchMap_ = null;
  }

  /**
   * @private
   */
  handleAttachedViewChange_() {
    if (!this.autoSwitchMap_) {
      return;
    }
    if (this.viewResolutionKey_) {
      unlistenByKey(this.viewResolutionKey_);
      this.viewResolutionKey_ = null;
    }
    const view = this.autoSwitchMap_.getView();
    if (view) {
      this.viewResolutionKey_ = listen(
        view,
        'change:resolution',
        this.handleViewResolutionChange_,
        this,
      );
    }
    this.handleViewResolutionChange_();
  }

  /**
   * @private
   */
  handleViewResolutionChange_() {
    if (!this.autoVexSwitchEnabled_) {
      return;
    }
    const rendererHint = this.getRendererHintForCurrentZoom_();
    if (rendererHint === this.activeRendererHint_) {
      return;
    }
    this.switchRenderer_(rendererHint);
  }

  /**
   * @private
   * @return {'canvas'|'vex'}
   */
  getRendererHintForCurrentZoom_() {
    if (!this.autoVexSwitchEnabled_) {
      return this.rendererHint_;
    }
    const zoom = this.getCurrentViewZoom_();
    if (typeof zoom !== 'number') {
      return 'vex';
    }
    const threshold = DEFAULT_VEX_SWITCH_ZOOM;
    return zoom < threshold ? 'vex' : 'canvas';
  }

  /**
   * @private
   * @return {number|null}
   */
  getCurrentViewZoom_() {
    const map = this.getAttachedMap_();
    const view = map ? map.getView() : null;
    return view ? view.getZoom() : null;
  }

  /**
   * @param {'canvas'|'vex'} rendererHint Renderer hint.
   * @private
   */
  switchRenderer_(rendererHint) {
    const currentRenderer = this.renderer_;
    if (currentRenderer) {
      // Cache or dispose renderer before replacing so we can reuse Vex instances.
      this.cacheRenderer_(currentRenderer);
      this.renderer_ = null;
      this.rendered = false;
    }
    const cached = this.acquireCachedRenderer_(rendererHint);
    if (cached) {
      this.renderer_ = cached;
    } else {
      this.renderer_ = this.instantiateRenderer_(rendererHint);
    }
    this.activeRendererHint_ = rendererHint;
    this.changed();
  }

  /**
   * @param {'canvas'|'vex'} rendererHint Renderer hint.
   * @return {import("../renderer/Layer.js").default|null} Renderer instance.
   * @private
   */
  acquireCachedRenderer_(rendererHint) {
    if (rendererHint !== 'vex' || !this.cachedVexRenderer_) {
      return null;
    }
    // Rehydrating a cached Vex renderer is faster than rebuilding its scene.
    const renderer = this.cachedVexRenderer_;
    this.cachedVexRenderer_ = null;
    return renderer;
  }

  /**
   * @param {'canvas'|'vex'} rendererHint Renderer hint.
   * @return {import("../renderer/Layer.js").default}
   * @private
   */
  instantiateRenderer_(rendererHint) {
    if (rendererHint === 'vex') {
      return new VexVectorLayerRenderer(this);
    }
    return new CanvasVectorLayerRenderer(this);
  }

  /**
   * @param {import("../renderer/Layer.js").default} renderer Renderer to cache/dispose.
   * @private
   */
  cacheRenderer_(renderer) {
    if (renderer instanceof VexVectorLayerRenderer) {
      const container =
        /** @type {import("../renderer/vex/VectorLayer.js").default} */ (
          renderer
        ).container_;
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
      // Keep the renderer (and its OffscreenCanvas) alive for a future switch.
      this.cachedVexRenderer_ = renderer;
      return;
    }
    renderer.dispose();
  }

  /**
   * @override
   */
  clearRenderer() {
    if (this.cachedVexRenderer_) {
      this.cachedVexRenderer_.dispose();
      this.cachedVexRenderer_ = null;
    }
    super.clearRenderer();
  }

  /**
   * Force the active or cached renderer to rebuild its recorded instructions.
   */
  invalidateRendererCache() {
    let invalidated = false;
    if (
      this.renderer_ instanceof VexVectorLayerRenderer &&
      typeof this.renderer_.invalidateCache === 'function'
    ) {
      // Force the live Vex renderer to drop recorded instructions.
      this.renderer_.invalidateCache();
      invalidated = true;
    }
    if (
      this.cachedVexRenderer_ &&
      typeof this.cachedVexRenderer_.invalidateCache === 'function'
    ) {
      // Keep cached renderer in sync so it doesn't restore stale visuals later.
      this.cachedVexRenderer_.invalidateCache();
      invalidated = true;
    }
    if (!invalidated) {
      this.changed();
      return;
    }
    this.changed();
  }

}

export default VectorLayer;
