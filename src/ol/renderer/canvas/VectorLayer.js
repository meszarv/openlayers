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

const now =
  typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now();

const FRAME_TIME_BUDGET_MS = 40;
const BUILD_TIME_BUDGET_MS = FRAME_TIME_BUDGET_MS / 2;
const DRAW_TIME_BUDGET_MS = FRAME_TIME_BUDGET_MS - BUILD_TIME_BUDGET_MS;
const CHUNKED_BUILDER_TYPES = new Set(['Image']);
const INITIAL_DRAW_IMAGE_CHUNK_INSTRUCTIONS = 32;
const MIN_DRAW_IMAGE_CHUNK_INSTRUCTIONS = 8;
const MAX_DRAW_IMAGE_CHUNK_INSTRUCTIONS = 512;
const CHUNK_DURATION_ALPHA = 0.25;
const CHUNK_INCREASE_THRESHOLD = DRAW_TIME_BUDGET_MS * 0.5;
const CHUNK_DECREASE_THRESHOLD = DRAW_TIME_BUDGET_MS * 1.1;
const CHUNK_INCREASE_FACTOR = 1.5;
const CHUNK_DECREASE_FACTOR = 0.75;
const INTERACTION_CACHE_MARGIN_PX = 256;
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

function chunkDebugEnabled() {
  return typeof window !== 'undefined' && !!window && !!window.__OL_CHUNK_DEBUG;
}

function chunkDebugLog(message, details) {
  if (!chunkDebugEnabled()) {
    return;
  }
  let summary;
  try {
    summary = JSON.stringify(details);
  } catch (err) {
    summary = String(err);
  }
  /* eslint-disable-next-line no-console */
  console.log(`${message} ${summary}`);
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
     * Offscreen cache of the last rendered replay output for interaction reuse.
     * @private
     * @type {{
     *   context: CanvasRenderingContext2D,
     *   extent: import("../../extent.js").Extent,
     *   resolution: number,
     *   rotation: number,
     *   pixelRatio: number,
     *   margin: number,
     *   declutter: boolean,
     *   replayGroupUid: string|null,
     *   completed: boolean,
     *   drawStates: Map<string, unknown>;
     * }|null}
     */
    this.panCache_ = null;

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
  }

  /**
   * @param {ExecutorGroup} executorGroup Executor group.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {boolean} [declutterable] `true` to only render declutterable items,
   *     `false` to only render non-declutterable items, `undefined` to render all.
   */
  renderWorlds(executorGroup, frameState, declutterable) {
    const timings = this.frameTimings_;
    const drawStart = timings ? now() : 0;
    const remainingBudget = timings
      ? Math.max(0, DRAW_TIME_BUDGET_MS - timings.draw)
      : DRAW_TIME_BUDGET_MS;

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
      if (timings) {
        timings.draw += Math.max(0, now() - drawStart);
        this.updateLayerTimings_(frameState);
      }
      if (drawState) {
        executorGroup.renderedContext_ = drawState.context;
      }
      return;
    }
    if (
      drawState &&
      (drawState.center[0] !== center[0] || drawState.center[1] !== center[1])
    ) {
      const dx = center[0] - drawState.center[0];
      const dy = center[1] - drawState.center[1];
      const pixelDelta = Math.sqrt(dx * dx + dy * dy) / resolution;
      chunkDebugLog('VectorLayer center delta', {
        layer: getUid(this.getLayer()),
        drawKey,
        dx,
        dy,
        pixelDelta,
        resolution,
        frameTime: frameState.time,
      });
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
      chunkDebugLog('VectorLayer drawState reset', {
        layer: getUid(this.getLayer()),
        drawKey,
        remainingBudget,
        timingsDraw: timings ? timings.draw : undefined,
        reasons: resetReasons,
        reasonsString:
          resetReasons && resetReasons.length > 0
            ? resetReasons.join(',')
            : undefined,
        frameTime: frameState.time,
      });
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
        chunkDebugLog('VectorLayer drawState marked for clear', {
          layer: getUid(this.getLayer()),
          drawKey,
          frameTime: frameState.time,
        });
      }
      drawState.declutterTree = declutterTreeRef ?? undefined;
    }

    if (drawState && drawState.completed) {
      if (timings) {
        timings.draw += Math.max(0, now() - drawStart);
        this.updateLayerTimings_(frameState);
      }
      executorGroup.renderedContext_ = drawState.context;
      return;
    }

    if (skipThisFrame) {
      frameState.animate = true;
      if (timings) {
        timings.draw += Math.max(0, now() - drawStart);
        this.updateLayerTimings_(frameState);
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
      if (timings) {
        timings.draw += Math.max(0, now() - drawStart);
        this.updateLayerTimings_(frameState);
      }
      if (drawState) {
        executorGroup.renderedContext_ = drawState.context;
      }
      return;
    }

    const budgetDeadline = drawStart + remainingBudget;
    const maxBuilderTypes = ALL.length;

    while (drawState.world < drawState.endWorld) {
      if (drawState.needsClear) {
        const [canvasWidth, canvasHeight] = drawState.scaledCanvasSize;
        chunkDebugLog('VectorLayer clearing draw context', {
          layer: getUid(this.getLayer()),
          drawKey,
          frameTime: frameState.time,
          canvasWidth,
          canvasHeight,
        });
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
            if (timings && execDuration > remainingBudget) {
              chunkDebugLog('VectorLayer replay over budget', {
                layer: getUid(this.getLayer()),
                drawKey,
                builderType,
                zIndex,
                execDuration,
                budget: remainingBudget,
                frameTime: frameState.time,
              });
            }
            if (!this.drawContextDirty_) {
              chunkDebugLog('VectorLayer draw context marked dirty', {
                layer: getUid(this.getLayer()),
                reason: 'draw',
                drawKey,
                builderType,
                zIndex,
                frameTime: frameState.time,
              });
            }
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
          if (timings && execDuration > remainingBudget) {
            chunkDebugLog('VectorLayer replay over budget', {
              layer: getUid(this.getLayer()),
              drawKey,
              builderType,
              zIndex,
              chunkStart,
              chunkEnd,
              drawInstructions,
              execDuration,
              budget: remainingBudget,
              frameTime: frameState.time,
            });
          }
          if (!this.drawContextDirty_) {
            chunkDebugLog('VectorLayer draw context marked dirty', {
              layer: getUid(this.getLayer()),
              reason: 'draw',
              drawKey,
              builderType,
              zIndex,
              frameTime: frameState.time,
            });
          }
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
            chunkDebugLog('VectorLayer draw budget exhausted', {
              layer: getUid(this.getLayer()),
              drawKey,
              world: drawState.world,
              zIndexPos: drawState.zIndexPos,
              builderPos: drawState.builderPos,
              instructionIndex: chunkState.instructionIndex,
              chunkSize: chunkState.chunkSize,
              elapsed: currentTime - drawStart,
              remainingBudget,
              budgetDeadline,
              frameTime: frameState.time,
              animateBefore: !!frameState.animate,
            });
            frameState.animate = true;
            timings.draw += Math.max(0, currentTime - drawStart);
            this.updateLayerTimings_(frameState);
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

    if (timings) {
      const drawDuration = Math.max(0, now() - drawStart);
      timings.draw += drawDuration;
      this.updateLayerTimings_(frameState);
    }
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
      this.drawContextDirty_ = false;
      if (
        this.lastCompositeCanvas_ &&
        this.lastCompositeCanvas_.width === this.context.canvas.width &&
        this.lastCompositeCanvas_.height === this.context.canvas.height
      ) {
        this.context.drawImage(this.lastCompositeCanvas_, 0, 0);
      }
      chunkDebugLog('VectorLayer offscreen context acquired', {
        layer: getUid(this.getLayer()),
        force,
        opacity: this.opacity_,
        frameTime: this.frameState?.time,
      });
    }
  }

  /**
   * @private
   */
  resetDrawContext_() {
    if (!this.targetContext_) {
      chunkDebugLog('VectorLayer composite skipped (no offscreen)', {
        layer: getUid(this.getLayer()),
        dirty: this.drawContextDirty_,
        frameTime: this.frameState?.time,
      });
      return;
    }
    const alpha = this.targetContext_.globalAlpha;
    this.targetContext_.globalAlpha = this.opacity_;
    if (this.drawContextDirty_) {
      this.targetContext_.drawImage(this.context.canvas, 0, 0);
      chunkDebugLog('VectorLayer composite applied', {
        layer: getUid(this.getLayer()),
        dirty: true,
        frameTime: this.frameState?.time,
      });
      this.updateLastComposite_(this.context.canvas);
    } else {
      if (this.lastCompositeCanvas_) {
        this.targetContext_.drawImage(this.lastCompositeCanvas_, 0, 0);
        chunkDebugLog('VectorLayer composite reused last frame', {
          layer: getUid(this.getLayer()),
          frameTime: this.frameState?.time,
        });
      } else {
        chunkDebugLog('VectorLayer composite skipped (clean)', {
          layer: getUid(this.getLayer()),
          dirty: false,
          frameTime: this.frameState?.time,
        });
      }
    }
    this.targetContext_.globalAlpha = alpha;
    releaseCanvas(this.context);
    canvasPool.push(this.context.canvas);
    this.context = this.targetContext_;
    this.targetContext_ = null;
    this.drawContextDirty_ = false;
  }

  /**
   * Drop any cached interaction raster.
   * @private
   */
  invalidatePanCache_() {
    if (this.panCache_) {
      const cacheContext = this.panCache_.context;
      const cacheCanvas = cacheContext.canvas;
      releaseCanvas(cacheContext);
      canvasPool.push(cacheCanvas);
      this.panCache_ = null;
      this.resetDrawStates_();
    }
  }

  /**
   * Ensure we have an interaction cache sized for the current view plus margin.
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {{cache: NonNullable<this['panCache_']>, extent: import("../../extent.js").Extent}}
   */
  ensurePanCache_(frameState) {
    const viewState = frameState.viewState;
    const resolution = viewState.resolution;
    const pixelRatio = frameState.pixelRatio;
    const margin = INTERACTION_CACHE_MARGIN_PX;
    const marginWorld = resolution * margin;
    const extent = buffer(frameState.extent.slice(), marginWorld);
    const cacheWidthPx = Math.max(
      1,
      Math.round((getWidth(extent) / resolution) * pixelRatio),
    );
    const cacheHeightPx = Math.max(
      1,
      Math.round((getHeight(extent) / resolution) * pixelRatio),
    );

    let cache = this.panCache_;
    if (!cache) {
      const context = createCanvasContext2D(
        cacheWidthPx,
        cacheHeightPx,
        canvasPool,
      );
      cache = {
        context,
        extent,
        resolution,
        rotation: viewState.rotation,
        pixelRatio,
        margin,
        declutter: !!this.getLayer().getDeclutter(),
        replayGroupUid: this.replayGroup_ ? getUid(this.replayGroup_) : null,
        completed: false,
        drawStates: new Map(),
      };
      this.panCache_ = cache;
    } else {
      const canvas = cache.context.canvas;
      const sizeChanged = canvas.width !== cacheWidthPx || canvas.height !== cacheHeightPx;
      if (sizeChanged) {
        canvas.width = cacheWidthPx;
        canvas.height = cacheHeightPx;
        this.resetDrawStates_();
        cache.completed = false;
        cache.drawStates = new Map();
      } else {
        const replayGroupUid = this.replayGroup_ ? getUid(this.replayGroup_) : null;
        const needsClear =
          !cache.extent ||
          !equals(cache.extent, extent) ||
          Math.abs(cache.resolution - resolution) > 1e-12 ||
          Math.abs(cache.rotation - viewState.rotation) > 1e-12 ||
          Math.abs(cache.pixelRatio - pixelRatio) > 1e-6 ||
          cache.declutter !== !!this.getLayer().getDeclutter() ||
          cache.replayGroupUid !== replayGroupUid;
        if (needsClear) {
          const context = cache.context;
          context.save();
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.restore();
          cache.completed = false;
          cache.drawStates = new Map();
        }
      }
    }

    return {cache, extent};
  }

  /**
   * Check whether the cached raster fully covers the requested view parameters.
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean}
   */
  canReusePanCache_(frameState) {
    const cache = this.panCache_;
    if (!cache) {
      return false;
    }
    const viewState = frameState.viewState;
    if (!cache.extent) {
      return false;
    }
    if (Math.abs(cache.pixelRatio - frameState.pixelRatio) > 1e-6) {
      return false;
    }
    if (Math.abs(cache.resolution - viewState.resolution) > 1e-12) {
      return false;
    }
    if (Math.abs(cache.rotation - viewState.rotation) > 1e-12) {
      return false;
    }
    if (!containsExtent(cache.extent, frameState.extent)) {
      return false;
    }
    const replayGroup = this.replayGroup_;
    const replayUid = replayGroup ? getUid(replayGroup) : null;
    if (cache.replayGroupUid !== replayUid) {
      return false;
    }
    return true;
  }

  /**
   * Determine if the cached raster should be re-centered around the current view.
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean}
   */
  needsPanCacheRecentering_(frameState) {
    const cache = this.panCache_;
    if (!cache) {
      return true;
    }
    const resolution = frameState.viewState.resolution;
    const safeMargin = (cache.margin * resolution) / 2;
    const safeExtent = buffer(frameState.extent.slice(), safeMargin);
    return !containsExtent(cache.extent, safeExtent);
  }

  /**
   * Render the replay group into the interaction cache, chunking work over frames.
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} `true` when the cache now contains a complete replay.
   */
  renderPanCache_(frameState) {
    const replayGroup = this.replayGroup_;
    if (!replayGroup) {
      this.invalidatePanCache_();
      return false;
    }
    const {cache, extent} = this.ensurePanCache_(frameState);
    const viewState = frameState.viewState;

    const previousContext = this.context;
    const previousDirty = this.drawContextDirty_;
    const previousExtent = frameState.extent;
    const previousDrawStates = this.drawStates_;

    this.context = cache.context;
    frameState.extent = extent;
    this.drawStates_ = cache.drawStates;
    cache.completed = false;

    try {
      this.renderWorlds(
        replayGroup,
        frameState,
        this.getLayer().getDeclutter() ? false : undefined,
      );
    } finally {
      frameState.extent = previousExtent;
      this.context = previousContext;
      this.drawContextDirty_ = previousDirty;
      cache.drawStates = this.drawStates_;
      this.drawStates_ = previousDrawStates;
    }

    cache.extent = extent;
    cache.resolution = viewState.resolution;
    cache.rotation = viewState.rotation;
    cache.pixelRatio = frameState.pixelRatio;
    cache.margin = INTERACTION_CACHE_MARGIN_PX;
    cache.declutter = !!this.getLayer().getDeclutter();
    cache.replayGroupUid = replayGroup ? getUid(replayGroup) : null;
    const drawState = cache.drawStates.get('all');
    cache.completed = !!(drawState && drawState.completed);
    return cache.completed;
  }

  /**
   * Copy the cached raster into the current frame context, aligning by view extent.
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {CanvasRenderingContext2D} frameContext Target context.
   * @return {boolean} `true` if content was drawn.
   */
  blitPanCacheToFrameContext_(frameState, frameContext) {
    const cache = this.panCache_;
    if (!cache || !cache.extent) {
      return false;
    }

    const cacheCanvas = cache.context.canvas;
    const viewExtent = frameState.extent;
    const cacheExtent = cache.extent;
    const resolution = frameState.viewState.resolution;
    const pixelRatio = frameState.pixelRatio;

    const srcWidth = Math.round((getWidth(viewExtent) / resolution) * pixelRatio);
    const srcHeight = Math.round((getHeight(viewExtent) / resolution) * pixelRatio);
    if (srcWidth > cacheCanvas.width || srcHeight > cacheCanvas.height) {
      return false;
    }
    let srcX = Math.round(
      ((viewExtent[0] - cacheExtent[0]) / resolution) * pixelRatio,
    );
    let srcY = Math.round(
      ((cacheExtent[3] - viewExtent[3]) / resolution) * pixelRatio,
    );

    if (srcX < 0) {
      srcX = 0;
    }
    if (srcY < 0) {
      srcY = 0;
    }
    if (srcX + srcWidth > cacheCanvas.width) {
      srcX = cacheCanvas.width - srcWidth;
    }
    if (srcY + srcHeight > cacheCanvas.height) {
      srcY = cacheCanvas.height - srcHeight;
    }

    const destWidth = frameContext.canvas.width;
    const destHeight = frameContext.canvas.height;

    frameContext.save();
    frameContext.setTransform(1, 0, 0, 1, 0, 0);
    frameContext.clearRect(0, 0, destWidth, destHeight);
    frameContext.drawImage(
      cacheCanvas,
      srcX,
      srcY,
      srcWidth,
      srcHeight,
      0,
      0,
      destWidth,
      destHeight,
    );
    frameContext.restore();
    this.drawContextDirty_ = true;
    return true;
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
    const map = frameState.layerTimings;
    if (!map) {
      return;
    }
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
   * Render declutter items for this layer
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  renderDeclutter(frameState) {
    if (!this.replayGroup_ || !this.getLayer().getDeclutter()) {
      return;
    }
    if (this.panCache_ && this.panCache_.completed) {
      const previousContext = this.context;
      const previousDrawStates = this.drawStates_;
      this.context = this.panCache_.context;
      this.drawStates_ = this.panCache_.drawStates;
      this.renderWorlds(this.replayGroup_, frameState, true);
      this.panCache_.drawStates = this.drawStates_;
      this.drawStates_ = previousDrawStates;
      this.context = previousContext;
    } else {
      this.renderWorlds(this.replayGroup_, frameState, true);
    }
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

    this.prepareContainer(frameState, target);
    const context = this.context;

    const replayGroup = this.replayGroup_;
    let render = replayGroup && !replayGroup.isEmpty();
    if (!render) {
      const hasRenderListeners =
        this.getLayer().hasListener(RenderEventType.PRERENDER) ||
        this.getLayer().hasListener(RenderEventType.POSTRENDER);
      if (!hasRenderListeners) {
        return null;
      }
    }

    this.setDrawContext_(true);
    const frameContext = this.context;

    this.preRender(context, frameState);

    const projection = viewState.projection;
    const viewHints = frameState.viewHints;
    const animating = viewHints[ViewHint.ANIMATING];
    const interacting = viewHints[ViewHint.INTERACTING];
    const interactionActive = animating || interacting;

    if (!replayGroup) {
      this.invalidatePanCache_();
    } else if (this.replayGroupChanged) {
      this.invalidatePanCache_();
    }
    this.replayGroupChanged = false;

    let panCacheReusable = this.canReusePanCache_(frameState);
    let panCacheRenderedThisFrame = false;
    if (render) {
      const shouldRefreshCache =
        !panCacheReusable || (!interactionActive && this.needsPanCacheRecentering_(frameState));
      if (shouldRefreshCache) {
        this.renderPanCache_(frameState);
        panCacheRenderedThisFrame = true;
        panCacheReusable = this.canReusePanCache_(frameState);
      }
    }

    if (!render) {
      this.invalidatePanCache_();
    }

    // clipped rendering if layer extent is set
    this.clipped_ = false;
    if (render && layerState.extent && this.clipping) {
      const layerExtent = fromUserExtent(layerState.extent, projection);
      render = intersectsExtent(layerExtent, frameState.extent);
      this.clipped_ = render && !containsExtent(layerExtent, frameState.extent);
      if (this.clipped_) {
        this.clipUnrotated(context, frameState, layerExtent);
      }
    }

    if (render) {
      let drawn = false;
      const cache = this.panCache_;
      if (panCacheReusable) {
        drawn = this.blitPanCacheToFrameContext_(frameState, frameContext);
      }
      const cacheNeedsProgress = !!(cache && !cache.completed);
      if (cache && (!drawn || !panCacheReusable || cacheNeedsProgress)) {
        let cacheComplete = cache && cache.completed;
        if (!panCacheRenderedThisFrame || !drawn || !panCacheReusable) {
          cacheComplete = this.renderPanCache_(frameState);
          panCacheRenderedThisFrame = true;
          panCacheReusable = this.canReusePanCache_(frameState);
          if (panCacheReusable) {
            const refreshed = this.blitPanCacheToFrameContext_(frameState, frameContext);
            drawn = drawn || refreshed;
          }
        }
        const updatedCache = this.panCache_;
        const stillIncomplete = !!(updatedCache && !updatedCache.completed);
        if (!cacheComplete || cacheNeedsProgress || stillIncomplete) {
          frameState.animate = true;
        }
      }
      if (!drawn) {
        const cache = this.panCache_;
        if (!cache || cache.completed) {
          this.invalidatePanCache_();
        }
        const previousContext = this.context;
        this.context = frameContext;
        this.renderWorlds(
          replayGroup,
          frameState,
          this.getLayer().getDeclutter() ? false : undefined,
        );
        this.context = previousContext;
        this.drawContextDirty_ = true;
      }
    }

    if (!frameState.declutter && this.clipped_) {
      context.restore();
    }

    this.postRender(context, frameState);
    this.updateBuildOverlay_();

    if (this.renderedRotation_ !== viewState.rotation) {
      this.renderedRotation_ = viewState.rotation;
      this.hitDetectionImageData_ = null;
    }
    if (!frameState.declutter) {
      this.resetDrawContext_();
    }
    return this.container;
  }

  /**
   * Asynchronous layer level hit detection.
   * @param {import("../../pixel.js").Pixel} pixel Pixel.
   * @return {Promise<Array<import("../../Feature").default>>} Promise
   * that resolves with an array of features.
   * @override
   */
  getFeatures(pixel) {
    return new Promise((resolve) => {
      if (
        this.frameState &&
        !this.hitDetectionImageData_ &&
        !this.animatingOrInteracting_
      ) {
        const size = this.frameState.size.slice();
        const center = this.renderedCenter_;
        const resolution = this.renderedResolution_;
        const rotation = this.renderedRotation_;
        const projection = this.renderedProjection_;
        const extent = this.wrappedRenderedExtent_;
        const layer = this.getLayer();
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
        const source = layer.getSource();
        const projectionExtent = projection.getExtent();
        if (
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
        const userProjection = getUserProjection();
        this.hitDetectionImageData_ = createHitDetectionImageData(
          size,
          transforms,
          this.renderedFeatures_,
          layer.getStyleFunction(),
          extent,
          resolution,
          rotation,
          getSquaredRenderTolerance(resolution, this.renderedPixelRatio_),
          userProjection ? projection : null,
        );
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
      timings.build += Math.max(0, now() - timings.buildStart);
      this.updateLayerTimings_(frameState);
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
      chunkDebugLog('VectorLayer buildState reset', {
        layer: getUid(this.getLayer()),
        featureIndex: existingBuildState.featureIndex,
        featureCount: existingBuildState.features?.length ?? 0,
        ready: existingBuildState.ready,
        reasons: resetReasons,
        reasonsString:
          resetReasons && resetReasons.length > 0
            ? resetReasons.join(',')
            : undefined,
        frameTime: frameState.time,
      });
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
      timings.build += Math.max(0, now() - timings.buildStart);
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
      chunkDebugLog('VectorLayer buildState start', {
        layer: getUid(this.getLayer()),
        featureCount: features.length,
        frameTime: frameState.time,
      });
      this.setFrameBuildProgress_(true, 0, buildState.featureCount, 0);
    } else {
      timings.renderedFeatures = buildState.renderedFeatures;
      timings.skippedFeatures = buildState.skippedFeatures;
      timings.lod = buildState.lod;
      chunkDebugLog('VectorLayer buildState resume', {
        layer: getUid(this.getLayer()),
        featureIndex: buildState.featureIndex,
        featureCount: buildState.features?.length ?? 0,
        ready: buildState.ready,
        frameTime: frameState.time,
      });
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
    const budgetDeadline = chunkStart + BUILD_TIME_BUDGET_MS;
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

    timings.build += Math.max(0, now() - chunkStart);
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
    timings.build += Math.max(0, now() - finalizeStart);
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
