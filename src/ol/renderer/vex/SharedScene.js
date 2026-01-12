/**
 * @module ol/renderer/vex/SharedScene
 */

/**
 * Lightweight manager that lets multiple logical Vex vector layers share a
 * single physical container/canvas/context owned by the host renderer.
 */
class SharedVexScene {
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
     * Saved renderer state so we can restore local canvases/containers on detach.
     * @private
     * @type {Map<import('./VectorLayer.js').default, {
     *   container: HTMLElement,
     *   canvas: HTMLCanvasElement,
     *   vexContext: import('../../render/vex/context.js').VexContext|null,
     *   vexInitPromise: Promise<import('../../render/vex/context.js').VexContext>|null,
     *   canvasPixelWidth: number,
     *   canvasPixelHeight: number
     * }>}
     */
    this.attached_ = new Map();

    /**
     * @private
     * @type {HTMLElement|null}
     */
    this.container_ = null;

    /**
     * @private
     * @type {HTMLCanvasElement|null}
     */
    this.canvas_ = null;

    /**
     * @private
     * @type {number}
     */
    this.frameId_ = 0;

    /**
     * @private
     * @type {Array<import('../../layer/Layer.js').State>|null}
     */
    this.participants_ = null;

    /**
     * Flag to clear the shared Vex context before the next frame.
     * @type {boolean}
     * @private
     */
    this.needsContextClear_ = false;

    /**
     * Tracks epochs so renderers can detect when the shared context was cleared.
     * @type {number}
     * @private
     */
    this.epoch_ = 0;

    /**
     * Tracks whether any participant dirtied the shared scene.
     * @type {boolean}
     * @private
     */
    this.groupDirty_ = false;
  }

  /**
   * Reset for a new frame so we know which layers participate.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   * @param {Array<import('../../layer/Layer.js').State>} [layers] Layer states.
   */
  reset(frameState, layers) {
    this.participants_ = layers ? layers.slice() : null;
    this.frameId_ = frameState ? frameState.time : 0;
    this.groupDirty_ = false;
  }

  /**
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   */
  beginFrame(frameState) {
    this.frameId_ = frameState ? frameState.time : 0;
    this.container_ = this.hostRenderer_.container_;
    this.canvas_ = this.hostRenderer_.canvas_;
    this.clearContextIfNeeded_();
  }

  /**
   * Ensure the host references are ready for this frame.
   * @param {import('../../Map.js').FrameState} frameState Frame state.
   */
  ensureHostReady(frameState) {
    if (!this.container_ || this.frameId_ !== frameState.time) {
      this.beginFrame(frameState);
    }
    this.clearContextIfNeeded_();
  }

  /**
   * Attach a logical renderer so it reuses the host renderer's resources.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   */
  attachLayer(renderer) {
    if (!renderer) {
      return;
    }
    if (!this.container_) {
      this.container_ = this.hostRenderer_.container_;
    }
    if (!this.canvas_) {
      this.canvas_ = this.hostRenderer_.canvas_;
    }
    const existing = this.attached_.get(renderer);
    if (existing) {
      return;
    }
    this.attached_.set(renderer, {
      container: renderer.container_,
      canvas: renderer.canvas_,
      vexContext: renderer.vexContext_,
      vexInitPromise: renderer.vexInitPromise_,
      canvasPixelWidth: renderer.canvasPixelWidth_,
      canvasPixelHeight: renderer.canvasPixelHeight_,
    });
    renderer.container_ = this.hostRenderer_.container_;
    renderer.canvas_ = this.hostRenderer_.canvas_;
    renderer.vexContext_ = this.hostRenderer_.vexContext_;
    renderer.vexInitPromise_ = this.hostRenderer_.vexInitPromise_;
    renderer.canvasPixelWidth_ = this.hostRenderer_.canvasPixelWidth_;
    renderer.canvasPixelHeight_ = this.hostRenderer_.canvasPixelHeight_;
  }

  /**
   * Restore a renderer's local resources after it finishes the shared draw.
   * @param {import('./VectorLayer.js').default} renderer Renderer.
   */
  detachLayer(renderer) {
    const state = this.attached_.get(renderer);
    if (!state) {
      return;
    }
    renderer.container_ = state.container;
    renderer.canvas_ = state.canvas;
    renderer.vexContext_ = state.vexContext;
    renderer.vexInitPromise_ = state.vexInitPromise;
    renderer.canvasPixelWidth_ = state.canvasPixelWidth;
    renderer.canvasPixelHeight_ = state.canvasPixelHeight;
    this.attached_.delete(renderer);
  }

  /**
   * @return {HTMLElement|null} Host container element.
   */
  getContainer() {
    return this.container_ || this.hostRenderer_.container_;
  }

  /**
   * Request that the shared context is cleared before the next frame.
   */
  requestContextClear() {
    this.needsContextClear_ = true;
    this.epoch_ += 1;
  }

  /**
   * @return {number} Current context epoch so renderers can detect clears.
   */
  getEpoch() {
    return this.epoch_;
  }

  /**
   * Clear the host context if requested.
   * @private
   */
  clearContextIfNeeded_() {
    if (!this.needsContextClear_) {
      return;
    }
    this.needsContextClear_ = false;
    const context = this.hostRenderer_.vexContext_;
    if (context && typeof context.clear === 'function') {
      context.clear();
    }
  }

  /**
   * Mark the shared scene dirty so the host redraws.
   */
  markSharedDirty() {
    this.groupDirty_ = true;
  }

  /**
   * @return {boolean} Whether the shared scene was dirtied since last check.
   */
  consumeSharedDirty() {
    const dirty = this.groupDirty_;
    this.groupDirty_ = false;
    return dirty;
  }

  /**
   * Shared canvas version queues draw callbacks. For the Vex scene the work is
   * already performed during prepareFrame, so this is a no-op.
   */
  draw() {}
}

export default SharedVexScene;
