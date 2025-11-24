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
    const layerGroups = this.buildLayerGroups_(layerStatesArray);
    const sharedLayerGroups = this.extractSharedLayerGroups_(layerGroups);
    if (sharedLayerGroups.length > 0) {
      const lookup = new Map();
      for (let i = 0; i < sharedLayerGroups.length; ++i) {
        const entry = sharedLayerGroups[i];
        entry.manager.reset(frameState, entry.layers);
        for (let j = 0; j < entry.layers.length; ++j) {
          const uid = getUid(entry.layers[j].layer);
          lookup.set(uid, entry);
        }
      }
      frameState.sharedLayerGroups = sharedLayerGroups;
      frameState.sharedLayerGroupLookup = lookup;
    } else {
      frameState.sharedLayerGroups = null;
      frameState.sharedLayerGroupLookup = null;
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
   * @return {Array<{shareable: boolean, host: import('../layer/Layer.js').State|null, layers: Array<import('../layer/Layer.js').State>}>}
   * @private
   */
  buildLayerGroups_(layerStates) {
    const groups = [];
    /** @type {{shareable: boolean, host: import('../layer/Layer.js').State|null, layers: Array<import('../layer/Layer.js').State>}|null} */
    let currentGroup = null;
    for (let i = 0; i < layerStates.length; ++i) {
      const layerState = layerStates[i];
      const shareable = this.isShareableVectorLayer_(layerState);
      const compatible =
        shareable &&
        currentGroup &&
        currentGroup.shareable &&
        currentGroup.host &&
        this.areLayerStatesCompatible_(currentGroup.host, layerState);
      if (compatible) {
        currentGroup.layers.push(layerState);
        continue;
      }
      currentGroup = {
        shareable,
        host: shareable ? layerState : null,
        layers: [layerState],
      };
      groups.push(currentGroup);
    }
    return groups;
  }

  /**
   * Decide if a layer state may participate in shared canvas rendering.
   * @param {import('../layer/Layer.js').State} layerState Layer state.
   * @return {boolean}
   * @private
   */
  isShareableVectorLayer_(layerState) {
    const layer = layerState.layer;
    if (!(layer instanceof BaseVectorLayer)) {
      return false;
    }
    const renderer = layer.hasRenderer() ? layer.getRenderer() : null;
    return renderer instanceof CanvasVectorLayerRenderer;
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
   * @param {Array<{shareable: boolean, host: import('../layer/Layer.js').State|null, layers: Array<import('../layer/Layer.js').State>}>} groups Groups.
   * @return {Array<{renderer: CanvasVectorLayerRenderer, layers: Array<import('../layer/Layer.js').State>, manager: import('./canvas/SharedVectorCanvas.js').default}>}
   * @private
   */
  extractSharedLayerGroups_(groups) {
    const shared = [];
    for (let i = 0; i < groups.length; ++i) {
      const group = groups[i];
      if (!group.shareable || !group.host || group.layers.length < 2) {
        continue;
      }
      const renderer = group.host.layer.getRenderer();
      if (!(renderer instanceof CanvasVectorLayerRenderer)) {
        continue;
      }
      shared.push({
        renderer,
        layers: group.layers.slice(),
        manager: renderer.getSharedCanvasManager(),
      });
    }
    return shared;
  }

  /**
   * Execute pending shared draw callbacks.
   * @param {import('../Map.js').FrameState} frameState Frame state.
   * @private
   */
  executeSharedDraws_(frameState) {
    const groups = frameState.sharedLayerGroups;
    if (!groups) {
      return;
    }
    for (let i = 0; i < groups.length; ++i) {
      groups[i].manager.draw();
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
