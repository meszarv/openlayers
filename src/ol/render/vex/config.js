/**
 * @module ol/render/vex/config
 */

/**
 * Read the build-time preference from the environment when available.
 * @return {boolean} Environment preference or `false` when unset.
 */
function getEnvPreference() {
  if (
    typeof process === 'undefined' ||
    !process ||
    typeof process.env === 'undefined'
  ) {
    return false;
  }
  const value = process.env.OL_USE_REAL_VEX;
  if (typeof value === 'undefined') {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

/**
 * Global runtime override so teams can flip the renderer without rebuilding.
 * @return {boolean} Runtime preference or `null` if unset.
 */
function getRuntimeOverride() {
  if (typeof globalThis === 'undefined') {
    return null;
  }
  if ('__OL_USE_REAL_VEX_RENDERER__' in globalThis) {
    return !!globalThis.__OL_USE_REAL_VEX_RENDERER__;
  }
  if ('OL_USE_REAL_VEX' in globalThis) {
    return !!globalThis.OL_USE_REAL_VEX;
  }
  return null;
}

const DEFAULT_USE_REAL_VEX = true;
let manualOverride = null;

const DEFAULT_VEX_SHARED_LAYER_LIMIT = Infinity;
let sharedLayerLimitOverride = null;

function parseSharedLayerLimit(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function getEnvSharedLayerLimit() {
  if (
    typeof process === 'undefined' ||
    !process ||
    typeof process.env === 'undefined'
  ) {
    return null;
  }
  const value = process.env.OL_VEX_SHARED_LAYER_LIMIT;
  if (typeof value === 'undefined') {
    return null;
  }
  return parseSharedLayerLimit(value);
}

function getRuntimeSharedLayerLimit() {
  if (typeof globalThis === 'undefined') {
    return null;
  }
  if ('__OL_VEX_SHARED_LAYER_LIMIT__' in globalThis) {
    return parseSharedLayerLimit(globalThis.__OL_VEX_SHARED_LAYER_LIMIT__);
  }
  if ('OL_VEX_SHARED_LAYER_LIMIT' in globalThis) {
    return parseSharedLayerLimit(globalThis.OL_VEX_SHARED_LAYER_LIMIT);
  }
  return null;
}

/**
 * Allow tests/examples to override the renderer preference on the fly.
 * Calling with `null` clears the manual override.
 * @param {boolean|null} useRealVex
 */
export function setUseRealVexRenderer(useRealVex) {
  if (useRealVex === null) {
    manualOverride = null;
    return;
  }
  manualOverride = !!useRealVex;
}

/**
 * Determine whether the real Vex GPU implementation should be used.
 * Priority: manual override -> runtime global -> env -> default.
 * @return {boolean}
 */
export function shouldUseRealVexRenderer() {
  if (manualOverride !== null) {
    return manualOverride;
  }
  const runtime = getRuntimeOverride();
  if (runtime !== null) {
    return runtime;
  }
  const envPreference = getEnvPreference();
  if (envPreference) {
    return true;
  }
  return DEFAULT_USE_REAL_VEX;
}

/**
 * Override the maximum number of Vex layers that can be merged.
 * Use `null` to clear the override.
 * @param {number|null} limit
 */
export function setVexSharedLayerLimit(limit) {
  if (limit === null) {
    sharedLayerLimitOverride = null;
    return;
  }
  const parsed = parseSharedLayerLimit(limit);
  if (parsed === null) {
    return;
  }
  sharedLayerLimitOverride = parsed;
}

/**
 * @return {number} Maximum number of Vex layers that can be merged. `-1` means unlimited.
 */
export function getVexSharedLayerLimit() {
  if (sharedLayerLimitOverride !== null) {
    return sharedLayerLimitOverride;
  }
  const runtime = getRuntimeSharedLayerLimit();
  if (runtime !== null) {
    return runtime;
  }
  const env = getEnvSharedLayerLimit();
  if (env !== null) {
    return env;
  }
  return DEFAULT_VEX_SHARED_LAYER_LIMIT;
}
