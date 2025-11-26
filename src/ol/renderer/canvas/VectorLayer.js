/**
 * @module ol/renderer/canvas/VectorLayer
 */
import ViewHint from '../../ViewHint.js';
import {ascending, descending, equals} from '../../array.js';
import {wrapX as wrapCoordinateX} from '../../coordinate.js';
import {createCanvasContext2D, releaseCanvas} from '../../dom.js';
import {
  buffer,
  containsExtent,
  createEmpty,
  getHeight,
  getWidth,
  intersects as intersectsExtent,
  wrapX as wrapExtentX,
} from '../../extent.js';
import {
  fromUserExtent,
  getTransformFromProjections,
  getUserProjection,
  toUserExtent,
  toUserResolution,
} from '../../proj.js';
import RenderEventType from '../../render/EventType.js';
import {
  DEFAULT_BUILD_TIME_BUDGET_MS,
  DEFAULT_DRAW_TIME_BUDGET_MS,
} from '../../render/FrameBudget.js';
import CanvasBuilderGroup from '../../render/canvas/BuilderGroup.js';
import ExecutorGroup, {
  ALL,
  DECLUTTER,
  NON_DECLUTTER,
} from '../../render/canvas/ExecutorGroup.js';
import CanvasInstruction from '../../render/canvas/Instruction.js';
import {
  HIT_DETECT_RESOLUTION,
  createHitDetectionImageData,
  hitDetect,
} from '../../render/canvas/hitdetect.js';
import {getUid} from '../../util.js';
import {
  defaultOrder as defaultRenderOrder,
  getSquaredTolerance as getSquaredRenderTolerance,
  getTolerance as getRenderTolerance,
  renderFeature,
} from '../vector.js';
import CanvasLayerRenderer, {canvasPool} from './Layer.js';
import SharedVectorCanvas, {createEventContextEntry} from './SharedVectorCanvas.js';

const now =
  typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now();

const BUILD_TIME_BUDGET_MS = DEFAULT_BUILD_TIME_BUDGET_MS;
const DRAW_TIME_BUDGET_MS = DEFAULT_DRAW_TIME_BUDGET_MS;
const CHUNKED_BUILDER_TYPES = new Set(['Image']);
const INITIAL_DRAW_IMAGE_CHUNK_INSTRUCTIONS = 32;
const MIN_DRAW_IMAGE_CHUNK_INSTRUCTIONS = 8;
const MAX_DRAW_IMAGE_CHUNK_INSTRUCTIONS = 512;
const CHUNK_DURATION_ALPHA = 0.25;
const CHUNK_INCREASE_THRESHOLD = DRAW_TIME_BUDGET_MS * 0.5;
const CHUNK_DECREASE_THRESHOLD = DRAW_TIME_BUDGET_MS * 1.1;
const CHUNK_INCREASE_FACTOR = 1.5;
const CHUNK_DECREASE_FACTOR = 0.75;
const BUILD_OVERLAY_STYLE_ID = 'ol-build-progress-style';
const BUILD_OVERLAY_CLASSNAME = 'ol-build-progress-overlay';
const BUILD_OVERLAY_PROGRESS_CLASS = 'ol-build-progress-circle';

/**
 * @return {void}
 */
function ensureBuildOverlayStyle() {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.getElementById(BUILD_OVERLAY_STYLE_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = BUILD_OVERLAY_STYLE_ID;
  style.textContent = `
    .${BUILD_OVERLAY_CLASSNAME} {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 5;
    }

    .${BUILD_OVERLAY_CLASSNAME}.visible {
      display: flex;
    }

    .${BUILD_OVERLAY_CLASSNAME} svg {
      width: 40px;
      height: 40px;
    }

    .${BUILD_OVERLAY_CLASSNAME} .progress-track {
      fill: none;
      stroke: rgba(120, 120, 120, 0.25);
      stroke-width: 4;
    }

    .${BUILD_OVERLAY_CLASSNAME} .${BUILD_OVERLAY_PROGRESS_CLASS} {
      fill: none;
      stroke: rgba(80, 80, 80, 0.9);
      stroke-width: 4;
      stroke-linecap: round;
      transition: stroke-dashoffset 140ms ease-out;
    }
  `;
  document.head.appendChild(style);
}

function createFrameTimings() {
  const start = now();
  return {
    buildStart: start,
    build: 0,
    draw: 0,
    lod: 0,
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

function computeImageChunkEnd(instructions, start, targetDrawInstructions) {
  const length = instructions.length;
  if (!instructions || start >= length) {
    return {chunkEnd: length, drawInstructions: 0};
  }

  let drawCount = 0;
  let i = start;
  for (; i < length; ++i) {
    const instruction = instructions[i];
    const type = instruction[0];
    if (type === CanvasInstruction.DRAW_IMAGE) {
      drawCount += 1;
    }
    if (type === CanvasInstruction.END_GEOMETRY && drawCount >= targetDrawInstructions) {
      i += 1;
      break;
    }
  }

  if (i === start) {
    return {chunkEnd: Math.min(start + 1, length), drawInstructions: drawCount};
  }

  return {chunkEnd: i, drawInstructions: drawCount};
}

/**
 * @classdesc
 * Canvas renderer for vector layers.
 * @api
 */
class CanvasVectorLayerRenderer extends CanvasLayerRenderer {
  /**
   * @param {import("../../layer/BaseVector.js").default} vectorLayer Vector layer.
   */
  constructor(vectorLayer) {
    super(vectorLayer);

    /** @private */
    this.boundHandleStyleImageChange_ = this.handleStyleImageChange_.bind(this);

    /**
     * @private
     * @type {boolean}
     */
    this.animatingOrInteracting_;

    /**
     * @private
     * @type {ImageData|null}
     */
    this.hitDetectionImageData_ = null;

    /**
     * @private
     * @type {boolean}
     */
    this.clipped_ = false;

    /**
     * @private
     * @type {Array<import("../../Feature.js").default>}
     */
    this.renderedFeatures_ = null;

    /**
     * @private
     * @type {number}
     */
    this.renderedRevision_ = -1;

    /**
     * @private
     * @type {number}
     */
    this.renderedResolution_ = NaN;

    /**
     * @private
     * @type {import("../../extent.js").Extent}
     */
    this.renderedExtent_ = createEmpty();

    /**
     * @private
     * @type {import("../../extent.js").Extent}
     */
    this.wrappedRenderedExtent_ = createEmpty();

    /**
     * @private
     * @type {number}
     */
    this.renderedRotation_;

    /**
     * @private
     * @type {import("../../coordinate").Coordinate}
     */
    this.renderedCenter_ = null;

    /**
     * @private
     * @type {import("../../proj/Projection").default}
     */
    this.renderedProjection_ = null;

    /**
     * @private
     * @type {number}
     */
    this.renderedPixelRatio_ = 1;

    /**
     * @private
     * @type {import("../../render.js").OrderFunction|null}
     */
    this.renderedRenderOrder_ = null;

    /**
     * @private
     * @type {boolean}
     */
    this.renderedFrameDeclutter_;

    /**
     * @private
     * @type {import("../../render/canvas/ExecutorGroup").default}
     */
    this.replayGroup_ = null;

    /**
     * A new replay group had to be created by `prepareFrame()`
     * @type {boolean}
     */
    this.replayGroupChanged = true;

    /**
     * Clipping to be performed by `renderFrame()`
     * @type {boolean}
     */
    this.clipping = true;

    /**
     * @private
     * @type {CanvasRenderingContext2D}
     */
    this.targetContext_ = null;

    /**
     * @private
     * @type {number}
     */
    this.opacity_ = 1;

    /**
     * @private
     * @type {boolean}
     */
    this.drawContextDirty_ = false;

    /**
     * @private
     * @type {HTMLCanvasElement|null}
     */
    this.lastCompositeCanvas_ = null;

    /**
     * @private
     * @type {CanvasRenderingContext2D|null}
     */
    this.lastCompositeContext_ = null;

    /**
     * @private
     * @type {{
     *   drawContext: CanvasRenderingContext2D,
     *   hostCanvas: HTMLCanvasElement,
     *   proxy: CanvasRenderingContext2D,
     *   canvasProxy: HTMLCanvasElement
     * }|null}
     */
    this.localEventContextEntry_ = null;

    /**
     * @private
     * @type {number}
     */
    this.lastRenderedCount_ = 0;

    /**
     * @private
     * @type {number}
     */
    this.lastSkippedCount_ = 0;

    /**
     * @private
     * @type {{buildStart:number, build:number, draw:number, lod:number, renderedFeatures:number, skippedFeatures:number, totalStart:number, total:number}|null}
     */
    this.frameTimings_ = null;

    /**
     * @private
     * @type {{builderGroup:import("../../render/canvas/BuilderGroup.js").default, center:import("../../coordinate.js").Coordinate, extent:import("../../extent.js").Extent, renderedExtent:import("../../extent.js").Extent, resolution:number, pixelRatio:number, renderBuffer:number, revision:number, renderOrder:import("../../render.js").OrderFunction|null, declutter:boolean|undefined, squaredTolerance:number, userTransform:import("../../proj.js").TransformFunction|undefined, features:Array<import("../../Feature.js").default>, featureIndex:number, ready:boolean, renderedFeatures:number, skippedFeatures:number, lod:number, zoom:number|undefined, rotation:number}}
     */
    this.buildState_ = null;

    /**
     * @private
     * @type {Map<string, {
     *   executorGroup: ExecutorGroup,
     *   context: CanvasRenderingContext2D,
     *   builderTypes: Array<import('../../render/canvas.js').BuilderType>,
     *   zIndices: Array<number>,
     *   zIndexPos: number,
     *   builderPos: number,
     *   world: number,
     *   startWorld: number,
     *   endWorld: number,
     *   worldWidth: number|null,
     *   multiWorld: boolean,
     *   transform: import('../../transform.js').Transform|null,
     *   transformWorld: number,
     *   clipCoords: Array<number>|null,
     *   scaledCanvasSize: import('../../size.js').Size,
     *   snapToPixel: boolean,
     *   viewRotation: number,
     *   resolution: number,
     *   center: import('../../coordinate.js').Coordinate,
     *   pixelRatio: number,
     *   width: number,
     *   height: number,
     *   declutterable: boolean|undefined,
     *   declutterTree: import('rbush').default<import('./Executor.js').DeclutterEntry>|null|undefined,
     *   key: string,
     *   completed: boolean,
     *   needsClear: boolean,
     *   sharedEpoch: number,
     *   chunkStates: Map<string, {
     *     instructionIndex: number,
     *     chunkSize: number,
     *     avgDuration: number,
     *   }>
     * }>}
     */
    this.drawStates_ = new Map();

    /**
     * @private
     * @type {HTMLDivElement|null}
     */
    this.buildOverlay_ = null;

    /**
     * @private
     * @type {SVGCircleElement|null}
     */
    this.buildOverlayCircle_ = null;

    /**
     * @private
     * @type {number}
     */
    this.buildOverlayCircumference_ = 0;

    /**
     * @private
     * @type {SharedVectorCanvas|null}
     */
    this.sharedCanvasManager_ = null;

    /**
     * @private
     * @type {number|null}
     */
    this.sharedDrawBudgetMs_ = null;

    /**
     * @private
     * @type {number|null}
     */
    this.sharedBuildBudgetMs_ = null;

  }

  /**
   * @return {SharedVectorCanvas} Shared canvas manager.
   */
  getSharedCanvasManager() {
    if (!this.sharedCanvasManager_) {
      this.sharedCanvasManager_ = new SharedVectorCanvas(this);
    }
    return this.sharedCanvasManager_;
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {({
   *   renderer: CanvasVectorLayerRenderer,
   *   layers: Array<import("../../layer/Layer.js").State>,
   *   manager: SharedVectorCanvas
   * })|null}
   * @private
   */
  getSharedGroup_(frameState) {
    const lookup = frameState.sharedLayerGroupLookup;
    if (!lookup) {
      return null;
    }
    const uid = getUid(this.getLayer());
    return lookup.get(uid) ?? null;
  }

  /**
   * Attach this renderer to a shared canvas manager for the current frame.
   * @param {SharedVectorCanvas} manager Shared manager.
   * @param {boolean} isHost Whether this renderer owns the physical canvas.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {HTMLElement|null} target Host target element (host only).
   * @return {function():void} Detach callback.
   * @private
   */
  attachSharedCanvas_(manager, isHost, frameState, target) {
    if (isHost) {
      manager.beginFrame(frameState, target);
    } else {
      manager.ensureHostReady(frameState);
    }
    manager.attachLayer(this);
    return true;
  }

  /**
   * Return the context that should be passed to render events for this frame.
   * When drawing on a shared surface the returned proxy exposes the host
   * canvas DOM references but forwards drawing operations to the offscreen
   * context that actually records instructions.
   * @param {CanvasRenderingContext2D} drawContext Active drawing context.
   * @param {CanvasRenderingContext2D} hostContext Host canvas context.
   * @param {SharedVectorCanvas|null} sharedManager Shared canvas manager.
   * @return {CanvasRenderingContext2D}
   * @private
   */
  getRenderEventContext_(drawContext, hostContext, sharedManager) {
    if (!drawContext) {
      return drawContext;
    }
    if (sharedManager) {
      return sharedManager.getEventContext(this, drawContext, hostContext);
    }
    if (!hostContext || hostContext === drawContext) {
      this.localEventContextEntry_ = null;
      return drawContext;
    }
    const hostCanvas = hostContext.canvas;
    if (!hostCanvas) {
      this.localEventContextEntry_ = null;
      return drawContext;
    }
    let entry = this.localEventContextEntry_;
    if (
      !entry ||
      entry.drawContext !== drawContext ||
      entry.hostCanvas !== hostCanvas
    ) {
      entry = createEventContextEntry(drawContext, hostCanvas);
      this.localEventContextEntry_ = entry;
    }
    if (!entry) {
      return drawContext;
    }
    return entry.proxy;
  }

  /**
   * Return cached hit-detection context data for the current frame.
   * @return {{
   *   size: import('../../size.js').Size,
   *   transforms: Array<import('../../transform.js').Transform>,
   *   extent: import('../../extent.js').Extent,
   *   resolution: number,
   *   rotation: number,
   *   hitProjection: import('../../proj/Projection.js').default|null,
   *   squaredTolerance: number
   * }|null}
   */
  getSharedHitDetectionConfig() {
    if (
      !this.frameState ||
      !this.renderedCenter_ ||
      !this.renderedProjection_ ||
      !this.wrappedRenderedExtent_
    ) {
      return null;
    }
    const size = this.frameState.size.slice();
    const transforms = this.computeHitDetectionTransforms_(
      size,
      this.renderedCenter_,
      this.renderedResolution_,
      this.renderedRotation_,
      this.renderedProjection_,
      this.wrappedRenderedExtent_,
    );
    if (!transforms.length) {
      return null;
    }
    const resolution = this.renderedResolution_;
    const squaredTolerance = getSquaredRenderTolerance(
      resolution,
      this.renderedPixelRatio_,
    );
    const userProjection = getUserProjection();
    return {
      size,
      transforms,
      extent: this.wrappedRenderedExtent_.slice(),
      resolution,
      rotation: this.renderedRotation_,
      hitProjection: userProjection ? this.renderedProjection_ : null,
      squaredTolerance,
    };
  }

  /**
   * @param {import('../../size.js').Size} size Viewport size.
   * @param {import('../../coordinate.js').Coordinate} center Render center.
   * @param {number} resolution Render resolution.
   * @param {number} rotation Render rotation.
   * @param {import('../../proj/Projection.js').default} projection Projection.
   * @param {import('../../extent.js').Extent} extent Wrapped extent.
   * @return {Array<import('../../transform.js').Transform>}
   * @private
   */
  computeHitDetectionTransforms_(
    size,
    center,
    resolution,
    rotation,
    projection,
    extent,
  ) {
    if (!center || !projection || !extent) {
      return [];
    }
    const transforms = [];
    const width = size[0] * HIT_DETECT_RESOLUTION;
    const height = size[1] * HIT_DETECT_RESOLUTION;
    transforms.push(
      this.getRenderTransform(
        center,
        resolution,
        rotation,
        HIT_DETECT_RESOLUTION,
        width,
        height,
        0,
      ).slice(),
    );
    const layer = this.getLayer();
    const source = layer.getSource();
    const projectionExtent = projection.getExtent();
    if (
      source &&
      source.getWrapX &&
      source.getWrapX() &&
      projection.canWrapX() &&
      !containsExtent(projectionExtent, extent)
    ) {
      let startX = extent[0];
      const worldWidth = getWidth(projectionExtent);
      let world = 0;
      let offsetX;
      while (startX < projectionExtent[0]) {
        --world;
        offsetX = worldWidth * world;
        transforms.push(
          this.getRenderTransform(
            center,
            resolution,
            rotation,
            HIT_DETECT_RESOLUTION,
            width,
            height,
            offsetX,
          ).slice(),
        );
        startX += worldWidth;
      }
      world = 0;
      startX = extent[2];
      while (startX > projectionExtent[2]) {
        ++world;
        offsetX = worldWidth * world;
        transforms.push(
          this.getRenderTransform(
            center,
            resolution,
            rotation,
            HIT_DETECT_RESOLUTION,
            width,
            height,
            offsetX,
          ).slice(),
        );
        startX -= worldWidth;
      }
    }
    return transforms;
  }

  /**
   * @param {ExecutorGroup} executorGroup Executor group.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {boolean} [declutterable] `true` to only render declutterable items,
   *     `false` to only render non-declutterable items, `undefined` to render all.
   * @param {boolean} [usingSharedSurface] Whether the draw targets a shared canvas.
   * @param {import('./SharedVectorCanvas.js').default|null} [sharedManager] Shared canvas manager.
   */
  renderWorlds(
    executorGroup,
    frameState,
    declutterable,
    usingSharedSurface = false,
    sharedManager = null,
  ) {
    const timings = this.frameTimings_;
    const sharedBudgetLimit =
      this.sharedDrawBudgetMs_ !== null ? this.sharedDrawBudgetMs_ : null;
    this.sharedDrawBudgetMs_ = null;
    const frameBudget = frameState.frameBudget ?? null;
    const measureTime = !!(timings || frameBudget);
    const drawStart = now();
    let remainingBudget;
    if (frameBudget) {
      remainingBudget = frameBudget.getRemainingDrawBudget();
    } else if (timings) {
      remainingBudget = Math.max(0, DRAW_TIME_BUDGET_MS - timings.draw);
    } else {
      remainingBudget = DRAW_TIME_BUDGET_MS;
    }
    if (sharedBudgetLimit !== null) {
      remainingBudget = Math.min(remainingBudget, sharedBudgetLimit);
    }

    const skipThisFrame = remainingBudget <= 0;

    const extent = frameState.extent;
    const viewState = frameState.viewState;
    const center = viewState.center;
    const resolution = viewState.resolution;
    const projection = viewState.projection;
    const rotation = viewState.rotation;
    const projectionExtent = projection.getExtent();
    const vectorSource = this.getLayer().getSource();
    const declutter = this.getLayer().getDeclutter();
    const pixelRatio = frameState.pixelRatio;
    const viewHints = frameState.viewHints;
    const snapToPixel = !(
      viewHints[ViewHint.ANIMATING] || viewHints[ViewHint.INTERACTING]
    );
    const context = this.context;
    const canvasSize = [context.canvas.width, context.canvas.height];
    const width = Math.round((getWidth(extent) / resolution) * pixelRatio);
    const height = Math.round((getHeight(extent) / resolution) * pixelRatio);

    const multiWorld = vectorSource.getWrapX() && projection.canWrapX();
    const worldWidth = multiWorld ? getWidth(projectionExtent) : null;
    const endWorld = multiWorld
      ? Math.ceil((extent[2] - projectionExtent[2]) / worldWidth) + 1
      : 1;
    const startWorld = multiWorld
      ? Math.floor((extent[0] - projectionExtent[0]) / worldWidth)
      : 0;

    const builderTypes =
      declutterable === undefined
        ? ALL
        : declutterable
          ? DECLUTTER
          : NON_DECLUTTER;
    let declutterTreeRef = declutterable
      ? declutter && frameState.declutter?.[declutter]
      : undefined;

    const drawKey =
      declutterable === undefined
        ? 'all'
        : declutterable
          ? 'declutter'
          : 'nodeclutter';
    let drawState = this.drawStates_.get(drawKey);
    if (drawState && typeof drawState.sharedEpoch !== 'number') {
      drawState.sharedEpoch = NaN;
    }

    const activeBuildState = this.buildState_;
    const isInteractingFrame =
      frameState.viewHints[ViewHint.ANIMATING] ||
      frameState.viewHints[ViewHint.INTERACTING];
    const buildingNewExecutor =
      drawKey === 'all' &&
      executorGroup === this.replayGroup_ &&
      activeBuildState &&
      activeBuildState.featureIndex < (activeBuildState.features?.length ?? 0) &&
      !isInteractingFrame;
    if (buildingNewExecutor) {
      frameState.animate = true;
      if (measureTime) {
        this.recordDrawDuration_(
          frameState,
          Math.max(0, now() - drawStart),
        );
      }
      if (drawState) {
        executorGroup.renderedContext_ = drawState.context;
      }
      return;
    }
    if (
      declutterable &&
      drawState &&
      drawState.declutterTree &&
      frameState.declutter &&
      declutter &&
      declutterTreeRef !== drawState.declutterTree
    ) {
      frameState.declutter[declutter] = drawState.declutterTree;
      declutterTreeRef = drawState.declutterTree;
    }
    const declutterTreeMatches =
      drawState &&
      ((
        (drawState.declutterTree === null || drawState.declutterTree === undefined) &&
        (declutterTreeRef === null || declutterTreeRef === undefined)
      ) ||
        drawState.declutterTree === declutterTreeRef);

    const needsReset =
      !drawState ||
      drawState.executorGroup !== executorGroup ||
      drawState.context !== context ||
      drawState.pixelRatio !== pixelRatio ||
      drawState.snapToPixel !== snapToPixel ||
      drawState.viewRotation !== rotation ||
      drawState.resolution !== resolution ||
      drawState.center[0] !== center[0] ||
      drawState.center[1] !== center[1] ||
      drawState.width !== width ||
      drawState.height !== height ||
      drawState.startWorld !== startWorld ||
      drawState.endWorld !== endWorld ||
      drawState.declutterable !== declutterable ||
      drawState.builderTypes !== builderTypes ||
      !declutterTreeMatches;

    if (needsReset) {
      let resetReasons;
      if (!drawState) {
        resetReasons = ['noState'];
      } else {
        resetReasons = [];
        if (drawState.executorGroup !== executorGroup) {
          resetReasons.push('executorGroup');
        }
        if (drawState.context !== context) {
          resetReasons.push('context');
        }
        if (drawState.pixelRatio !== pixelRatio) {
          resetReasons.push('pixelRatio');
        }
        if (drawState.snapToPixel !== snapToPixel) {
          resetReasons.push('snapToPixel');
        }
        if (drawState.viewRotation !== rotation) {
          resetReasons.push('rotation');
        }
        if (drawState.resolution !== resolution) {
          resetReasons.push('resolution');
        }
        if (drawState.center[0] !== center[0] || drawState.center[1] !== center[1]) {
          resetReasons.push('center');
        }
        if (drawState.width !== width || drawState.height !== height) {
          resetReasons.push('size');
        }
        if (drawState.startWorld !== startWorld || drawState.endWorld !== endWorld) {
          resetReasons.push('worlds');
        }
        if (drawState.declutterable !== declutterable) {
          resetReasons.push('declutterable');
        }
        if (drawState.builderTypes !== builderTypes) {
          resetReasons.push('builderTypes');
        }
        if (!declutterTreeMatches) {
          resetReasons.push('declutterTree');
        }
      }
      const zIndices = Object.keys(executorGroup.executorsByZIndex_ || {})
        .map(Number)
        .sort(declutterTreeRef ? descending : ascending);
      drawState = {
        executorGroup,
        context,
        builderTypes,
        zIndices,
        zIndexPos: 0,
        builderPos: 0,
        chunkStates: new Map(),
        world: startWorld,
        startWorld,
        endWorld,
        worldWidth,
        multiWorld,
        transform: null,
        transformWorld: NaN,
        clipCoords: null,
        scaledCanvasSize: canvasSize,
        snapToPixel,
        viewRotation: rotation,
        resolution,
        center: center.slice(),
        pixelRatio,
        width,
        height,
        declutterable,
        declutterTree: declutterTreeRef ?? undefined,
        key: drawKey,
        completed: false,
        needsClear: drawKey !== 'declutter',
        sharedEpoch: NaN,
      };
      this.drawStates_.set(drawKey, drawState);
    } else if (drawState) {
      if (!drawState.chunkStates) {
        drawState.chunkStates = new Map();
      }
      const [prevWidth, prevHeight] = drawState.scaledCanvasSize;
      drawState.scaledCanvasSize = canvasSize;
      if (
        (prevWidth !== canvasSize[0] || prevHeight !== canvasSize[1]) &&
        drawKey !== 'declutter'
      ) {
        drawState.needsClear = true;
      }
      drawState.declutterTree = declutterTreeRef ?? undefined;
    }

    if (drawState && drawState.completed) {
      if (measureTime) {
        this.recordDrawDuration_(
          frameState,
          Math.max(0, now() - drawStart),
        );
      }
      executorGroup.renderedContext_ = drawState.context;
      return;
    }

    if (skipThisFrame) {
      frameState.animate = true;
      if (measureTime) {
        this.recordDrawDuration_(
          frameState,
          Math.max(0, now() - drawStart),
        );
      }
      if (drawState) {
        executorGroup.renderedContext_ = drawState.context;
      }
      return;
    }

    if (!drawState || drawState.zIndices.length === 0) {
      if (drawState) {
        drawState.completed = true;
        drawState.needsClear = false;
      }
      if (measureTime) {
        this.recordDrawDuration_(
          frameState,
          Math.max(0, now() - drawStart),
        );
      }
      if (drawState) {
        executorGroup.renderedContext_ = drawState.context;
      }
      return;
    }

    const budgetDeadline = drawStart + remainingBudget;
    const maxBuilderTypes = ALL.length;

    while (drawState.world < drawState.endWorld) {
      if (sharedManager) {
        const managerEpoch = sharedManager.getContextEpoch();
        if (drawState.sharedEpoch !== managerEpoch) {
          const shouldClear = sharedManager.claimEpochClear();
          if (shouldClear) {
            const [canvasWidth, canvasHeight] = drawState.scaledCanvasSize;
            drawState.context.clearRect(0, 0, canvasWidth, canvasHeight);
          }
          drawState.sharedEpoch = managerEpoch;
          drawState.needsClear = false;
        }
      } else if (drawState.needsClear) {
        const [canvasWidth, canvasHeight] = drawState.scaledCanvasSize;
        drawState.context.clearRect(0, 0, canvasWidth, canvasHeight);
        drawState.needsClear = false;
      }
      if (drawState.transformWorld !== drawState.world || !drawState.transform) {
        const offset = drawState.multiWorld
          ? drawState.world * drawState.worldWidth
          : 0;
        let transform = this.getRenderTransform(
          drawState.center,
          drawState.resolution,
          0,
          drawState.pixelRatio,
          drawState.width,
          drawState.height,
          offset,
        );
        if (frameState.declutter) {
          transform = transform.slice(0);
        }
        drawState.transform = transform;
        drawState.transformWorld = drawState.world;
        drawState.clipCoords = executorGroup.getClipCoords(transform);
      }

      const transform = drawState.transform;
      const clipCoords = drawState.clipCoords;
      const zIndices = drawState.zIndices;
      while (drawState.zIndexPos < zIndices.length) {
        const zIndex = zIndices[drawState.zIndexPos];
        const replays = executorGroup.executorsByZIndex_[zIndex.toString()];
        if (!replays) {
          drawState.zIndexPos += 1;
          drawState.builderPos = 0;
          continue;
        }
        while (drawState.builderPos < drawState.builderTypes.length) {
          const builderType = drawState.builderTypes[drawState.builderPos];
          const replay = replays[builderType];
          if (!replay) {
            drawState.builderPos += 1;
            continue;
          }
          let chunkStates = drawState.chunkStates;
          const chunkKey = `${drawState.world}:${zIndex}:${builderType}`;
          const zIndexContext =
            drawState.declutterTree === null ? undefined : replay.getZIndexContext();
          const drawContext = zIndexContext
            ? zIndexContext.getContext()
            : drawState.context;
          const requireClip =
            clipCoords && builderType !== 'Image' && builderType !== 'Text';

          let builderFinalized = false;
          const finalizeBuilder = () => {
            if (builderFinalized) {
              return;
            }
            builderFinalized = true;
            if (zIndexContext) {
              zIndexContext.offset();
              const index = zIndex * maxBuilderTypes + ALL.indexOf(builderType);
              const deferred = executorGroup.deferredZIndexContexts_;
              if (!deferred[index]) {
                deferred[index] = [];
              }
              deferred[index].push(zIndexContext);
            }
            if (chunkStates) {
              chunkStates.delete(chunkKey);
            }
            drawState.builderPos += 1;
          };

          if (!CHUNKED_BUILDER_TYPES.has(builderType)) {
            if (requireClip) {
              drawContext.save();
              executorGroup.clip(drawContext, transform);
            }
            const execStart = timings ? now() : 0;
            replay.execute(
              drawContext,
              drawState.scaledCanvasSize,
              transform,
              drawState.viewRotation,
              drawState.snapToPixel,
              drawState.declutterTree,
            );
            const execDuration = timings ? now() - execStart : 0;
            this.drawContextDirty_ = true;
            if (requireClip) {
              drawContext.restore();
            }
            finalizeBuilder();
            continue;
          }

          if (!chunkStates) {
            chunkStates = new Map();
            drawState.chunkStates = chunkStates;
          }
          let chunkState = chunkStates.get(chunkKey);
          if (!chunkState) {
            chunkState = {
              instructionIndex: 0,
              chunkSize: INITIAL_DRAW_IMAGE_CHUNK_INSTRUCTIONS,
              avgDuration: DRAW_TIME_BUDGET_MS,
            };
            chunkStates.set(chunkKey, chunkState);
          }

          const instructions = replay.instructions || [];
          const chunkStart = chunkState.instructionIndex;
          if (chunkStart >= instructions.length) {
            finalizeBuilder();
            continue;
          }

          const {chunkEnd, drawInstructions} = computeImageChunkEnd(
            instructions,
            chunkStart,
            chunkState.chunkSize,
          );
          if (chunkEnd <= chunkStart) {
            chunkState.instructionIndex = instructions.length;
            finalizeBuilder();
            continue;
          }

          if (requireClip) {
            drawContext.save();
            executorGroup.clip(drawContext, transform);
          }
          const execStart = timings ? now() : 0;
          replay.execute(
            drawContext,
            drawState.scaledCanvasSize,
            transform,
            drawState.viewRotation,
            drawState.snapToPixel,
            drawState.declutterTree,
            chunkStart,
            chunkEnd,
          );
          const execDuration = timings ? now() - execStart : 0;
          this.drawContextDirty_ = true;
          if (requireClip) {
            drawContext.restore();
          }

          chunkState.instructionIndex = chunkEnd;
          if (timings && drawInstructions > 0) {
            const alpha = CHUNK_DURATION_ALPHA;
            const prevAvg = isFinite(chunkState.avgDuration)
              ? chunkState.avgDuration
              : execDuration;
            const updatedAvg =
              alpha * execDuration + (1 - alpha) * (isNaN(prevAvg) ? execDuration : prevAvg);
            chunkState.avgDuration = updatedAvg;
            if (
              updatedAvg > CHUNK_DECREASE_THRESHOLD &&
              chunkState.chunkSize > MIN_DRAW_IMAGE_CHUNK_INSTRUCTIONS
            ) {
              chunkState.chunkSize = Math.max(
                MIN_DRAW_IMAGE_CHUNK_INSTRUCTIONS,
                Math.floor(chunkState.chunkSize * CHUNK_DECREASE_FACTOR),
              );
            } else if (
              updatedAvg < CHUNK_INCREASE_THRESHOLD &&
              chunkState.chunkSize < MAX_DRAW_IMAGE_CHUNK_INSTRUCTIONS
            ) {
              chunkState.chunkSize = Math.min(
                MAX_DRAW_IMAGE_CHUNK_INSTRUCTIONS,
                Math.ceil(chunkState.chunkSize * CHUNK_INCREASE_FACTOR),
              );
            }
          }

          if (chunkState.instructionIndex >= instructions.length) {
            finalizeBuilder();
          }

          const currentTime = now();
          if (timings && currentTime >= budgetDeadline) {
            frameState.animate = true;
            this.recordDrawDuration_(
              frameState,
              Math.max(0, currentTime - drawStart),
            );
            executorGroup.renderedContext_ = drawState.context;
            return;
          }

          if (builderFinalized) {
            continue;
          }
        }
        drawState.builderPos = 0;
        drawState.zIndexPos += 1;
      }
      drawState.zIndexPos = 0;
      drawState.builderPos = 0;
      drawState.world += 1;
      drawState.transform = null;
      drawState.transformWorld = NaN;
    }

    executorGroup.renderedContext_ = drawState.context;
    drawState.completed = true;
    drawState.needsClear = false;

    if (measureTime) {
      const drawDuration = Math.max(0, now() - drawStart);
      this.recordDrawDuration_(frameState, drawDuration);
    }
  }

  /**
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordDrawDuration_(frameState, duration) {
    if (!duration) {
      return;
    }
    if (this.frameTimings_) {
      this.frameTimings_.draw += duration;
      this.updateLayerTimings_(frameState);
    }
    frameState?.frameBudget?.consumeDrawTime(duration);
  }

  /**
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {number} duration Duration in milliseconds.
   */
  recordBuildDuration_(frameState, duration) {
    if (!duration) {
      return;
    }
    if (this.frameTimings_) {
      this.frameTimings_.build += duration;
      this.updateLayerTimings_(frameState);
    }
    frameState?.frameBudget?.consumeBuildTime(duration);
  }

  /**
   * @param {?number} budgetMs Maximum draw time to advance in this invocation.
   */
  setSharedDrawBudget(budgetMs) {
    if (budgetMs === null || budgetMs === undefined || !isFinite(budgetMs)) {
      this.sharedDrawBudgetMs_ = null;
      return;
    }
    this.sharedDrawBudgetMs_ = Math.max(0, budgetMs);
  }

  /**
   * @param {?number} budgetMs Maximum build time for this invocation.
   */
  setSharedBuildBudget(budgetMs) {
    if (budgetMs === null || budgetMs === undefined || !isFinite(budgetMs)) {
      this.sharedBuildBudgetMs_ = null;
      return;
    }
    this.sharedBuildBudgetMs_ = Math.max(0, budgetMs);
  }

  /**
   * @private
   */
  setDrawContext_(force = false) {
    if ((this.opacity_ !== 1 || force) && !this.targetContext_) {
      this.targetContext_ = this.context;
      this.context = createCanvasContext2D(
        this.context.canvas.width,
        this.context.canvas.height,
        canvasPool,
      );
      this.localEventContextEntry_ = null;
      this.drawContextDirty_ = false;
      if (
        this.lastCompositeCanvas_ &&
        this.lastCompositeCanvas_.width === this.context.canvas.width &&
        this.lastCompositeCanvas_.height === this.context.canvas.height
      ) {
        this.context.drawImage(this.lastCompositeCanvas_, 0, 0);
      }
    }
  }

  /**
   * @private
   */
  resetDrawContext_() {
    if (!this.targetContext_) {
      return;
    }
    const alpha = this.targetContext_.globalAlpha;
    this.targetContext_.globalAlpha = this.opacity_;
    if (this.drawContextDirty_) {
      this.targetContext_.drawImage(this.context.canvas, 0, 0);
      this.updateLastComposite_(this.context.canvas);
    } else {
      if (this.lastCompositeCanvas_) {
        this.targetContext_.drawImage(this.lastCompositeCanvas_, 0, 0);
      } else {
      }
    }
    this.targetContext_.globalAlpha = alpha;
    releaseCanvas(this.context);
    canvasPool.push(this.context.canvas);
    this.context = this.targetContext_;
    this.targetContext_ = null;
    this.drawContextDirty_ = false;
    this.localEventContextEntry_ = null;
  }

  /**
   * @private
   * @param {HTMLCanvasElement} canvas Source canvas.
   */
  updateLastComposite_(canvas) {
    let needsInit = false;
    if (
      !this.lastCompositeCanvas_ ||
      this.lastCompositeCanvas_.width !== canvas.width ||
      this.lastCompositeCanvas_.height !== canvas.height
    ) {
      this.lastCompositeCanvas_ = document.createElement('canvas');
      this.lastCompositeCanvas_.width = canvas.width;
      this.lastCompositeCanvas_.height = canvas.height;
      this.lastCompositeContext_ = this.lastCompositeCanvas_.getContext('2d');
      needsInit = true;
    } else if (!this.lastCompositeContext_) {
      this.lastCompositeContext_ = this.lastCompositeCanvas_.getContext('2d');
      needsInit = true;
    }
    if (!this.lastCompositeContext_) {
      return;
    }
    if (!needsInit) {
      this.lastCompositeContext_.clearRect(
        0,
        0,
        this.lastCompositeCanvas_.width,
        this.lastCompositeCanvas_.height,
      );
    }
    this.lastCompositeContext_.drawImage(canvas, 0, 0);
  }

  /**
   * @private
   */
  resetBuildState_() {
    this.buildState_ = null;
    this.resetDrawStates_();
  }

  /**
   * @private
   * @param {boolean} pending Build is still running.
   * @param {number} processed Features processed so far.
   * @param {number} total Total features to process.
   * @param {number} chunkCount Number of build chunks executed.
   */
  setFrameBuildProgress_(pending, processed, total, chunkCount) {
    if (!this.frameTimings_) {
      return;
    }
    const safeTotal = Math.max(0, total || 0);
    const safeProcessedRaw = Math.max(0, processed || 0);
    const safeProcessed =
      safeTotal > 0 ? Math.min(safeProcessedRaw, safeTotal) : safeProcessedRaw;
    const progress = safeTotal > 0 ? safeProcessed / safeTotal : pending ? 0 : 1;
    this.frameTimings_.buildPending = pending;
    this.frameTimings_.buildProcessedFeatures = safeProcessed;
    this.frameTimings_.buildTotalFeatures = safeTotal;
    this.frameTimings_.buildProgress = Math.max(0, Math.min(1, progress));
    this.frameTimings_.buildChunkCount = Math.max(0, chunkCount || 0);
  }

  /**
   * Ensure a DOM overlay exists for rendering build progress.
   * @private
   * @param {import("../../Map.js").default|null} map Owning map.
   */
  ensureBuildOverlay_(map) {
    if (typeof document === 'undefined') {
      return;
    }
    if (!map) {
      this.hideBuildOverlay_(true);
      return;
    }
    ensureBuildOverlayStyle();
    const viewport = map.getViewport();
    if (!viewport) {
      this.hideBuildOverlay_(true);
      return;
    }
    const computedPosition =
      typeof window !== 'undefined'
        ? window.getComputedStyle(viewport).position
        : viewport.style.position;
    if (!computedPosition || computedPosition === 'static') {
      viewport.style.position = 'relative';
    }
    let overlay = this.buildOverlay_;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = BUILD_OVERLAY_CLASSNAME;

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 40 40');
      overlay.appendChild(svg);

      const radius = 14;
      const center = 20;
      const track = document.createElementNS(svgNS, 'circle');
      track.setAttribute('class', 'progress-track');
      track.setAttribute('cx', String(center));
      track.setAttribute('cy', String(center));
      track.setAttribute('r', String(radius));
      svg.appendChild(track);

      const progress = document.createElementNS(svgNS, 'circle');
      progress.setAttribute('class', BUILD_OVERLAY_PROGRESS_CLASS);
      progress.setAttribute('cx', String(center));
      progress.setAttribute('cy', String(center));
      progress.setAttribute('r', String(radius));
      progress.setAttribute('transform', `rotate(-90 ${center} ${center})`);
      svg.appendChild(progress);

      const circumference = 2 * Math.PI * radius;
      progress.setAttribute('stroke-dasharray', String(circumference));
      progress.setAttribute('stroke-dashoffset', String(circumference));

      this.buildOverlay_ = overlay;
      this.buildOverlayCircle_ = progress;
      this.buildOverlayCircumference_ = circumference;
    }

    if (overlay.parentElement !== viewport) {
      if (overlay.parentElement) {
        overlay.parentElement.removeChild(overlay);
      }
      viewport.appendChild(overlay);
    }
  }

  /**
   * Hide the build overlay.
   * @private
   * @param {boolean} remove Remove from DOM entirely.
   */
  hideBuildOverlay_(remove) {
    if (!this.buildOverlay_) {
      return;
    }
    this.buildOverlay_.classList.remove('visible');
    if (this.buildOverlayCircle_) {
      const offset = this.buildOverlayCircumference_ || 0;
      this.buildOverlayCircle_.style.strokeDashoffset = offset
        ? `${offset}`
        : '';
    }
    if (remove && this.buildOverlay_.parentElement) {
      this.buildOverlay_.parentElement.removeChild(this.buildOverlay_);
    }
  }

  /**
   * Update the build overlay for the current frame.
   * @private
   */
  updateBuildOverlay_() {
    if (typeof document === 'undefined') {
      return;
    }
    const timings = this.frameTimings_;
    const map = this.getLayer().getMapInternal();
    const show =
      !!timings &&
      !!timings.buildPending &&
      timings.buildChunkCount >= 3 &&
      timings.buildProgress < 1;
    if (!show) {
      if (!map) {
        this.hideBuildOverlay_(true);
      } else {
        this.hideBuildOverlay_(false);
      }
      return;
    }

    this.ensureBuildOverlay_(map);
    const overlay = this.buildOverlay_;
    if (!overlay) {
      return;
    }

    const progress = Math.max(0, Math.min(1, timings.buildProgress || 0));
    const percent = Math.max(0, Math.min(99, Math.round(progress * 100)));
    if (this.buildOverlayCircle_) {
      const circumference = this.buildOverlayCircumference_;
      if (circumference > 0) {
        const offset = circumference * (1 - percent / 100);
        this.buildOverlayCircle_.style.strokeDashoffset = `${offset}`;
      }
    }

    overlay.classList.add('visible');
  }

  /**
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  updateLayerTimings_(frameState) {
    if (!this.frameTimings_) {
      return;
    }
    this.frameTimings_.total = now() - this.frameTimings_.totalStart;
    if (
      !frameState.layerTimings ||
      frameState.layerTimingsTimestamp !== frameState.time
    ) {
      frameState.layerTimings = new Map();
      frameState.layerTimingsTimestamp = frameState.time;
    }
    const map = frameState.layerTimings;
    const layerUid = getUid(this.getLayer());
    map.set(layerUid, {
      build: this.frameTimings_.build,
      draw: this.frameTimings_.draw,
      lod: this.frameTimings_.lod,
      renderedFeatures: this.frameTimings_.renderedFeatures,
      skippedFeatures: this.frameTimings_.skippedFeatures,
      total: this.frameTimings_.total,
      buildPending: this.frameTimings_.buildPending,
      buildProgress: this.frameTimings_.buildProgress,
      buildProcessedFeatures: this.frameTimings_.buildProcessedFeatures,
      buildTotalFeatures: this.frameTimings_.buildTotalFeatures,
      buildChunkCount: this.frameTimings_.buildChunkCount,
    });
  }

  /**
   * @private
   */
  resetDrawStates_() {
    this.drawStates_.clear();
  }

  /**
   * @return {boolean} Whether the primary draw state is complete.
   * @private
   */
  isPrimaryDrawComplete_() {
    const drawState = this.drawStates_.get('all');
    return !drawState || !!drawState.completed;
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {function():HTMLElement|null} callback Draw callback.
   * @return {boolean} Whether the draw was enqueued for shared execution.
   * @private
   */
  enqueueSharedDraw_(frameState, callback, manager) {
    if (!manager) {
      return false;
    }
    manager.enqueue(this, callback, frameState);
    return true;
  }

  /**
   * Render declutter items for this layer
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  renderDeclutter(frameState) {
    if (!this.replayGroup_ || !this.getLayer().getDeclutter()) {
      return;
    }
    this.renderWorlds(this.replayGroup_, frameState, true, false, null);
  }

  /**
   * @override
   */
  disposeInternal() {
    this.hideBuildOverlay_(true);
    this.buildOverlay_ = null;
    this.buildOverlayCircle_ = null;
    this.buildOverlayCircumference_ = 0;
    super.disposeInternal();
  }

  /**
   * Render deferred instructions.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @override
   */
  renderDeferredInternal(frameState) {
    if (!this.replayGroup_) {
      return;
    }
    this.replayGroup_.renderDeferred();
    if (this.clipped_) {
      this.context.restore();
    }
    this.resetDrawContext_();
  }

  /**
   * Render the layer.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {HTMLElement|null} target Target that may be used to render content to.
   * @return {HTMLElement|null} The rendered element.
   * @override
   */
  renderFrame(frameState, target) {
    const layerState = frameState.layerStatesArray[frameState.layerIndex];
    this.opacity_ = layerState.opacity;
    const viewState = frameState.viewState;

    const sharedGroup = this.getSharedGroup_(frameState);
    const sharedManager = sharedGroup ? sharedGroup.manager : null;
    const sharedHost = sharedGroup ? sharedGroup.renderer : null;
    const participatesInShared = !!sharedManager;
    const isSharedHost = participatesInShared && sharedHost === this;

    let sharedAttached = false;
    if (participatesInShared) {
      sharedAttached = this.attachSharedCanvas_(
        sharedManager,
        isSharedHost,
        frameState,
        isSharedHost ? target : null,
      );
    } else {
      this.prepareContainer(frameState, target);
    }
    const hostContext = this.context;

    const replayGroup = this.replayGroup_;
    let render = replayGroup && !replayGroup.isEmpty();
    if (!render) {
      const hasRenderListeners =
        this.getLayer().hasListener(RenderEventType.PRERENDER) ||
        this.getLayer().hasListener(RenderEventType.POSTRENDER);
      if (!hasRenderListeners && !participatesInShared) {
        return null;
      }
    }

    this.setDrawContext_();
    const frameContext = this.context;

    const eventContext = this.getRenderEventContext_(
      frameContext,
      hostContext,
      participatesInShared ? sharedManager : null,
    );

    this.preRender(eventContext, frameState);

    const executeDraw = () => {
      let sharedDrawStarted = false;
      if (participatesInShared && sharedManager) {
        sharedManager.beginDraw(this);
        sharedDrawStarted = true;
      }
      let completed = false;
      let threw = true;
      try {
        const projection = viewState.projection;

        this.replayGroupChanged = false;

        // clipped rendering if layer extent is set
        this.clipped_ = false;
        if (render && layerState.extent && this.clipping) {
          const layerExtent = fromUserExtent(layerState.extent, projection);
          render = intersectsExtent(layerExtent, frameState.extent);
          this.clipped_ = render && !containsExtent(layerExtent, frameState.extent);
          if (this.clipped_) {
            this.clipUnrotated(frameContext, frameState, layerExtent);
          }
        }

        if (render) {
          const previousContext = this.context;
          this.context = frameContext;
          this.renderWorlds(
            replayGroup,
            frameState,
            this.getLayer().getDeclutter() ? false : undefined,
            participatesInShared,
            participatesInShared ? sharedManager : null,
          );
          this.context = previousContext;
          this.drawContextDirty_ = true;
        }

        if (!frameState.declutter && this.clipped_) {
          frameContext.restore();
        }

        this.postRender(eventContext, frameState);
        this.updateBuildOverlay_();

        if (this.renderedRotation_ !== viewState.rotation) {
          this.renderedRotation_ = viewState.rotation;
          this.hitDetectionImageData_ = null;
        }
        if (!frameState.declutter) {
          this.resetDrawContext_();
        }
        completed = this.isPrimaryDrawComplete_();
        threw = false;
        return completed;
      } finally {
        if (sharedDrawStarted && (threw || completed) && sharedManager) {
          sharedManager.completeDraw(this);
        }
      }
    };

    const outputElement =
      participatesInShared && sharedManager
        ? sharedManager.getContainer() || this.container
        : this.container;

    if (participatesInShared) {
      if (this.enqueueSharedDraw_(frameState, executeDraw, sharedManager)) {
        return outputElement;
      }
    }

    const completed = executeDraw();
    if (participatesInShared && sharedAttached && sharedManager) {
      sharedManager.detachLayer(this);
      sharedAttached = false;
    }
    return outputElement;
  }

  /**
   * Asynchronous layer level hit detection.
   * @param {import("../../pixel.js").Pixel} pixel Pixel.
   * @return {Promise<Array<import("../../Feature").default>>} Promise
   * that resolves with an array of features.
   * @override
   */
  getFeatures(pixel) {
    const fallback = () => this.runLocalHitDetection_(pixel);
    if (!this.frameState) {
      return fallback();
    }
    const sharedGroup = this.getSharedGroup_(this.frameState);
    const sharedManager = sharedGroup ? sharedGroup.manager : null;
    if (
      sharedManager &&
      sharedManager.supportsHitDetection() &&
      !this.animatingOrInteracting_
    ) {
      return sharedManager.getFeaturesForLayer(this, pixel, fallback);
    }
    return fallback();
  }

  /**
   * @param {import('../../pixel.js').Pixel} pixel Pixel.
   * @return {Promise<Array<import('../../Feature.js').default>>}
   * @private
   */
  runLocalHitDetection_(pixel) {
    return new Promise((resolve) => {
      if (
        this.frameState &&
        !this.hitDetectionImageData_ &&
        !this.animatingOrInteracting_
      ) {
        const hitConfig = this.getSharedHitDetectionConfig();
        if (hitConfig) {
          this.hitDetectionImageData_ = createHitDetectionImageData(
            hitConfig.size,
            hitConfig.transforms,
            this.renderedFeatures_,
            this.getLayer().getStyleFunction(),
            hitConfig.extent,
            hitConfig.resolution,
            hitConfig.rotation,
            hitConfig.squaredTolerance,
            hitConfig.hitProjection,
          );
        }
      }
      resolve(
        hitDetect(pixel, this.renderedFeatures_, this.hitDetectionImageData_),
      );
    });
  }

  /**
   * @param {import("../../coordinate.js").Coordinate} coordinate Coordinate.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {number} hitTolerance Hit tolerance in pixels.
   * @param {import("../vector.js").FeatureCallback<T>} callback Feature callback.
   * @param {Array<import("../Map.js").HitMatch<T>>} matches The hit detected matches with tolerance.
   * @return {T|undefined} Callback result.
   * @template T
   * @override
   */
  forEachFeatureAtCoordinate(
    coordinate,
    frameState,
    hitTolerance,
    callback,
    matches,
  ) {
    if (!this.replayGroup_) {
      return undefined;
    }
    const resolution = frameState.viewState.resolution;
    const rotation = frameState.viewState.rotation;
    const layer = this.getLayer();

    /** @type {!Object<string, import("../Map.js").HitMatch<T>|true>} */
    const features = {};

    /**
     * @param {import("../../Feature.js").FeatureLike} feature Feature.
     * @param {import("../../geom/SimpleGeometry.js").default} geometry Geometry.
     * @param {number} distanceSq The squared distance to the click position
     * @return {T|undefined} Callback result.
     */
    const featureCallback = function (feature, geometry, distanceSq) {
      const key = getUid(feature);
      const match = features[key];
      if (!match) {
        if (distanceSq === 0) {
          features[key] = true;
          return callback(feature, layer, geometry);
        }
        matches.push(
          (features[key] = {
            feature: feature,
            layer: layer,
            geometry: geometry,
            distanceSq: distanceSq,
            callback: callback,
          }),
        );
      } else if (match !== true && distanceSq < match.distanceSq) {
        if (distanceSq === 0) {
          features[key] = true;
          matches.splice(matches.lastIndexOf(match), 1);
          return callback(feature, layer, geometry);
        }
        match.geometry = geometry;
        match.distanceSq = distanceSq;
      }
      return undefined;
    };

    const declutter = this.getLayer().getDeclutter();
    return this.replayGroup_.forEachFeatureAtCoordinate(
      coordinate,
      resolution,
      rotation,
      hitTolerance,
      featureCallback,
      declutter
        ? frameState.declutter?.[declutter]?.all().map((item) => item.value)
        : null,
    );
  }

  /**
   * Perform action necessary to get the layer rendered after new fonts have loaded
   * @override
   */
  handleFontsChanged() {
    const layer = this.getLayer();
    if (layer.getVisible() && this.replayGroup_) {
      layer.changed();
    }
  }

  /**
   * Handle changes in image style state.
   * @param {import("../../events/Event.js").default} event Image style change event.
   * @private
   */
  handleStyleImageChange_(event) {
    this.renderIfReadyAndVisible();
  }

  /**
   * Determine whether render should be called.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @override
  */
  prepareFrame(frameState) {
    const timings = createFrameTimings();
    const frameBudget = frameState?.frameBudget ?? null;
    this.sharedBuildBudgetMs_ = null;
    if (frameState) {
      const sharedGroup = this.getSharedGroup_(frameState);
      const sharedManager = sharedGroup ? sharedGroup.manager : null;
      if (sharedManager && frameBudget) {
        const budget = sharedManager.allocateBuildBudget(this, frameState);
        if (budget !== null && budget !== undefined) {
          this.setSharedBuildBudget(budget);
        }
      }
    }
    if (this.buildState_) {
      timings.renderedFeatures = this.buildState_.renderedFeatures;
      timings.skippedFeatures = this.buildState_.skippedFeatures;
      timings.lod = this.buildState_.lod;
    } else {
      timings.renderedFeatures = this.lastRenderedCount_;
      timings.skippedFeatures = this.lastSkippedCount_;
    }
    this.frameTimings_ = timings;
    if (this.buildState_) {
      const initialFeatureCount =
        this.buildState_.featureCount ?? this.buildState_.features?.length ?? 0;
      this.setFrameBuildProgress_(
        true,
        this.buildState_.featureIndex ?? 0,
        initialFeatureCount,
        this.buildState_.chunkCount ?? 0,
      );
    } else {
      this.setFrameBuildProgress_(false, 0, 0, 0);
    }
    if (
      !frameState.layerTimingsTimestamp ||
      frameState.layerTimingsTimestamp !== frameState.time
    ) {
      frameState.layerTimings = new Map();
      frameState.layerTimingsTimestamp = frameState.time;
    }

    const vectorLayer = this.getLayer();
    const vectorSource = vectorLayer.getSource();
    if (!vectorSource) {
      this.resetBuildState_();
      return false;
    }

    const animating = frameState.viewHints[ViewHint.ANIMATING];
    const interacting = frameState.viewHints[ViewHint.INTERACTING];
    const updateWhileAnimating = vectorLayer.getUpdateWhileAnimating();
    const updateWhileInteracting = vectorLayer.getUpdateWhileInteracting();

    if (
      (this.ready && !updateWhileAnimating && animating) ||
      (!updateWhileInteracting && interacting)
    ) {
      this.animatingOrInteracting_ = true;
      return true;
    }
    this.animatingOrInteracting_ = false;

    const frameStateExtent = frameState.extent;
    const viewState = frameState.viewState;
    const projection = viewState.projection;
    const resolution = viewState.resolution;
    const pixelRatio = frameState.pixelRatio;
    const vectorLayerRevision = vectorLayer.getRevision();
    const vectorLayerRenderBuffer = vectorLayer.getRenderBuffer();
    let vectorLayerRenderOrder = vectorLayer.getRenderOrder();

    if (vectorLayerRenderOrder === undefined) {
      vectorLayerRenderOrder = defaultRenderOrder;
    }

    const center = viewState.center.slice();
    const extent = buffer(
      frameStateExtent,
      vectorLayerRenderBuffer * resolution,
    );
    const renderedExtent = extent.slice();
    const loadExtents = [extent.slice()];
    const projectionExtent = projection.getExtent();

    if (
      vectorSource.getWrapX() &&
      projection.canWrapX() &&
      !containsExtent(projectionExtent, frameState.extent)
    ) {
      // For the replay group, we need an extent that intersects the real world
      // (-180° to +180°). To support geometries in a coordinate range from -540°
      // to +540°, we add at least 1 world width on each side of the projection
      // extent. If the viewport is wider than the world, we need to add half of
      // the viewport width to make sure we cover the whole viewport.
      const worldWidth = getWidth(projectionExtent);
      const gutter = Math.max(getWidth(extent) / 2, worldWidth);
      extent[0] = projectionExtent[0] - gutter;
      extent[2] = projectionExtent[2] + gutter;
      wrapCoordinateX(center, projection);
      const loadExtent = wrapExtentX(loadExtents[0], projection);
      // If the extent crosses the date line, we load data for both edges of the worlds
      if (
        loadExtent[0] < projectionExtent[0] &&
        loadExtent[2] < projectionExtent[2]
      ) {
        loadExtents.push([
          loadExtent[0] + worldWidth,
          loadExtent[1],
          loadExtent[2] + worldWidth,
          loadExtent[3],
        ]);
      } else if (
        loadExtent[0] > projectionExtent[0] &&
        loadExtent[2] > projectionExtent[2]
      ) {
        loadExtents.push([
          loadExtent[0] - worldWidth,
          loadExtent[1],
          loadExtent[2] - worldWidth,
          loadExtent[3],
        ]);
      }
    }

    const existingBuildState = this.buildState_;
    let resetReasons;
    if (existingBuildState) {
      resetReasons = [];
      if (existingBuildState.revision !== vectorLayerRevision) {
        resetReasons.push('revision');
      }
      if (existingBuildState.renderOrder !== vectorLayerRenderOrder) {
        resetReasons.push('renderOrder');
      }
      if (existingBuildState.pixelRatio !== pixelRatio) {
        resetReasons.push('pixelRatio');
      }
      if (existingBuildState.resolution !== resolution) {
        resetReasons.push('resolution');
      }
      if (existingBuildState.renderBuffer !== vectorLayerRenderBuffer) {
        resetReasons.push('renderBuffer');
      }
      if (existingBuildState.declutter !== this.getLayer().getDeclutter()) {
        resetReasons.push('declutter');
      }
      if (existingBuildState.rotation !== viewState.rotation) {
        resetReasons.push('rotation');
      }
      if (
        existingBuildState.center[0] !== center[0] ||
        existingBuildState.center[1] !== center[1]
      ) {
        resetReasons.push('center');
      }
    }
    if (existingBuildState && resetReasons && resetReasons.length > 0) {
      this.resetBuildState_();
      timings.renderedFeatures = this.lastRenderedCount_;
      timings.skippedFeatures = this.lastSkippedCount_;
      timings.lod = 0;
    }

    if (
      !this.buildState_ &&
      this.ready &&
      this.renderedResolution_ == resolution &&
      this.renderedRevision_ == vectorLayerRevision &&
      this.renderedRenderOrder_ == vectorLayerRenderOrder &&
      this.renderedFrameDeclutter_ === !!frameState.declutter &&
      containsExtent(this.wrappedRenderedExtent_, extent)
    ) {
      if (!equals(this.renderedExtent_, renderedExtent)) {
        this.hitDetectionImageData_ = null;
        this.renderedExtent_ = renderedExtent;
      }
      this.renderedCenter_ = center;
      this.replayGroupChanged = false;
      this.updateLayerTimings_(frameState);
      return true;
    }

    let buildState = this.buildState_;
    if (!buildState) {
      const builderGroup = new CanvasBuilderGroup(
        getRenderTolerance(resolution, pixelRatio),
        extent,
        resolution,
        pixelRatio,
      );

      const userProjection = getUserProjection();
      let userTransform;
      if (userProjection) {
        for (let i = 0, ii = loadExtents.length; i < ii; ++i) {
          const loadExtent = loadExtents[i];
          const userExtent = toUserExtent(loadExtent, projection);
          vectorSource.loadFeatures(
            userExtent,
            toUserResolution(resolution, projection),
            userProjection,
          );
        }
        userTransform = getTransformFromProjections(userProjection, projection);
      } else {
        for (let i = 0, ii = loadExtents.length; i < ii; ++i) {
          vectorSource.loadFeatures(loadExtents[i], resolution, projection);
        }
      }

      const squaredTolerance = getSquaredRenderTolerance(resolution, pixelRatio);
      const userExtent = toUserExtent(extent, projection);
      const features = vectorSource.getFeaturesInExtent(userExtent);
      if (vectorLayerRenderOrder) {
        features.sort(vectorLayerRenderOrder);
      }
      this.renderedFeatures_ = features;

      buildState = {
        builderGroup,
        center: center.slice(),
        extent: extent.slice(),
        renderedExtent: renderedExtent.slice(),
        resolution,
        pixelRatio,
        renderBuffer: vectorLayerRenderBuffer,
        revision: vectorLayerRevision,
        renderOrder: vectorLayerRenderOrder,
        declutter: this.getLayer().getDeclutter(),
        squaredTolerance,
        userTransform,
        features,
        featureCount: features.length,
        featureIndex: 0,
        ready: true,
        renderedFeatures: 0,
        skippedFeatures: 0,
        lod: 0,
        zoom: viewState.zoom,
        rotation: viewState.rotation,
        chunkCount: 0,
      };
      this.buildState_ = buildState;
      timings.renderedFeatures = 0;
      timings.skippedFeatures = 0;
      timings.lod = 0;
      this.ready = false;
      this.setFrameBuildProgress_(true, 0, buildState.featureCount, 0);
    } else {
      timings.renderedFeatures = buildState.renderedFeatures;
      timings.skippedFeatures = buildState.skippedFeatures;
      timings.lod = buildState.lod;
      if (buildState.featureCount === undefined) {
        buildState.featureCount = buildState.features?.length ?? 0;
      }
      if (buildState.chunkCount === undefined) {
        buildState.chunkCount = 0;
      }
      this.setFrameBuildProgress_(
        true,
        buildState.featureIndex ?? 0,
        buildState.featureCount,
        buildState.chunkCount,
      );
    }

    const builderGroup = buildState.builderGroup;
    const features = buildState.features;
    const squaredTolerance = buildState.squaredTolerance;
    const userTransform = buildState.userTransform;
    const declutter = buildState.declutter;
    const chunkStart = now();
    let availableBuildBudget =
      frameBudget?.getRemainingBuildBudget() ?? BUILD_TIME_BUDGET_MS;
    if (this.sharedBuildBudgetMs_ !== null) {
      const limited = Math.min(availableBuildBudget, this.sharedBuildBudgetMs_);
      availableBuildBudget = limited;
      this.sharedBuildBudgetMs_ = null;
    }
    if (availableBuildBudget <= 0) {
      frameState.animate = true;
      this.lastRenderedCount_ = buildState.renderedFeatures;
      this.lastSkippedCount_ = buildState.skippedFeatures;
      this.updateLayerTimings_(frameState);
      return true;
    }
    const budgetDeadline = chunkStart + availableBuildBudget;
    let ready = buildState.ready;
    let index = buildState.featureIndex;
    const featureCount = buildState.featureCount ?? features.length;
    buildState.featureCount = featureCount;

    while (index < featureCount) {
      const feature = features[index];
      let styles;
      const styleFunction =
        feature.getStyleFunction() || vectorLayer.getStyleFunction();
      if (styleFunction) {
        styles = styleFunction(feature, buildState.resolution);
      }
      if (styles) {
        const dirty = this.renderFeature(
          feature,
          squaredTolerance,
          styles,
          builderGroup,
          userTransform,
          declutter,
          index,
          buildState.resolution,
          buildState.zoom,
        );
        ready = ready && !dirty;
      }
      index += 1;
      if (now() >= budgetDeadline) {
        break;
      }
    }

    this.recordBuildDuration_(frameState, Math.max(0, now() - chunkStart));
    buildState.featureIndex = index;
    buildState.ready = ready;
    buildState.renderedFeatures = timings.renderedFeatures;
    buildState.skippedFeatures = timings.skippedFeatures;
    buildState.lod = timings.lod;

    if (index < featureCount) {
      buildState.chunkCount = (buildState.chunkCount || 0) + 1;
      this.setFrameBuildProgress_(
        true,
        index,
        featureCount,
        buildState.chunkCount,
      );
      frameState.animate = true;
      this.lastRenderedCount_ = buildState.renderedFeatures;
      this.lastSkippedCount_ = buildState.skippedFeatures;
      this.updateLayerTimings_(frameState);
      return true;
    }

    const finalizeStart = now();
    const replayGroupInstructions = builderGroup.finish();
    this.recordBuildDuration_(frameState, Math.max(0, now() - finalizeStart));
    const executorGroup = new ExecutorGroup(
      buildState.extent,
      buildState.resolution,
      buildState.pixelRatio,
      vectorSource.getOverlaps(),
      replayGroupInstructions,
      vectorLayer.getRenderBuffer(),
      !!frameState.declutter,
    );

    this.renderedResolution_ = buildState.resolution;
    this.renderedRevision_ = vectorLayerRevision;
    this.renderedRenderOrder_ = vectorLayerRenderOrder;
    this.renderedFrameDeclutter_ = !!frameState.declutter;
    this.renderedExtent_ = buildState.renderedExtent;
    this.wrappedRenderedExtent_ = buildState.extent;
    this.renderedCenter_ = buildState.center;
    this.renderedProjection_ = projection;
    this.renderedPixelRatio_ = buildState.pixelRatio;
    this.replayGroup_ = executorGroup;
    this.hitDetectionImageData_ = null;

    this.replayGroupChanged = true;
    this.ready = ready;
    this.lastRenderedCount_ = timings.renderedFeatures;
    this.lastSkippedCount_ = timings.skippedFeatures;
    this.setFrameBuildProgress_(
      false,
      featureCount,
      featureCount,
      buildState.chunkCount || 0,
    );
    this.resetBuildState_();
    this.updateLayerTimings_(frameState);
    return true;
  }

  /**
   * @param {import("../../Feature.js").default} feature Feature.
   * @param {number} squaredTolerance Squared render tolerance.
   * @param {import("../../style/Style.js").default|Array<import("../../style/Style.js").default>} styles The style or array of styles.
   * @param {import("../../render/canvas/BuilderGroup.js").default} builderGroup Builder group.
   * @param {import("../../proj.js").TransformFunction} [transform] Transform from user to view projection.
   * @param {boolean} [declutter] Enable decluttering.
   * @param {number} [index] Render order index.
   * @param {number} resolution View resolution.
   * @param {number} zoom Current view zoom.
   * @return {boolean} `true` if an image is loading.
   */
  renderFeature(
    feature,
    squaredTolerance,
    styles,
    builderGroup,
    transform,
    declutter,
    index,
    resolution,
    zoom,
  ) {
    if (!styles) {
      return false;
    }
    let loading = false;
    if (Array.isArray(styles)) {
      for (let i = 0, ii = styles.length; i < ii; ++i) {
        loading =
          renderFeature(
            builderGroup,
            feature,
            styles[i],
            squaredTolerance,
            this.boundHandleStyleImageChange_,
            transform,
            declutter,
            index,
            resolution,
            zoom,
            this.frameTimings_,
          ) || loading;
      }
    } else {
      loading = renderFeature(
        builderGroup,
        feature,
        styles,
        squaredTolerance,
        this.boundHandleStyleImageChange_,
        transform,
        declutter,
        index,
        resolution,
        zoom,
        this.frameTimings_,
      );
    }
    return loading;
  }
}

export default CanvasVectorLayerRenderer;
