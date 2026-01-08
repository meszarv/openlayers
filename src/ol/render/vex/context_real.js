const DEFAULT_WORKER_PATH = '/vex/jswrapper/vex.worker.js';
const DEFAULT_SCRIPT_PATH = '/vex/jswrapper/vex.js';

let initPromise = Promise.resolve();
let scriptPromise = null;

function ensureScriptIsLoaded(){
  // Ensure vex is running in browser
  if (typeof window === 'undefined') {
    return Promise.reject(
      new Error('Vex GPU is not available outside the browser environment.'),
    );
  }

  // if vex is already loaded skip initialization sequence
  if (typeof window.initVexGPU === 'function') {
    return Promise.resolve();
  }

  //If script is already being initialized return promise to wait for it
  if (scriptPromise) {
    return scriptPromise;
  }

  //Otherwise try to load script
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = window.vexScriptPath || DEFAULT_SCRIPT_PATH;
    script.async = true;
    script.onload = () => {
      console.log("VEX SCRIPT LOADED");
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

function applyScene(context) {
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

export function createVexContext(canvas){
  //create promise chain
  const oldPromise = initPromise;
  initPromise = new Promise((resolve) => {
    oldPromise.then(()=>{
        //wait for vex.js to be loaded
        ensureScriptIsLoaded().catch((e)=>{
            throw e;
        }).then(()=>{
            //if script is loaded, but there is no init function, script is corrupted
            if (typeof window.initVexGPU !== 'function') {
                throw new Error('initVexGPU is not available after loading the script.');
            }

            //initVexGPU is ran only if chain is resolved
            window.initVexGPU(canvas, {
                interactive: false,
                workerScriptPath: window.vexWorkerPath || DEFAULT_WORKER_PATH,
            }).then(context => {
                //pre-process scene before resolve
                resolve(applyScene(context));
            })
        });
    })
  })

  return initPromise;
}

export default createVexContext;