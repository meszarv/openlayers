import Feature from '../src/ol/Feature.js';
import OlMap from '../src/ol/Map.js';
import {unByKey} from '../src/ol/Observable.js';
import View from '../src/ol/View.js';
import Polygon from '../src/ol/geom/Polygon.js';
import TileLayer from '../src/ol/layer/Tile.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import {fromLonLat} from '../src/ol/proj.js';
import OSM from '../src/ol/source/OSM.js';
import VectorSource from '../src/ol/source/Vector.js';
import Fill from '../src/ol/style/Fill.js';
import Stroke from '../src/ol/style/Stroke.js';
import Style from '../src/ol/style/Style.js';
import {setUseRealVexRenderer} from '../src/ol/render/vex/config.js';

const LAYER_COUNT = 250;
const FEATURES_PER_LAYER = 20;
const GRID_COLUMNS = 25;
const GRID_ROWS = Math.ceil(LAYER_COUNT / GRID_COLUMNS);
const CELL_SPACING = 9000;
const VERT_SPREAD = CELL_SPACING * 0.35;

const mapCenter = fromLonLat([-98.5, 38.0]);

setUseRealVexRenderer(false);
setTimeout(() => {
  setUseRealVexRenderer(true);
}, 2000);

const baseLayer = new TileLayer({
  source: new OSM(),
});

const map = new OlMap({
  target: 'map',
  layers: [baseLayer],
  view: new View({
    center: mapCenter,
    minZoom: 6,
    maxZoom: 19,
    zoom: 8,
  }),
});

const modeStatusEl = document.getElementById('mode-status');
const layerCountEl = document.getElementById('layer-count');
const featureCountEl = document.getElementById('feature-count');
const modeInputs = document.querySelectorAll(
  'input[name="renderer-mode"]',
);
const visibleLayerInput = document.getElementById('visible-layer-count');
const visibleLayerValue = document.getElementById('visible-layer-value');

const vectorLayers = [];
const styleCache = new Map();
let currentRendererHint = 'vex';
let activeRendererLabel = 'vex';
const view = map.getView();
let viewResolutionKey = null;
const mapLayers = map.getLayers();
let visibleLayerTarget = 1;

function updateStats() {
  if (layerCountEl) {
    layerCountEl.textContent = String(visibleLayerTarget);
  }
  if (featureCountEl) {
    const visibleFeatures = visibleLayerTarget * FEATURES_PER_LAYER;
    featureCountEl.textContent = visibleFeatures.toLocaleString();
  }
  if (visibleLayerValue) {
    visibleLayerValue.textContent = String(visibleLayerTarget);
  }
  if (modeStatusEl) {
    modeStatusEl.textContent =
      currentRendererHint === 'vex'
        ? activeRendererLabel === 'vex'
          ? 'Active renderer: Vex (auto-switch enabled)'
          : 'Active renderer: Canvas (auto-switch temporarily using canvas)'
        : 'Active renderer: Canvas (canvas-only mode)';
  }
}

function createLayerStyle(index) {
  if (styleCache.has(index)) {
    return styleCache.get(index);
  }
  const hue = Math.round((index / LAYER_COUNT) * 360);
  const fillColor = `hsla(${hue}, 70%, 55%, 0.45)`;
  const strokeColor = `hsl(${hue}, 50%, 25%)`;
  const style = new Style({
    fill: new Fill({color: fillColor}),
    stroke: new Stroke({color: strokeColor, width: 1.2}),
  });
  styleCache.set(index, style);
  return style;
}

function getLayerOrigin(index) {
  const col = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  const originX = mapCenter[0] + (col - GRID_COLUMNS / 2) * CELL_SPACING;
  const originY = mapCenter[1] + (row - GRID_ROWS / 2) * CELL_SPACING;
  return [originX, originY];
}

function createLayerFeatures(index) {
  const [originX, originY] = getLayerOrigin(index);
  const features = [];
  for (let i = 0; i < FEATURES_PER_LAYER; ++i) {
    const baseAngle = (i / FEATURES_PER_LAYER) * Math.PI * 2;
    const ringRadius = 2000 + Math.random() * 1600;
    const jitterX = (Math.random() - 0.5) * VERT_SPREAD;
    const jitterY = (Math.random() - 0.5) * VERT_SPREAD;
    const centerX =
      originX + Math.cos(baseAngle) * ringRadius + jitterX;
    const centerY =
      originY + Math.sin(baseAngle) * ringRadius + jitterY;
    const halfSize = 400 + Math.random() * 500;
    const rotation = Math.random() * Math.PI * 2;
    const corners = [];
    for (let corner = 0; corner < 4; ++corner) {
      const cornerAngle = rotation + (corner / 4) * Math.PI * 2;
      const x = centerX + Math.cos(cornerAngle) * halfSize;
      const y = centerY + Math.sin(cornerAngle) * halfSize;
      corners.push([x, y]);
    }
    corners.push(corners[0]);
    const polygon = new Polygon([corners]);
    const feature = new Feature({
      geometry: polygon,
      id: `layer-${index}-feature-${i}`,
    });
    features.push(feature);
  }
  return features;
}

function createVectorLayer(index, rendererHint) {
  const source = new VectorSource({
    features: createLayerFeatures(index),
  });
  return new VectorLayer({
    source,
    rendererHint,
    style: createLayerStyle(index),
  });
}

function rebuildLayers(rendererHint) {
  vectorLayers.forEach((layer) => {
    mapLayers.remove(layer);
  });
  vectorLayers.length = 0;
  const freshLayers = [];
  for (let i = 0; i < LAYER_COUNT; ++i) {
    const layer = createVectorLayer(i, rendererHint);
    freshLayers.push(layer);
    mapLayers.push(layer);
  }
  vectorLayers.push(...freshLayers);
  currentRendererHint = rendererHint;
  attachViewListener();
  updateActiveRendererLabel();
  applyVisibleLayerLimit();
  map.renderSync();
}

function handleModeChange(event) {
  const value = event.target.value;
  const rendererHint = value === 'auto' ? 'vex' : 'canvas';
  rebuildLayers(rendererHint);
}

modeInputs.forEach((input) => {
  input.addEventListener('change', handleModeChange);
});

visibleLayerInput?.addEventListener('input', (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  visibleLayerTarget = Number(input.value);
  applyVisibleLayerLimit();
});

function detachViewListener() {
  if (viewResolutionKey) {
    unByKey(viewResolutionKey);
    viewResolutionKey = null;
  }
}

function attachViewListener() {
  detachViewListener();
  viewResolutionKey = view.on('change:resolution', () => {
    updateActiveRendererLabel();
    updateStats();
  });
}

function updateActiveRendererLabel() {
  if (!vectorLayers.length) {
    activeRendererLabel = 'vex';
    return;
  }
  const firstLayer = vectorLayers[0];
  if (typeof firstLayer.getActiveRendererHint === 'function') {
    activeRendererLabel = firstLayer.getActiveRendererHint();
  } else {
    activeRendererLabel = currentRendererHint;
  }
}

function applyVisibleLayerLimit() {
  vectorLayers.forEach((layer, index) => {
    layer.setVisible(index < visibleLayerTarget);
  });
  updateStats();
}

rebuildLayers(currentRendererHint);
