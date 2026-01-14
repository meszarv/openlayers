/**
 * @module ol/renderer/Composite
 */
import ObjectEventType from '../ObjectEventType.js';
import {CLASS_UNSELECTABLE} from '../css.js';
import {replaceChildren} from '../dom.js';
import {listen, unlistenByKey} from '../events.js';
import BaseVectorLayer from '../layer/BaseVector.js';
import {inView} from '../layer/Layer.js';
import RenderEvent from '../render/Event.js';
import RenderEventType from '../render/EventType.js';
import {checkedFonts} from '../render/canvas.js';
import {getUid} from '../util.js';
import MapRenderer from './Map.js';
import CanvasVectorLayerRenderer from './canvas/VectorLayer.js';
import VexVectorLayerRenderer from './vex/VectorLayer.js';
import {getVexSharedLayerLimit} from '../render/vex/config.js';

/**
 * @typedef {Object} LayerStateSummary
 * @property {string} uid
 * @property {number} zIndex
 * @property {boolean} visible
 * @property {boolean} shareable
 * @property {'canvas'|'vex'|null} shareType
 * @property {string} className
 * @property {boolean|string|number|undefined} declutter
 * @property {*} background
 * @property {*|undefined} style
 * @property {*|undefined} styleFunction
 */

function sharedDebugEnabled() {
  return typeof window !== 'undefined' && !!window && !!window.__OL_SHARED_DEBUG;
}

function sharedDebugLog(message, details) {
  if (!sharedDebugEnabled()) {
    return;
  }
  /* eslint-disable-next-line no-console */
  console.debug(`CompositeMapRenderer: ${message}`, details || undefined);
}

/**
 * @classdesc
 * Canvas map renderer.
 * @api
 */
class CompositeMapRenderer extends MapRenderer {
  /**
   * @param {import("../Map.js").default} map Map.
   */
  constructor(map) {
    super(map);

    /**
     * @private
     * @type {import("../events.js").EventsKey}
     */
    this.fontChangeListenerKey_ = listen(
      checkedFonts,
      ObjectEventType.PROPERTYCHANGE,
      map.redrawText,
      map,
    );

    /**
     * @private
     * @type {HTMLDivElement}
     */
    this.element_ = document.createElement('div');
    const style = this.element_.style;
    style.position = 'absolute';
    style.width = '100%';
    style.height = '100%';
    style.zIndex = '0';

    this.element_.className = CLASS_UNSELECTABLE + ' ol-layers';

    const container = map.getViewport();
    container.insertBefore(this.element_, container.firstChild || null);

    /** @private */
    this.nextVexGroupIndex_ = new Map();

    /**
     * @private
     * @type {Array<HTMLElement>}
     */
    this.children_ = [];

    /**
     * @private
     * @type {boolean}
     */
    this.renderedVisible_ = true;

    /**
     * @private
     * @type {Array<LayerStateSummary>|null}
     */
    this.layerStateSummaryCache_ = null;

    /**
     * @private
     * @type {Array<{renderer: CanvasVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./canvas/SharedVectorCanvas.js').default}>|null}
     */
    this.sharedLayerGroupsCache_ = null;

    /**
     * @private
     * @type {Map<string, {renderer: CanvasVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./canvas/SharedVectorCanvas.js').default}>|null}
     */
    this.sharedLayerGroupLookupCache_ = null;

    /**
     * @private
     * @type {Array<{renderer: VexVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./vex/SharedScene.js').default}>|null}
     */
    this.sharedVexLayerGroupsCache_ = null;

    /**
     * @private
     * @type {Map<string, {renderer: VexVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./vex/SharedScene.js').default}>|null}
     */
    this.sharedVexLayerGroupLookupCache_ = null;

    /** @private */
    this.nextVexGroupIndex_ = 0;
  }

  /**
   * Determine if existing shared layer groups can be reused.
   * @param {Array<import('../layer/Layer.js').State>} layerStates Layer states.
   * @return {boolean} Whether cached grouping is still valid.
   * @private
   */
  canReuseSharedLayerGroups_(layerStates) {
    if (!this.layerStateSummaryCache_) {
      return false;
    }
    if (this.layerStateSummaryCache_.length !== layerStates.length) {
      return false;
    }
    for (let i = 0; i < layerStates.length; ++i) {
      const cached = this.layerStateSummaryCache_[i];
      const layerState = layerStates[i];
      const layer = layerState.layer;
      if (!layer) {
        return false;
      }
      const zIndex = layerState.zIndex ?? 0;
      if (
        cached.uid !== getUid(layer) ||
        cached.zIndex !== zIndex ||
        cached.visible !== !!layerState.visible
      ) {
        return false;
      }
      const shareType = this.getLayerShareType_(layerState);
      const shareable = !!shareType;
      if (cached.shareable !== shareable || cached.shareType !== shareType) {
        return false;
      }
      if (!shareable) {
        continue;
      }
      const declutter =
        typeof layer.getDeclutter === 'function'
          ? layer.getDeclutter()
          : undefined;
      const background = this.getLayerBackgroundSignature_(layer);
      const style = this.getLayerStyleSignature_(layer);
      const styleFunction =
        typeof layer.getStyleFunction === 'function'
          ? layer.getStyleFunction()
          : undefined;
      if (
        cached.className !== layer.getClassName() ||
        cached.declutter !== declutter ||
        cached.background !== background ||
        cached.style !== style ||
        cached.styleFunction !== styleFunction
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Recompute shared layer metadata when invalidated.
   * @param {import('../Map.js').FrameState} frameState Frame state.
   * @param {Array<import('../layer/Layer.js').State>} layerStates Layer states.
   * @private
   */
  rebuildSharedLayerGroupsCache_(frameState, layerStates) {
    this.nextVexGroupIndex_ = 0;
    const layerGroups = this.buildLayerGroups_(layerStates);
    const {canvas, vex} = this.extractSharedLayerGroups_(layerGroups);
    if (canvas.length > 0) {
      const lookup = new Map();
      for (let i = 0; i < canvas.length; ++i) {
        const entry = canvas[i];
        entry.manager.reset(frameState, entry.layers);
        for (let j = 0; j < entry.layers.length; ++j) {
          const uid = getUid(entry.layers[j].layer);
          lookup.set(uid, entry);
        }
      }
      this.sharedLayerGroupsCache_ = canvas;
      this.sharedLayerGroupLookupCache_ = lookup;
    } else {
      this.sharedLayerGroupsCache_ = null;
      this.sharedLayerGroupLookupCache_ = null;
    }
    if (vex.length > 0) {
      const lookup = new Map();
      for (let i = 0; i < vex.length; ++i) {
        const entry = vex[i];
        entry.manager.reset(frameState, entry.layers);
        for (let j = 0; j < entry.layers.length; ++j) {
          const uid = getUid(entry.layers[j].layer);
          lookup.set(uid, entry);
        }
      }
      this.sharedVexLayerGroupsCache_ = vex;
      this.sharedVexLayerGroupLookupCache_ = lookup;
    } else {
      this.sharedVexLayerGroupsCache_ = null;
      this.sharedVexLayerGroupLookupCache_ = null;
    }
    this.layerStateSummaryCache_ = this.createLayerStateSummary_(layerStates);
  }

  /**
   * Build lightweight signatures for layer state array.
   * @param {Array<import('../layer/Layer.js').State>} layerStates Layer states.
   * @return {Array<LayerStateSummary>} Summary.
   * @private
   */
  createLayerStateSummary_(layerStates) {
    const summary = new Array(layerStates.length);
    for (let i = 0; i < layerStates.length; ++i) {
      const layerState = layerStates[i];
      const layer = layerState.layer;
      const shareType = this.getLayerShareType_(layerState);
      const shareable = !!shareType;
      summary[i] = {
        uid: getUid(layer),
        zIndex: layerState.zIndex ?? 0,
        visible: !!layerState.visible,
        shareable,
        shareType,
        className: layer.getClassName(),
        declutter:
          shareable && typeof layer.getDeclutter === 'function'
            ? layer.getDeclutter()
            : undefined,
        background: shareable
          ? this.getLayerBackgroundSignature_(layer)
          : undefined,
        style: shareable ? this.getLayerStyleSignature_(layer) : undefined,
        styleFunction:
          shareable && typeof layer.getStyleFunction === 'function'
            ? layer.getStyleFunction()
            : undefined,
      };
    }
    return summary;
  }

  /**
   * Normalize background to comparable signature.
   * @param {import('../layer/Layer.js').default} layer Layer.
   * @return {*} Signature value.
   * @private
   */
  getLayerBackgroundSignature_(layer) {
    if (typeof layer.getBackground !== 'function') {
      return undefined;
    }
    const background = layer.getBackground();
    if (Array.isArray(background)) {
      return background.join(',');
    }
    return background;
  }

  /**
   * Extract comparable style signature.
   * @param {import('../layer/Layer.js').default} layer Layer.
   * @return {*|undefined} Signature.
   * @private
   */
  getLayerStyleSignature_(layer) {
    if (typeof layer.getStyle === 'function') {
      return layer.getStyle();
    }
    if (typeof layer.getStyleFunction === 'function') {
      return layer.getStyleFunction();
    }
    return undefined;
  }

  /**
   * @param {import("../render/EventType.js").default} type Event type.
   * @param {import("../Map.js").FrameState} frameState Frame state.
   * @override
   */
  dispatchRenderEvent(type, frameState) {
    const map = this.getMap();
    if (map.hasListener(type)) {
      const event = new RenderEvent(type, undefined, frameState);
      map.dispatchEvent(event);
    }
  }

  /**
   * @override
   */
  disposeInternal() {
    unlistenByKey(this.fontChangeListenerKey_);
    this.element_.remove();
    super.disposeInternal();
  }

  /**
   * Hint shared vector canvas managers that a new render cycle was requested.
   */
  bumpSharedCanvasEpoch() {
    if (this.sharedLayerGroupsCache_) {
      this.sharedLayerGroupsCache_.forEach((entry) => {
        entry?.manager?.bumpContextEpoch?.('map-render');
      });
    }
  }

  /**
   * Render.
   * @param {?import("../Map.js").FrameState} frameState Frame state.
   * @override
   */
  renderFrame(frameState) {
    if (!frameState) {
      if (this.renderedVisible_) {
        this.element_.style.display = 'none';
        this.renderedVisible_ = false;
      }
      return;
    }

    this.calculateMatrices2D(frameState);
    this.dispatchRenderEvent(RenderEventType.PRECOMPOSE, frameState);

    const layerStatesArray = frameState.layerStatesArray.sort(
      (a, b) => a.zIndex - b.zIndex,
    );
    const canReuseSharedGroups =
      this.canReuseSharedLayerGroups_(layerStatesArray);
    if (!canReuseSharedGroups) {
      this.rebuildSharedLayerGroupsCache_(frameState, layerStatesArray);
    }
    const sharedLayerGroups = this.sharedLayerGroupsCache_;
    if (sharedLayerGroups && sharedLayerGroups.length > 0) {
      frameState.sharedLayerGroups = sharedLayerGroups;
      frameState.sharedLayerGroupLookup = this.sharedLayerGroupLookupCache_;
    } else {
      frameState.sharedLayerGroups = null;
      frameState.sharedLayerGroupLookup = null;
    }
    const sharedVexGroups = this.sharedVexLayerGroupsCache_;
    if (sharedVexGroups && sharedVexGroups.length > 0) {
      frameState.sharedVexLayerGroups = sharedVexGroups;
      frameState.sharedVexLayerGroupLookup = this.sharedVexLayerGroupLookupCache_;
    } else {
      frameState.sharedVexLayerGroups = null;
      frameState.sharedVexLayerGroupLookup = null;
    }
    const declutter = layerStatesArray.some(
      (layerState) =>
        layerState.layer instanceof BaseVectorLayer &&
        layerState.layer.getDeclutter(),
    );
    if (declutter) {
      // Some layers need decluttering, turn on deferred rendering hint
      frameState.declutter = {};
    }
    const viewState = frameState.viewState;

    this.children_.length = 0;

    const renderedLayerStates = [];
    let previousElement = null;
    for (let i = 0, ii = layerStatesArray.length; i < ii; ++i) {
      const layerState = layerStatesArray[i];
      frameState.layerIndex = i;

      const layer = layerState.layer;
      const sourceState = layer.getSourceState();
      if (
        !inView(layerState, viewState) ||
        (sourceState != 'ready' && sourceState != 'undefined')
      ) {
        layer.unrender();
        continue;
      }

      const element = layer.render(frameState, previousElement);
      if (!element) {
        previousElement = null;
        continue;
      }
      if (element !== previousElement) {
        this.children_.push(element);
        previousElement = element;
      }

      renderedLayerStates.push(layerState);
    }

    this.executeSharedDraws_(frameState);
    this.declutter(frameState, renderedLayerStates);

    replaceChildren(this.element_, this.children_);

    this.dispatchRenderEvent(RenderEventType.POSTCOMPOSE, frameState);

    if (!this.renderedVisible_) {
      this.element_.style.display = '';
      this.renderedVisible_ = true;
    }

    this.scheduleExpireIconCache(frameState);
  }

  /**
   * Group layer states that can share a render surface.
   * @param {Array<import('../layer/Layer.js').State>} layerStates Layer states.
   * @return {Array<{shareable: boolean, shareType: 'canvas'|'vex'|null, host: import('../layer/Layer.js').State|null, layers: Array<import('../layer/Layer.js').State>}>}
   * @private
   */
  buildLayerGroups_(layerStates) {
    const groups = [];
    const MAX_GROUP_SIZE = 50;
    const vexLimit = getVexSharedLayerLimit();
    /** @type {{shareable: boolean, shareType: 'canvas'|'vex'|null, host: import('../layer/Layer.js').State|null, layers: Array<import('../layer/Layer.js').State>, vexGroupId?: number}|null} */
    let currentGroup = null;
    for (let i = 0; i < layerStates.length; ++i) {
      const layerState = layerStates[i];
      const shareType = this.getLayerShareType_(layerState);
      const shareable = !!shareType;
      let vexGroupId = 0;
      if (shareable && shareType === 'vex' && vexLimit > 0 && Number.isFinite(vexLimit)) {
        const currentIndex = this.nextVexGroupIndex_++;
        vexGroupId = Math.floor(currentIndex / vexLimit);
      }
      const compatible =
        shareable &&
        currentGroup &&
        currentGroup.shareable &&
        currentGroup.shareType === shareType &&
        (shareType !== 'vex' || currentGroup.vexGroupId === vexGroupId) &&
        currentGroup.host &&
        (shareType === 'vex' || currentGroup.layers.length < MAX_GROUP_SIZE) &&
        this.areLayerStatesCompatible_(currentGroup.host, layerState);
      if (compatible) {
        currentGroup.layers.push(layerState);
        continue;
      }
      currentGroup = {
        shareable,
        shareType: shareable ? shareType : null,
        host: shareable ? layerState : null,
        layers: [layerState],
        vexGroupId: shareType === 'vex' ? vexGroupId : undefined,
      };
      groups.push(currentGroup);
    }
    return groups;
  }

  /**
   * @param {import('../layer/Layer.js').State} layerState Layer state.
   * @return {'canvas'|'vex'|null} Share type identifier.
   * @private
   */
  getLayerShareType_(layerState) {
    const layer = layerState.layer;
    if (!(layer instanceof BaseVectorLayer)) {
      return null;
    }
    const renderer = layer.hasRenderer() ? layer.getRenderer() : null;
    if (renderer instanceof CanvasVectorLayerRenderer) {
      return 'canvas';
    }
    if (renderer instanceof VexVectorLayerRenderer) {
      return 'vex';
    }
    return null;
  }

  /**
   * Decide if a layer state may participate in shared canvas rendering.
   * @param {import('../layer/Layer.js').State} layerState Layer state.
   * @return {boolean}
   * @private
   */
  isShareableVectorLayer_(layerState) {
    return this.getLayerShareType_(layerState) === 'canvas';
  }

  /**
   * Check whether two layer states are compatible for sharing.
   * @param {import('../layer/Layer.js').State} baseState Reference layer state.
   * @param {import('../layer/Layer.js').State} candidateState Candidate.
   * @return {boolean}
   * @private
   */
  areLayerStatesCompatible_(baseState, candidateState) {
    const baseLayer = baseState.layer;
    const candidateLayer = candidateState.layer;
    if (baseLayer.getClassName() !== candidateLayer.getClassName()) {
      sharedDebugLog('skip shared canvas (className mismatch)', {
        base: getUid(baseLayer),
        candidate: getUid(candidateLayer),
      });
      return false;
    }
    const baseDeclutter = !!baseLayer.getDeclutter();
    const candidateDeclutter = !!candidateLayer.getDeclutter();
    if (baseDeclutter !== candidateDeclutter) {
      sharedDebugLog('skip shared canvas (declutter mismatch)', {
        base: getUid(baseLayer),
        candidate: getUid(candidateLayer),
        baseDeclutter,
        candidateDeclutter,
      });
      return false;
    }
    const baseBackground = baseLayer.getBackground();
    const candidateBackground = candidateLayer.getBackground();
    if (baseBackground !== candidateBackground) {
      sharedDebugLog('skip shared canvas (background mismatch)', {
        base: getUid(baseLayer),
        candidate: getUid(candidateLayer),
      });
      return false;
    }
    return true;
  }

  /**
   * Extract shared layer group metadata for the current frame.
   * @param {Array<{shareable: boolean, shareType: 'canvas'|'vex'|null, host: import('../layer/Layer.js').State|null, layers: Array<import('../layer/Layer.js').State>}>} groups Groups.
   * @return {{
   *   canvas: Array<{renderer: CanvasVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./canvas/SharedVectorCanvas.js').default}>,
   *   vex: Array<{renderer: VexVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./vex/SharedScene.js').default}>
   * }}
   * @private
   */
  extractSharedLayerGroups_(groups) {
    const shared = {
      canvas: [],
      vex: [],
    };
    for (let i = 0; i < groups.length; ++i) {
      const group = groups[i];
      if (!group.shareable || !group.shareType || !group.host || group.layers.length === 0) {
        continue;
      }
      const renderer = group.host.layer.getRenderer();
      if (group.shareType === 'canvas') {
        if (!(renderer instanceof CanvasVectorLayerRenderer)) {
          continue;
        }
        shared.canvas.push({
          renderer,
          layers: group.layers.slice(),
          manager: renderer.getSharedCanvasManager(),
        });
      } else if (group.shareType === 'vex') {
        if (!(renderer instanceof VexVectorLayerRenderer)) {
          continue;
        }
        shared.vex.push({
          renderer,
          layers: group.layers.slice(),
          manager: renderer.getSharedSceneManager(),
        });
      }
    }
    return shared;
  }

  /**
   * Execute pending shared draw callbacks.
   * @param {import('../Map.js').FrameState} frameState Frame state.
   * @private
   */
  executeSharedDraws_(frameState) {
    const canvasGroups = frameState.sharedLayerGroups;
    if (canvasGroups) {
      for (let i = 0; i < canvasGroups.length; ++i) {
        canvasGroups[i].manager.draw();
      }
    }
    const vexGroups = frameState.sharedVexLayerGroups;
    if (vexGroups) {
      for (let i = 0; i < vexGroups.length; ++i) {
        vexGroups[i].manager.draw();
      }
    }
  }

  /**
   * @param {import("../Map.js").FrameState} frameState Frame state.
   * @param {Array<import('../layer/Layer.js').State>} layerStates Layers.
   */
  declutter(frameState, layerStates) {
    if (!frameState.declutter) {
      return;
    }
    for (let i = layerStates.length - 1; i >= 0; --i) {
      const layerState = layerStates[i];
      const layer = layerState.layer;
      if (layer.getDeclutter()) {
        layer.renderDeclutter(frameState, layerState);
      }
    }
    layerStates.forEach((layerState) =>
      layerState.layer.renderDeferred(frameState),
    );
  }
}

export default CompositeMapRenderer;
