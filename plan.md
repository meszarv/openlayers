# Shared Vex/Canvas Rendering Plan

Goal: port the shared-canvas/vector scheduling work from `ol-viktor` into `ol-vex-multilayer-switching` so both canvas and Vex renderers can pool DOM canvases, respect a shared frame budget, and auto-switch seamlessly.

## Step 1 – Reintroduce shared frame budgeting primitives
1. Restore `src/ol/render/FrameBudget.js` (class + constants) and wire `Map` to own/reset a `FrameBudget`, adding it to each `frameState`.
2. Add `src/ol/renderer/canvas/VectorLayerTiming.js` and refactor `CanvasVectorLayerRenderer` to use it instead of the inline `frameTimings_` object. Ensure current timing overlays still work.

## Step 2 – Port SharedVectorCanvas infrastructure
1. Add `SharedVectorCanvas` plus helper APIs to `CanvasVectorLayerRenderer` (get manager, attach/detach, render event context, hit detection delegation).
2. Teach `CompositeMapRenderer` to build/cache compatible layer groups, expose them via `frameState.sharedLayerGroups`, and execute `SharedVectorCanvas.draw()` after the layer loop.
3. Update `CanvasVectorLayerRenderer.renderFrame()` / `renderWorlds()` to honor shared managers (shared epochs, deferred draw queue, hit detection fallbacks).

## Step 3 – Extend sharing to Vex renderer
1. Factor out shared-scene handling for `VexVectorLayerRenderer` (shared context, DOM container, queueing).
2. Make `CompositeMapRenderer` share Vex layers similarly, guarding by `rendererHint`.
3. Ensure the Vector layer auto-switch logic continues to work with pooled contexts.

## Step 4 – Validation & polish
1. Exercise canvas-heavy and Vex examples, confirming build overlay/timing displays still behave.
2. Keep debugging hooks (`__OL_SHARED_DEBUG`, `__OL_CHUNK_DEBUG`) operational.
3. Update example docs to mention shared rendering & renderer-switch behaviour.

