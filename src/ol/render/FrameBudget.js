/**
 * @module ol/render/FrameBudget
 */

/**
 * The total time the renderer should spend per animation frame.
 * @type {number}
 */
export const DEFAULT_FRAME_TIME_BUDGET_MS = 40;

/**
 * Default build budget (feature -> instructions) per frame.
 * @type {number}
 */
export const DEFAULT_BUILD_TIME_BUDGET_MS =
  DEFAULT_FRAME_TIME_BUDGET_MS / 2;

/**
 * Default draw budget (instructions -> pixels) per frame.
 * @type {number}
 */
export const DEFAULT_DRAW_TIME_BUDGET_MS =
  DEFAULT_FRAME_TIME_BUDGET_MS - DEFAULT_BUILD_TIME_BUDGET_MS;

/**
 * Tracks the amount of time available for build and draw work during a single frame.
 */
class FrameBudget {
  /**
   * @param {number} [buildBudgetMs] Optional build budget override.
   * @param {number} [drawBudgetMs] Optional draw budget override.
   */
  constructor(
    buildBudgetMs = DEFAULT_BUILD_TIME_BUDGET_MS,
    drawBudgetMs = DEFAULT_DRAW_TIME_BUDGET_MS,
  ) {
    /**
     * @private
     * @type {number}
     */
    this.buildBudgetMs_ = buildBudgetMs;

    /**
     * @private
     * @type {number}
     */
    this.drawBudgetMs_ = drawBudgetMs;

    /**
     * @private
     * @type {number}
     */
    this.buildUsedMs_ = 0;

    /**
     * @private
     * @type {number}
     */
    this.drawUsedMs_ = 0;
  }

  /**
   * Reset usage counters for a new frame.
   * @param {number} [buildBudgetMs] Optional build budget override.
   * @param {number} [drawBudgetMs] Optional draw budget override.
   */
  reset(
    buildBudgetMs = this.buildBudgetMs_,
    drawBudgetMs = this.drawBudgetMs_,
  ) {
    this.buildBudgetMs_ = buildBudgetMs;
    this.drawBudgetMs_ = drawBudgetMs;
    this.buildUsedMs_ = 0;
    this.drawUsedMs_ = 0;
  }

  /**
   * @return {number} Remaining build time for this frame (ms).
   */
  getRemainingBuildBudget() {
    return Math.max(0, this.buildBudgetMs_ - this.buildUsedMs_);
  }

  /**
   * @return {number} Remaining draw time for this frame (ms).
   */
  getRemainingDrawBudget() {
    return Math.max(0, this.drawBudgetMs_ - this.drawUsedMs_);
  }

  /**
   * @param {number} durationMs Amount of build time spent (ms).
   */
  consumeBuildTime(durationMs) {
    if (!durationMs) {
      return;
    }
    this.buildUsedMs_ += durationMs;
  }

  /**
   * @param {number} durationMs Amount of draw time spent (ms).
   */
  consumeDrawTime(durationMs) {
    if (!durationMs) {
      return;
    }
    this.drawUsedMs_ += durationMs;
  }
}

export default FrameBudget;
