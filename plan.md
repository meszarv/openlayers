## Shared Vector Layer Rendering Plan

Goal: allow many logical `VectorLayer` instances to render on a single physical canvas/renderer when they share the same visual characteristics (e.g., `className`), without changing the public API. The key idea is to separate "logical layers" from "physical renderers" and run a single build/draw pass per shared canvas while keeping per-layer stats, events, and interactions intact.

### Milestone 1: Group compatible layers in the composite renderer
1. Extend `CompositeMapRenderer.renderFrame()` to scan the sorted `layerStatesArray` and build "render groups" of consecutive `VectorLayer` states that can share a surface (same `className`, `declutter` compatibility, identical pixel ratio/transform requirements, no conflicting render events).
2. For each group, ensure only one physical renderer exists: either reuse the renderer from the first layer in the group or create a lightweight "host" renderer object that backs the shared canvas/context.
3. Maintain a mapping from physical renderer → list of logical layer states for this frame. Layers that cannot be grouped still render individually via the existing path.

### Milestone 2: Split canvas vector renderer responsibilities
1. Introduce a `SharedVectorCanvas` helper (new module) that encapsulates canvas/context ownership, pan cache, chunk state, and frame budget accounting. It exposes methods to:
   - beginFrame(frameState)
   - enqueueLayer(layerId, executorGroup, timingHooks, declutter/tree, zIndex ordering)
   - draw(frameState) → runs one clear and processes all queued executor groups respecting the frame budget
   - perform hit detection and post-render bookkeeping per logical layer.
2. Refactor `CanvasVectorLayerRenderer` so that it becomes a thin logical-layer adapter:
   - retains per-layer properties (style, declutter, events, etc.)
   - builds executor groups / build state via `prepareFrame()` as before
   - hands off draw work to the group's `SharedVectorCanvas` instead of calling `renderWorlds()` directly.
3. Ensure `frameTimings_`, build chunk progress, and reported stats remain per logical layer by recording timing deltas before/after each layer's batch inside the shared helper.
4. Interim step (current implementation path): until full state sharing is ready, keep each logical layer's off-screen canvas/context intact and composite/blit its output onto the shared surface once a draw pass completes. This preserves existing chunking logic while still reducing DOM canvases; later milestones can replace the compositing with true shared-context rendering.
5. Outstanding work to finish Milestone 2:
   - Replace the current `SharedCanvasGroup` queue with the real `SharedVectorCanvas` helper that owns the physical host context, pan cache, and chunk bookkeeping.
   - Move pan-cache management, `drawStates_`, and `frameTimings_` updates from each logical renderer into the shared helper so state persists across grouped layers.
   - Provide explicit APIs for logical renderers to register their executor groups, opacity, and z-index, and have the shared helper coordinate clears/composites so only one physical context exists per group.
   - Preserve per-layer events and opacity by having the helper drive `preRender`/`postRender` callbacks with a context wrapper while still referencing the shared canvas.

### Milestone 3: Shared frame budgeting & draw scheduling
1. Extend `SharedVectorCanvas` so it owns the draw scheduler. Instead of replaying per-layer callbacks, it should walk all participating layers’ executor groups in z-index/world order and treat them as one chunked instruction stream.
   - Gather each logical layer’s `drawStates_`/`chunkStates` into the helper, sort by `zIndex`, builder type, and world iteration, and let the helper advance them cooperatively.
   - Consume `frameState.frameBudget` once per chunk (build/draw) and set `frameState.animate = true` when any shared chunk exceeds the remaining budget. Persist draw progress in the helper so layers resume exactly where they paused.
2. Aggregate build-time budgeting: track `buildState_` for each logical layer in the helper so `prepareFrame()` can yield mid-build, enqueueing remaining feature batches for later frames. `SharedVectorCanvas` should call `frameState.frameBudget.consumeBuildTime()` with the combined build time of the group and ensure chunk resumption respects the shared budget.
3. Provide instrumentation hooks (debug logging or counters) so we can confirm that the shared scheduler is interleaving instructions and that deferred chunks resume per frame without starving any layer. These hooks will also feed into Milestone 4’s per-layer timing updates.

### Milestone 4: Preserve layer-level semantics
1. Render events & context wrapping: fire each logical layer’s `prerender`/`postrender` listeners even when the canvas is shared. Provide a context wrapper so user code still receives the expected event payload and DOM references.
2. Visibility, opacity, zIndex, resolution: re-run per-layer visibility gates (min/max resolution/zoom, extent clipping, declutter flags) before enqueuing a shared draw. Respect opacity by either wrapping the draw in save/restore on the host context or compositing from a temporary surface when needed.
3. Layer timings & stats: keep `frameState.layerTimings`, `renderedFeatures`, `skippedFeatures`, and build-progress overlays accurate by recording per-layer start/stop timestamps and counters inside the shared helper.
4. Fallback safeguards: if a layer uses custom render events or renderer-specific state that requires an isolated canvas, detect it and bypass sharing while logging the reason when `__OL_SHARED_DEBUG` is enabled.
5. Declutter/hit-detection hooks: ensure each logical layer’s declutter tree, deferred drawing, and hit-detection caches remain scoped per layer even though the draw surface is shared.

### Milestone 5: Hit detection & interactions
Goal: keep the public interaction APIs (`forEachFeatureAtPixel`, select/modify interactions, hover overlays) working exactly as before when multiple logical layers share one physical canvas.

1. Shared hit-detection context
   - Extend `SharedVectorCanvas` with a hit-detection pipeline mirroring the main draw loop (e.g., `beginHitDetectFrame`, `enqueueHitDetectLayer`, `executeHitDetect`).
   - During `VectorLayerRenderer.getFeaturesAtPixel`, delegate to the shared helper so it can composite all logical layers’ executor groups on the shared hit canvas in z-index order.
   - Update `src/ol/renderer/canvas/hitdetect.js` helpers to accept an explicit logical-layer identifier so `featureCallback(feature, layer)` receives the original logical layer instance even though the pixels come from a shared surface.
   - Files: `src/ol/renderer/canvas/SharedVectorCanvas.js`, `src/ol/renderer/canvas/VectorLayer.js`, `src/ol/renderer/canvas/hitdetect.js`.

2. Logical-layer tagging
   - Ensure every executor group pushed into the shared helper carries metadata (layer UID, declutter tree, style variables) so hit callbacks can filter or short-circuit when `layerFilter` is provided.
   - Keep per-layer `renderBuffer_` / `hitDetectionTransform_` caches so panning/zooming reuses previous buffers independently.

3. Declutter-aware hit detection
   - Maintain separate declutter trees per logical layer (or allow opt-in sharing when layers declare compatibility). Sharing the physical canvas must not merge feature ownership across layers.
   - During hit detection, only evaluate the declutter tree of the logical layer being inspected, ensuring interactions like Select/Modify respect layer boundaries.

4. Acceptance criteria
   - Manual regression using `examples/cluster-multi-scale.html`: verify selecting features with shared className reports the proper layer IDs.
   - Add unit/interaction tests (e.g., in `test/browser/spec/ol/renderer/canvas/VectorLayer.test.js`) that mock multiple logical layers sharing a canvas and confirm `forEachFeatureAtPixel` returns hits grouped by logical layer even when two features overlap spatially.

### Milestone 6: Single-pass shared rendering (no per-layer canvases)
Goal: eliminate the temporary off-screen canvas per logical layer so all grouped layers draw directly on the shared physical context, reducing memory churn and avoiding redundant clears.

1. Shared draw context ownership
   - Move `CanvasVectorLayerRenderer.setDrawContext_()`/`resetDrawContext_()` logic into `SharedVectorCanvas` so the host context is initialized once per frame.
   - Replace the current “draw off-screen → blit” flow with direct calls into `renderWorlds()` using the shared host context. Preserve per-layer alpha/clip semantics via `save/restore` or temporary compositing surfaces only when opacity < 1 or clipping differs.
2. Unified chunk scheduler
   - Teach `SharedVectorCanvas` to walk all logical layers’ `drawStates_` in z-index order, invoking `renderWorlds()` incrementally and consuming the frame budget per chunk. Remove per-layer draw queues once the shared scheduler drives instruction advancement.
   - Persist `chunkStates` and pan-cache metadata inside the helper so each logical layer keeps its progress even though the physical context is shared.
3. Cleanup/off-screen removal
   - Delete any remaining code paths that create per-layer DOM canvases when a shared group is active. Ensure `CanvasVectorLayerRenderer.context` always references the shared host during grouped draws.
   - Update instrumentation (debug logs, frame timings) to reflect the single-pass flow.
4. Validation
   - Stress-test `examples/cluster-multi-scale.html` with 100–500 layers and confirm DOM now contains only one canvas per className group, no visual flashing occurs, and FPS improves relative to the interim compositing path.

### Milestone 7: Fallback rules and safeguards
1. Define compatibility checks (e.g., different `className`, conflicting `declutter`, layer-level renderers that aren't `CanvasVectorLayerRenderer`, uses of custom render events that rely on isolated canvases). If any check fails, skip grouping for those layers to preserve correctness.
2. Provide diagnostics (e.g., debug logging or optional assertions) so library developers can verify when layers are grouped or skipped.

### Milestone 8: Testing & documentation
1. Add unit tests covering grouped rendering: multiple layers sharing a canvas, toggling visibility, rebuilding one layer without affecting the others, verifying `frameState.layerTimings`.
2. Update relevant docs (possibly `DEVELOPING.md` or `agents.md`) to describe the new shared-renderer architecture, including how className influences grouping.
3. Manually validate heavy-layer examples (e.g., `examples/cluster-multi-scale.html`) to ensure FPS improves when many layers share the same className and that behavior matches expectations when class names differ.
