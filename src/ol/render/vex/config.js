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
