/**
 * @module ol/render/vex/context_real
 */

const WORKER_PATH = '/vex/jswrapper/vex.worker.js';
const SCRIPT_PATH = '/vex/jswrapper/vex.js';

let scriptPromise = null;

/**
 * Load the Vex GPU script once per page.
 * @return {Promise<void>}
 */
function ensureVexScriptLoaded() {
  if (typeof window === 'undefined') {
    return Promise.reject(
      new Error('Vex GPU is not available outside the browser environment.'),
    );
  }
  if (typeof window.initVexGPU === 'function') {
    return Promise.resolve();
  }
  if (scriptPromise) {
    return scriptPromise;
  }
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_PATH;
    script.async = true;
    script.onload = () => {
      if (typeof window.initVexGPU === 'function') {
        resolve();
      } else {
        reject(new Error('Vex GPU script loaded but initVexGPU is undefined.'));
      }
    };
    script.onerror = () => {
      reject(new Error('Failed to load Vex GPU script.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

function ensureSceneViewHelpers(context) {
  let lastSceneView = [0, 0, 1];
  const originalSetSceneView =
    typeof context.setSceneView === 'function'
      ? context.setSceneView.bind(context)
      : null;
  context.setSceneView = (x, y, zoom) => {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    lastSceneView = [safeX, safeY, safeZoom];
    if (originalSetSceneView) {
      originalSetSceneView(safeX, safeY, safeZoom);
    }
  };
  if (typeof context.getSceneView !== 'function') {
    context.getSceneView = () => lastSceneView.slice();
  }
  return context;
}

/**
 * @param {HTMLCanvasElement} canvas Canvas element.
 * @return {Promise<import('./context_mock.js').VexContext>} Vex context promise.
 */
export function createVexContext(canvas) {
  return ensureVexScriptLoaded().then(() => {
    if (typeof window.initVexGPU !== 'function') {
      throw new Error('initVexGPU is not available after loading the script.');
    }
    return window
      .initVexGPU(canvas, {
        interactive: false,
        workerScriptPath: WORKER_PATH,
      })
      .then((context) => ensureSceneViewHelpers(context));
  });
}

export default createVexContext;
