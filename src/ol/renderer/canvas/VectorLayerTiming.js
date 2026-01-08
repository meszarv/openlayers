/**
 * @module ol/renderer/canvas/VectorLayerTiming
 */
import {getUid} from '../../util.js';

const defaultNow =
  typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now();

/**
 * @param {number} start Start timestamp.
 * @return {VectorLayerFrameTiming} Timing state object.
 */
function createTimingState(start) {
  return {
    buildStart: start,
    build: 0,
    draw: 0,
    lod: 0,
    prepare: 0,
    setup: 0,
    preRender: 0,
    postRender: 0,
    renderedFeatures: 0,
    skippedFeatures: 0,
    totalStart: start,
    total: 0,
    buildPending: false,
    buildProgress: 1,
    buildProcessedFeatures: 0,
    buildTotalFeatures: 0,
    buildChunkCount: 0,
  };
}

/**
 * Tracks per-frame timing buckets for canvas vector layers.
 */
class VectorLayerTiming {
  /**
   * @param {import('./VectorLayer.js').default} layer Owning renderer.
   * @param {function():number} [nowFn] Time source function.
   */
  constructor(layer, nowFn = defaultNow) {
    /**
     * @private
     * @type {import('./VectorLayer.js').default}
     */
    this.layer_ = layer;

    /**
     * @private
     * @type {function():number}
     */
    this.now_ = nowFn;

    /**
     * @private
     * @type {VectorLayerFrameTiming|null}
     */
    this.timings_ = null;
  }

  /**
   * Seed counters for the current frame based on previous work.
   * @param {{renderedFeatures:number, skippedFeatures:number, lod:number}|null} buildState
   * Active build state.
   * @param {number} lastRenderedCount Last completed rendered count.
   * @param {number} lastSkippedCount Last completed skipped count.
   */
  seedCounts(buildState, lastRenderedCount, lastSkippedCount) {
    if (!this.timings_) {
      return;
    }
    if (buildState) {
      this.timings_.renderedFeatures = buildState.renderedFeatures || 0;
      this.timings_.skippedFeatures = buildState.skippedFeatures || 0;
      this.timings_.lod = buildState.lod || 0;
    } else {
      this.timings_.renderedFeatures = lastRenderedCount || 0;
      this.timings_.skippedFeatures = lastSkippedCount || 0;
      this.timings_.lod = 0;
    }
  }

  /**
   * Start a new timing session for the current frame.
   * @return {VectorLayerFrameTiming} Active timing state.
   */
  beginFrame() {
    const start = this.now_();
    this.timings_ = createTimingState(start);
    return this.timings_;
  }

  /**
   * @return {VectorLayerFrameTiming|null} Current timing state.
   */
  getTimings() {
    return this.timings_;
  }

  /**
   * Record draw duration.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordDraw(frameState, duration) {
    this.addDuration_(frameState, 'draw', duration);
  }

  /**
   * Record build duration.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordBuild(frameState, duration) {
    this.addDuration_(frameState, 'build', duration);
  }

  /**
   * Record setup duration.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordSetup(frameState, duration) {
    this.addDuration_(frameState, 'setup', duration);
  }

  /**
   * Record pre-render duration.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordPreRender(frameState, duration) {
    this.addDuration_(frameState, 'preRender', duration);
  }

  /**
   * Record post-render duration.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordPostRender(frameState, duration) {
    this.addDuration_(frameState, 'postRender', duration);
  }

  /**
   * Track prepare overhead (work done outside the build timer).
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {number} startTime Start timestamp.
   * @param {number} initialBuild Build time before prepare started.
   */
  recordPrepareOverhead(frameState, startTime, initialBuild) {
    if (!this.timings_ || !isFinite(startTime)) {
      return;
    }
    const totalDuration = Math.max(0, this.now_() - startTime);
    const buildDelta = Math.max(
      0,
      this.timings_.build - (initialBuild || 0),
    );
    const overhead = Math.max(0, totalDuration - buildDelta);
    if (!overhead) {
      return;
    }
    this.timings_.prepare += overhead;
    this.updateLayerTimings(frameState);
  }

  /**
   * Update build progress metadata.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {boolean} pending Build work pending.
   * @param {number} processed Features processed so far.
   * @param {number} total Total features in batch.
   * @param {number} chunkCount Number of chunks produced.
   */
  setBuildProgress(frameState, pending, processed, total, chunkCount) {
    if (!this.timings_) {
      return;
    }
    const safeTotal = Math.max(0, total || 0);
    const safeProcessedRaw = Math.max(0, processed || 0);
    const safeProcessed =
      safeTotal > 0 ? Math.min(safeProcessedRaw, safeTotal) : safeProcessedRaw;
    const progress = safeTotal > 0 ? safeProcessed / safeTotal : pending ? 0 : 1;
    this.timings_.buildPending = pending;
    this.timings_.buildProcessedFeatures = safeProcessed;
    this.timings_.buildTotalFeatures = safeTotal;
    this.timings_.buildProgress = Math.max(0, Math.min(1, progress));
    this.timings_.buildChunkCount = Math.max(0, chunkCount || 0);
    this.updateLayerTimings(frameState);
  }

  /**
   * Ensure frameState.layerTimings is up to date for this renderer.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   */
  updateLayerTimings(frameState) {
    if (!frameState || !this.timings_) {
      return;
    }
    this.ensureLayerTimingMap_(frameState);
    const timings = this.timings_;
    const phaseTotal =
      timings.build +
      timings.draw +
      timings.lod +
      timings.prepare +
      timings.setup +
      timings.preRender +
      timings.postRender;
    timings.total = phaseTotal;
    frameState.layerTimings.set(getUid(this.layer_.getLayer()), {
      build: timings.build,
      draw: timings.draw,
      lod: timings.lod,
      prepare: timings.prepare,
      setup: timings.setup,
      preRender: timings.preRender,
      postRender: timings.postRender,
      renderedFeatures: timings.renderedFeatures,
      skippedFeatures: timings.skippedFeatures,
      total: timings.total,
      buildPending: timings.buildPending,
      buildProgress: timings.buildProgress,
      buildProcessedFeatures: timings.buildProcessedFeatures,
      buildTotalFeatures: timings.buildTotalFeatures,
      buildChunkCount: timings.buildChunkCount,
    });
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {'build'|'draw'|'setup'|'preRender'|'postRender'} bucket Timing bucket to increment.
   * @param {number} duration Duration in milliseconds.
   * @private
   */
  addDuration_(frameState, bucket, duration) {
    if (!this.timings_ || !duration) {
      return;
    }
    this.timings_[bucket] += duration;
    this.updateLayerTimings(frameState);
  }

  /**
   * Ensure layer timing map exists for this frame.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @private
   */
  ensureLayerTimingMap_(frameState) {
    if (
      !frameState.layerTimings ||
      frameState.layerTimingsTimestamp !== frameState.time
    ) {
      frameState.layerTimings = new Map();
      frameState.layerTimingsTimestamp = frameState.time;
    }
  }
}

export default VectorLayerTiming;

/**
 * @typedef {ReturnType<typeof createTimingState>} VectorLayerFrameTiming
 */
