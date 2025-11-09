/**
 * @module ol/render/vex/context
 */

const PASS_THROUGH_METHODS = new Set([
  'createLinearGradient',
  'createRadialGradient',
  'createConicGradient',
  'createPattern',
  'createImageData',
  'getImageData',
  'measureText',
  'isPointInPath',
  'isPointInStroke',
  'getLineDash',
]);

const TYPED_ARRAY_CTORS = [
  Float32Array,
  Float64Array,
  Int16Array,
  Int32Array,
  Int8Array,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
].filter(Boolean);

/**
 * @param {unknown} value Value to clone.
 * @return {unknown} Cloned value.
 */
function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }

  if (value && typeof value === 'object') {
    const ctor = value.constructor;
    if (typeof Path2D !== 'undefined' && value instanceof Path2D) {
      return new Path2D(value);
    }

    if (TYPED_ARRAY_CTORS.includes(ctor)) {
      return new ctor(value);
    }
  }

  return value;
}

/**
 * @typedef {CanvasRenderingContext2D & {
 *  commit: () => void,
 *  setSceneView: (x: number, y: number, zoom: number) => void,
 *  clean: () => void,
 *  instructionsCount: number
 * }} VexContext
 */

class VexRecorder {
  /**
   * @param {CanvasRenderingContext2D} nativeContext Native context.
   */
  constructor(nativeContext) {
    /** @type {CanvasRenderingContext2D} */
    this.native = nativeContext;

    /** @type {HTMLCanvasElement} */
    this.canvas = nativeContext.canvas;

    /** @type {Array<Object>} */
    this.instructions = [];

    /** @type {Array<Object>} */
    this.compiledInstructions = [];

    /** @type {{x: number, y: number, zoom: number}} */
    this.viewport = {x: 0, y: 0, zoom: 1};

    /** @type {VexContext} */
    this.proxy = this.createProxy();
  }

  /**
   * @return {VexContext} Proxy context.
   */
  createProxy() {
    const target = {};
    return new Proxy(target, {
      get: (_, prop) => {
        if (prop === 'commit') {
          return this.commit.bind(this);
        }
        if (prop === 'setSceneView') {
          return this.setSceneView.bind(this);
        }
        if (prop === 'clean') {
          return this.clean.bind(this);
        }
        if (prop === 'canvas') {
          return this.canvas;
        }
        if (prop === 'instructionsCount') {
          return this.instructions.length;
        }

        const value = this.native[prop];
        if (typeof value === 'function') {
          if (PASS_THROUGH_METHODS.has(prop)) {
            return value.bind(this.native);
          }
          return (...args) => {
            this.recordCall(prop, args);
          };
        }

        return value;
      },
      set: (_, prop, value) => {
        if (prop in this.native) {
          this.recordSet(prop, value);
          return true;
        }
        this[prop] = value;
        return true;
      },
    });
  }

  /**
   * @param {string|symbol} name Method name.
   * @param {Array<unknown>} args Arguments.
   */
  recordCall(name, args) {
    const clonedArgs = Array.from(args, (arg) => cloneValue(arg));
    this.instructions.push({type: 'call', name, args: clonedArgs});
  }

  /**
   * @param {string|symbol} name Property name.
   * @param {unknown} value Value.
   */
  recordSet(name, value) {
    this.native[name] = value;
    this.instructions.push({type: 'set', name, value: cloneValue(value)});
  }

  /**
   * Commit buffered instructions.
   */
  commit() {
    console.log('[Vex] commit start', {
      pending: this.instructions.length,
    });
    this.preprocessInstructions();
    this.renderCompiledInstructions();
  }

  /**
   * Preprocess instructions (cheap sync step for now).
   */
  preprocessInstructions() {
    this.compiledInstructions = this.instructions.map((instruction, index) => ({
      ...instruction,
      index,
    }));
  }

  /**
   * Render all compiled instructions with the current viewport.
   */
  renderCompiledInstructions() {
    const ctx = this.native;
    const {width, height} = ctx.canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.restore();

    if (!this.compiledInstructions.length) {
      return;
    }

    ctx.save();
    const {x, y, zoom} = this.viewport;
    const scaleX = zoom;
    const scaleY = -zoom;
    const translateX = -x * zoom;
    const translateY = y * zoom;
    ctx.setTransform(scaleX, 0, 0, scaleY, translateX, translateY);
    console.log('[Vex] renderCompiledInstructions transform', {
      zoom,
      scaleX,
      scaleY,
      translateX,
      translateY,
    });

    for (const instruction of this.compiledInstructions) {
      if (instruction.type === 'set') {
        ctx[instruction.name] = instruction.value;
      } else if (instruction.type === 'call') {
        ctx[instruction.name](...instruction.args);
      }
    }

    ctx.restore();
    console.log('[Vex] render complete', {
      instructionCount: this.compiledInstructions.length,
    });
  }

  /**
   * @param {number} [x=0] Viewport x.
   * @param {number} [y=0] Viewport y.
   * @param {number} [zoom=1] Viewport zoom.
   */
  setSceneView(x = 0, y = 0, zoom = 1) {
    const safeX = Number.isFinite(x) ? x : 0;
    const safeY = Number.isFinite(y) ? y : 0;
    const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    this.viewport = {x: safeX, y: safeY, zoom: safeZoom};
    console.log('[Vex] viewport update', {
      inputX: safeX,
      inputY: safeY,
      storedX: this.viewport.x,
      storedY: this.viewport.y,
      zoom: safeZoom,
    });
    if (this.compiledInstructions.length) {
      this.renderCompiledInstructions();
    }
  }

  /**
   * Reset all buffered instructions.
   */
  clean() {
    this.instructions = [];
    this.compiledInstructions = [];
    const ctx = this.native;
    const {width, height} = ctx.canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.restore();
  }
}

/**
 * @param {HTMLCanvasElement} canvas Canvas element.
 * @return {Promise<VexContext>} Vex context promise.
 */
export function createVexContext(canvas) {
  return new Promise((resolve, reject) => {
    const native = canvas.getContext('2d');
    if (!native) {
      reject(new Error('Canvas 2D context is not available.'));
      return;
    }

    requestAnimationFrame(() => {
      const recorder = new VexRecorder(native);
      resolve(recorder.proxy);
    });
  });
}

export default createVexContext;
