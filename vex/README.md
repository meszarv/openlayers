# Vex mock prototype

This folder contains a mock implementation of the imaginary **Vex** vector rendering engine along with a standalone example that exercises the mock through the browser's `<canvas>` element.

## Implementation plan

1. Define a `createVexContext(canvas)` factory that returns a `Promise` resolving to a proxy object that behaves like a `CanvasRenderingContext2D` while buffering drawing instructions instead of executing them immediately.
2. Capture all mutating canvas method calls and property assignments as instructions so they can be replayed later. Methods that need to produce data synchronously (`measureText`, `createLinearGradient`, etc.) will directly call through to the real 2D context.
3. Implement `commit()`, `setSceneView(x, y, zoom)`, and `clean()` custom methods on the proxy. `commit()` simulates the expensive preprocessing stage before replaying all buffered instructions, `setSceneView()` replays the last committed instructions with a new viewport transform, and `clean()` clears both the buffer and the visible canvas.
4. Build a small example (`vex/example`) that creates the mocked context asynchronously, draws a simple scene, and wires UI controls to `commit()`, `setSceneView()`, and dynamic instruction updates so we can visually verify that the buffer can be re-rendered quickly when panning or zooming the viewport.

## Files

- `mock.js` – the actual Vex mock.
- `example/` – browser-ready demo using the mock without any additional tooling.
