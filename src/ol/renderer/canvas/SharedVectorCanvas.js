/**
 * @module ol/renderer/canvas/SharedVectorCanvas
 */
import {
  createHitDetectionImageData,
  hitDetect,
} from '../../render/canvas/hitdetect.js';
import {getUid} from '../../util.js';

function bindContextValue(target, property) {
  const value = target[property];
  if (typeof value === 'function') {
    return value.bind(target);
  }
  return value;
}

/**
 * Create proxy objects so render event listeners can work with a logical
 * canvas/context pair without mutating the shared host surface directly.
 * @param {CanvasRenderingContext2D} drawContext Drawing context.
 * @param {HTMLCanvasElement} hostCanvas Host canvas element.
 * @return {{
 *   drawContext: CanvasRenderingContext2D,
 *   hostCanvas: HTMLCanvasElement,
 *   proxy: CanvasRenderingContext2D,
 *   canvasProxy: HTMLCanvasElement
 * }|null}
 */
export function createEventContextEntry(drawContext, hostCanvas) {
  if (!drawContext || !hostCanvas) {
    return null;
  }
  const entry = /** @type {*} */ ({
    drawContext,
    hostCanvas,
    proxy: null,
    canvasProxy: null,
  });
  entry.canvasProxy = new Proxy(hostCanvas, {
    get(target, property, receiver) {
      if (property === 'getContext') {
        return () => entry.proxy || drawContext;
      }
      return bindContextValue(target, property);
    },
    set(target, property, value, receiver) {
      if (property === 'getContext') {
        return false;
      }
      target[property] = value;
      return true;
    },
  });
  entry.proxy = new Proxy(drawContext, {
    get(target, property, receiver) {
      if (property === 'canvas') {
        return entry.canvasProxy;
      }
      return bindContextValue(target, property);
    },
    set(target, property, value, receiver) {
      if (property === 'canvas') {
        return false;
      }
      target[property] = value;
      return true;
    },
  });
  return entry;
}

function sharedDebugEnabled() {
  if (typeof window !== 'undefined' && window.__OL_SHARED_DEBUG) {
    return true;
  }
  if (typeof globalThis !== 'undefined' && globalThis.__OL_SHARED_DEBUG) {
    return true;
  }
  return false;
}

function sharedDebugLog(message, details) {
  if (!sharedDebugEnabled()) {
    return;
  }
  console.debug(`SharedVectorCanvas: ${message}`, details || undefined);
}

/**
 * Manages a physical canvas/context that multiple logical vector layers share.
 * Responsible for hosting the DOM container, maintaining per-layer draw states,
 * and scheduling layer draw callbacks.
 */
class SharedVectorCanvas {
  /**
   * @param {import('./VectorLayer.js').default} hostRenderer Host renderer.
   */
  constructor(hostRenderer) {
    /**
     * @private
     * @type {import('./VectorLayer.js').default}
     */
    this.hostRenderer_ = hostRenderer;

    /**
     * @private
     * @type {Array<{
     *   renderer: import('./VectorLayer.js').default,
     *   callback: function():boolean,
     *   frameState: import('../../Map.js').FrameState
     * }>}
     */
    this.jobs_ = [];

    /**
     * @private
     * @type {Array<{
     *   renderer: import('./VectorLayer.js').default,
     *   callback: function():boolean,
     *   frameState: import('../../Map.js').FrameState
     * }>}
     */
    this.pending_ = [];

    /**
     * @private
     * @type {Map<string, {drawStates: Map<string, any>}>}
     */
    this.layerState_ = new Map();

    /**
     * @private
     * @type {Map<import('./VectorLayer.js').default, {
     *   drawStates: Map<string, any>,
     *   container: HTMLElement|null,
     *   context: CanvasRenderingContext2D|null,
     *   containerReused: boolean
     * }>}
     */
    this.attached_ = new Map();

    /**
     * @private
     * @type {CanvasRenderingContext2D|null}
     */
    this.context_ = null;

    /**
     * @private
     * @type {HTMLElement|null}
     */
    this.container_ = null;

    /**
     * @private
     * @type {number}
     */
    this.frameId_ = 0;

    /**
     * @private
     * @type {number}
     */
    this.buildFrameId_ = 0;

    /**
     * @private
     * @type {Array<string>|null}
     */
    this.buildParticipants_ = null;

    /**
     * @private
     * @type {Set<string>|null}
     */
    this.buildParticipantSet_ = null;

    /**
     * @private
     * @type {Set<string>}
     */
    this.processedBuilders_ = new Set();

    /**
     * @private
     * @type {Map<import('./VectorLayer.js').default, {
     *   drawContext: CanvasRenderingContext2D,
     *   hostCanvas: HTMLCanvasElement,
     *   proxy: CanvasRenderingContext2D,
     *   canvasProxy: HTMLCanvasElement
     * }>}
     */
    this.eventContexts_ = new Map();

    /**
     * @private
     * @type {Array<import('../../layer/Layer.js').State>|null}
     */
    this.participants_ = null;

    /**
     * @private
     * @type {{
     *   frameTime: number,
     *   features: Array<import('../../Feature.js').FeatureLike>,
     *   imageData: ImageData,
     *   layerLookup: Array<string>
     * }|null}
     */
    this.hitDetectionCache_ = null;

    /**
     * Cache of declutter feature sets per RBush instance.
     * @private
     * @type {WeakMap<object, {frameTime: number, features: Set<import('../../Feature.js').FeatureLike>}>}
     */
    this.declutterFeatureCache_ = new WeakMap();

  }

  /**
   * Reset for a new frame. Clears pending jobs and refreshes debug flags.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {Array<import('../../layer/Layer.js').State>} [layers] Participating layer states.
   */
  reset(frameState, layers) {
    this.jobs_.length = 0;
    this.pending_.length = 0;
    this.frameId_ = frameState ? frameState.time : 0;
    this.buildFrameId_ = this.frameId_;
    this.buildParticipants_ = layers
      ? layers.map((state) => getUid(state.layer))
      : null;
    this.buildParticipantSet_ = this.buildParticipants_
      ? new Set(this.buildParticipants_)
      : null;
    this.processedBuilders_.clear();
    this.eventContexts_.clear();
    this.participants_ = layers ? layers.slice() : null;
    this.hitDetectionCache_ = null;
    this.declutterFeatureCache_ = new WeakMap();
    this.context_ = null;
    this.container_ = null;
    sharedDebugLog('reset', {
      frameTime: this.frameId_,
      participants: this.buildParticipants_,
    });
  }

  /**
   * Prepare the shared canvas for this frame. Host renderer owns the DOM node.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {HTMLElement|null} target Previous target element.
   */
  beginFrame(frameState, target) {
    if (!this.hostRenderer_) {
      return;
    }
    this.hostRenderer_.prepareContainer(frameState, target);
    this.context_ = this.hostRenderer_.context;
    this.container_ = this.hostRenderer_.container;
    this.frameId_ = frameState.time;
  }

  /**
   * Ensure we have a prepared host context for this frame.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   */
  ensureHostReady(frameState) {
    if (!this.context_ || this.frameId_ !== frameState.time) {
      this.beginFrame(frameState, this.container_);
    }
  }

  /**
   * @return {HTMLElement|null} Host container element.
   */
  getContainer() {
    return this.container_;
  }

  /**
   * Attach a logical renderer to the shared host context, swapping in stored
   * draw-state references.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   */
  attachLayer(renderer) {
    const layerUid = getUid(renderer.getLayer());
    let state = this.layerState_.get(layerUid);
    if (!state) {
      state = {
        drawStates: new Map(),
      };
      this.layerState_.set(layerUid, state);
    }
    this.attached_.set(renderer, {
      drawStates: renderer.drawStates_,
      container: renderer.container,
      context: renderer.context,
      containerReused: renderer.containerReused,
    });
    renderer.drawStates_ = state.drawStates;
    if (this.context_) {
      renderer.context = this.context_;
    }
    if (this.container_) {
      renderer.container = this.container_;
    }
    renderer.containerReused = true;
  }

  /**
   * Persist a logical renderer's state back into the cache and restore its
   * previous container/context references.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   */
  detachLayer(renderer) {
    if (!this.attached_.has(renderer)) {
      return;
    }
    this.eventContexts_.delete(renderer);
    const layerUid = getUid(renderer.getLayer());
    const state = this.layerState_.get(layerUid);
    if (state) {
      state.drawStates = renderer.drawStates_;
    }
    const restore = this.attached_.get(renderer);
    if (restore) {
      renderer.drawStates_ = restore.drawStates ?? new Map();
      renderer.container = restore.container ?? renderer.container;
      renderer.context = restore.context ?? renderer.context;
      renderer.containerReused = restore.containerReused ?? false;
      this.attached_.delete(renderer);
    }
  }

  /**
   * Enqueue a logical layer draw callback to run on the host context.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   * @param {function():boolean} callback Draw callback.
   */
  enqueue(renderer, callback, frameState) {
    this.jobs_.push({renderer, callback, frameState});
  }

  /**
   * Return a render-event context for a logical layer that still exposes the
   * host canvas DOM references.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   * @param {CanvasRenderingContext2D} drawContext Offscreen draw context.
   * @param {CanvasRenderingContext2D} hostContext Host canvas context.
   * @return {CanvasRenderingContext2D}
   */
  getEventContext(renderer, drawContext, hostContext) {
    if (!drawContext) {
      return drawContext;
    }
    const hostCanvas = hostContext?.canvas || drawContext.canvas;
    if (!hostCanvas) {
      return drawContext;
    }
    let entry = this.eventContexts_.get(renderer) || null;
    if (
      !entry ||
      entry.drawContext !== drawContext ||
      entry.hostCanvas !== hostCanvas
    ) {
      entry = createEventContextEntry(drawContext, hostCanvas);
      if (!entry) {
        return drawContext;
      }
      this.eventContexts_.set(renderer, entry);
    }
    return entry.proxy || drawContext;
  }

  /**
   * @return {boolean} Whether this manager can perform shared hit detection.
   */
  supportsHitDetection() {
    return !!(this.participants_ && this.participants_.length > 1);
  }

  /**
   * Run hit detection for a logical layer using the shared cache when possible.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   * @param {import('../../pixel.js').Pixel} pixel Pixel coordinate.
   * @param {function():Promise<Array<import('../../Feature.js').default>>} fallback
   * Fallback that resolves features via per-layer logic.
   * @return {Promise<Array<import('../../Feature.js').default>>}
   */
  getFeaturesForLayer(renderer, pixel, fallback) {
    if (!this.supportsHitDetection() || renderer.animatingOrInteracting_) {
      sharedDebugLog('shared hit detection fallback (unsupported)', {
        layer: getUid(renderer.getLayer()),
      });
      return fallback ? fallback() : Promise.resolve([]);
    }
    const cache = this.ensureHitDetectionCache_(renderer);
    if (!cache) {
      sharedDebugLog('shared hit detection fallback (no cache)', {
        layer: getUid(renderer.getLayer()),
      });
      return fallback ? fallback() : Promise.resolve([]);
    }
    const layerUid = getUid(renderer.getLayer());
    const hits = hitDetect(
      pixel,
      cache.features,
      cache.imageData,
      (index, feature) => {
        if (cache.layerLookup[index] === layerUid) {
          return feature;
        }
        return undefined;
      },
    );
    sharedDebugLog('shared hit detection completed', {
      layer: layerUid,
      hits: hits.length,
      totalFeatures: cache.features.length,
    });
    return Promise.resolve(hits);
  }

  /**
   * Ensure the combined hit detection cache is ready for this frame.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   * @return {{
   *   frameTime: number,
   *   features: Array<import('../../Feature.js').FeatureLike>,
   *   imageData: ImageData,
   *   layerLookup: Array<string>
   * }|null}
   * @private
   */
  ensureHitDetectionCache_(renderer) {
    const frameState = renderer.frameState;
    if (!frameState) {
      return null;
    }
    if (
      this.hitDetectionCache_ &&
      this.hitDetectionCache_.frameTime === frameState.time
    ) {
      return this.hitDetectionCache_;
    }
    const hitConfig =
      renderer.getSharedHitDetectionConfig &&
      renderer.getSharedHitDetectionConfig();
    if (!hitConfig) {
      this.hitDetectionCache_ = null;
      return null;
    }
    const collected = this.collectHitDetectionFeatures_(renderer);
    if (!collected) {
      this.hitDetectionCache_ = null;
      return null;
    }
    const imageData = createHitDetectionImageData(
      hitConfig.size,
      hitConfig.transforms,
      collected.features,
      null,
      hitConfig.extent,
      hitConfig.resolution,
      hitConfig.rotation,
      hitConfig.squaredTolerance,
      hitConfig.hitProjection,
      collected.styleLookups,
    );
    this.hitDetectionCache_ = {
      frameTime: frameState.time,
      features: collected.features,
      imageData,
      layerLookup: collected.layerLookup,
    };
    return this.hitDetectionCache_;
  }

  /**
   * Gather features plus metadata for all participating logical layers.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   * @return {{
   *   features: Array<import('../../Feature.js').FeatureLike>,
   *   styleLookups: Array<import('../../style/Style.js').StyleFunction|null>,
   *   layerLookup: Array<string>
   * }|null}
   * @private
   */
  collectHitDetectionFeatures_(renderer) {
    if (!this.participants_ || !this.participants_.length) {
      return null;
    }
    const features = [];
    const styleLookups = [];
    const layerLookup = [];
    for (let i = 0; i < this.participants_.length; ++i) {
      const layerState = this.participants_[i];
      const layer = layerState.layer;
      const candidateRenderer = layer.getRenderer();
      const layerFeatures = candidateRenderer?.renderedFeatures_ || null;
      if (!layerFeatures || !layerFeatures.length) {
        continue;
      }
      const styleFunction = layer.getStyleFunction
        ? layer.getStyleFunction()
        : null;
      const layerUid = getUid(layer);
      const declutterKey = layer.getDeclutter ? layer.getDeclutter() : null;
      let declutterAllowed = null;
      if (
        declutterKey &&
        candidateRenderer?.frameState?.declutter &&
        candidateRenderer.frameState.declutter[declutterKey]
      ) {
        declutterAllowed = this.getDeclutterFeatureSet_(
          candidateRenderer.frameState.declutter[declutterKey],
          candidateRenderer.frameState.time || this.frameId_,
        );
      }
      for (let j = 0; j < layerFeatures.length; ++j) {
        const feature = layerFeatures[j];
        if (declutterAllowed && !declutterAllowed.has(feature)) {
          continue;
        }
        features.push(layerFeatures[j]);
        styleLookups.push(styleFunction);
        layerLookup.push(layerUid);
      }
    }
    if (!features.length) {
      return null;
    }
    return {features, styleLookups, layerLookup};
  }

  /**
   * @param {import('rbush').default} tree Declutter tree.
   * @param {number} frameTime Frame timestamp.
   * @return {Set<import('../../Feature.js').FeatureLike>} Features currently visible.
   * @private
   */
  getDeclutterFeatureSet_(tree, frameTime) {
    if (!tree) {
      return null;
    }
    let cached = this.declutterFeatureCache_.get(tree) || null;
    if (!cached || cached.frameTime !== frameTime) {
      const entries = tree.all ? tree.all() : [];
      const set = new Set();
      for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        if (entry && entry.value) {
          set.add(entry.value);
        }
      }
      cached = {frameTime, features: set};
      this.declutterFeatureCache_.set(tree, cached);
    }
    return cached.features;
  }

  /**
   * Distribute build time across participating layers for this frame.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
    * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @return {number|null} Milliseconds allotted for this build slice.
   */
  allocateBuildBudget(renderer, frameState) {
    if (!frameState || !frameState.frameBudget) {
      return null;
    }
    if (this.buildFrameId_ !== frameState.time) {
      this.buildFrameId_ = frameState.time;
      this.processedBuilders_.clear();
    }
    const participants = this.buildParticipants_;
    if (!participants || participants.length === 0) {
      return null;
    }
    const layerUid = getUid(renderer.getLayer());
    const participantSet = this.buildParticipantSet_;
    const participates = participantSet
      ? participantSet.has(layerUid)
      : participants.includes(layerUid);
    if (!participates) {
      return null;
    }
    if (this.processedBuilders_.has(layerUid)) {
      return null;
    }
    const processedCount = this.processedBuilders_.size;
    const pending = Math.max(1, participants.length - processedCount);
    const remaining =
      frameState.frameBudget.getRemainingBuildBudget();
    const budget = this.getJobBudget_(remaining, pending);
    this.processedBuilders_.add(layerUid);
    sharedDebugLog('allocate build budget', {
      layer: layerUid,
      frameTime: frameState.time,
      remaining,
      pending,
      budget,
    });
    return budget;
  }

  /**
   * Compute the per-job draw budget for this iteration.
   * @param {number} remaining Remaining draw budget from the FrameBudget.
   * @param {number} jobsRemaining Jobs still queued (including current).
   * @return {number} Milliseconds allotted to the job.
   * @private
   */
  getJobBudget_(remaining, jobsRemaining) {
    if (!isFinite(remaining) || remaining <= 0 || jobsRemaining <= 0) {
      return 0;
    }
    return remaining / jobsRemaining;
  }

  /**
   * Execute all enqueued draw callbacks sequentially.
   */
  draw() {
    if (!this.jobs_.length && !this.pending_.length) {
      return;
    }
    const runQueue = [...this.pending_, ...this.jobs_];
    this.jobs_.length = 0;
    this.pending_.length = 0;
    let currentBudget = null;
    for (let i = 0; i < runQueue.length; ++i) {
      const job = runQueue[i];
      let completed = true;
      const queueRemaining = runQueue.length - i;
      if (job.frameState && job.frameState.frameBudget) {
        if (currentBudget === null) {
          currentBudget =
            job.frameState.frameBudget.getRemainingDrawBudget();
        }
        const jobBudget = this.getJobBudget_(currentBudget, queueRemaining);
        if (job.renderer.setSharedDrawBudget) {
          job.renderer.setSharedDrawBudget(jobBudget);
        }
        sharedDebugLog('assign draw budget', {
          layer: getUid(job.renderer.getLayer()),
          jobBudget,
          queueRemaining,
          frameTime: job.frameState.time,
          remaining: currentBudget,
        });
      } else {
        if (job.renderer.setSharedDrawBudget) {
          job.renderer.setSharedDrawBudget(null);
        }
      }
      try {
        completed = job.callback();
      } finally {
        if (job.renderer.setSharedDrawBudget) {
          job.renderer.setSharedDrawBudget(null);
        }
        this.detachLayer(job.renderer);
      }
      if (!completed) {
        this.pending_.push(job);
        if (job.frameState) {
          job.frameState.animate = true;
        }
        sharedDebugLog('job deferred', {
          layer: getUid(job.renderer.getLayer()),
          frameTime: job.frameState?.time,
        });
      }
      if (job.frameState && job.frameState.frameBudget) {
        currentBudget =
          job.frameState.frameBudget.getRemainingDrawBudget();
      }
    }
  }
}

export default SharedVectorCanvas;
