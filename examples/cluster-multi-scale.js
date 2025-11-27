import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import TileLayer from '../src/ol/layer/Tile.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import OSM from '../src/ol/source/OSM.js';
import VectorSource from '../src/ol/source/Vector.js';
import RenderFeature from '../src/ol/render/Feature.js';
import {getUid} from '../src/ol/util.js';
import CircleStyle from '../src/ol/style/Circle.js';
import Fill from '../src/ol/style/Fill.js';
import Stroke from '../src/ol/style/Stroke.js';
import Style from '../src/ol/style/Style.js';

const cityCountInput = document.getElementById('city-count');
const cityCountValue = document.getElementById('city-count-value');
const layerCountInput = document.getElementById('layer-count');
const layerCountValue = document.getElementById('layer-count-value');
const applyButton = document.getElementById('city-apply');
const extendRangeInput = document.getElementById('city-extend');
const statusElement = document.getElementById('generation-status');
const renderStatsElement = document.getElementById('render-stats');

const DEFAULT_MAX_CITIES = 50;
const EXTENDED_MAX_CITIES = 200;
const DEFAULT_LAYER_COUNT = 100;
const MAX_LAYER_COUNT = 300;

const FEATURES_PER_CITY = 10000;
const CITY_SIZE = 200000;
const CITY_SPACING = CITY_SIZE * 2.6;
const HOUSE_GRID = {cols: 6, rows: 6};
const ROOM_GRID = {cols: 4, rows: 4};
const TABLE_GRID = {cols: 4, rows: 2};
const TABLES_PER_ROOM = TABLE_GRID.cols * TABLE_GRID.rows;

const BASE_FEATURE_COUNTS = {
  city: 1,
  houses: HOUSE_GRID.cols * HOUSE_GRID.rows,
  rooms: HOUSE_GRID.cols * HOUSE_GRID.rows * ROOM_GRID.cols * ROOM_GRID.rows,
  roomText:
    HOUSE_GRID.cols * HOUSE_GRID.rows * ROOM_GRID.cols * ROOM_GRID.rows,
  tables:
    HOUSE_GRID.cols *
    HOUSE_GRID.rows *
    ROOM_GRID.cols *
    ROOM_GRID.rows *
    TABLES_PER_ROOM,
};

const STRUCTURED_COUNT =
  BASE_FEATURE_COUNTS.city +
  BASE_FEATURE_COUNTS.houses +
  BASE_FEATURE_COUNTS.rooms +
  BASE_FEATURE_COUNTS.roomText +
  BASE_FEATURE_COUNTS.tables;

const PLATES_PER_CITY = FEATURES_PER_CITY - STRUCTURED_COUNT;

const styles = {
  city: new Style({
    fill: new Fill({color: 'rgba(33, 150, 243, 0.12)'}),
    stroke: new Stroke({color: '#0d47a1', width: 2}),
  }),
  house: new Style({
    fill: new Fill({color: 'rgba(30, 136, 229, 0.22)'}),
    stroke: new Stroke({color: '#1976d2', width: 1.5}),
  }),
  room: new Style({
    fill: new Fill({color: 'rgba(76, 175, 80, 0.2)'}),
    stroke: new Stroke({color: '#2e7d32', width: 1}),
  }),
  roomText: new Style({
    fill: new Fill({color: 'rgba(165, 214, 167, 0.35)'}),
    stroke: new Stroke({color: '#1b5e20', width: 1.2}),
  }),
  table: new Style({
    fill: new Fill({color: 'rgba(255, 160, 0, 0.32)'}),
    stroke: new Stroke({color: '#ef6c00', width: 1}),
  }),
  plate: new Style({
    image: new CircleStyle({
      radius: 3,
      fill: new Fill({color: 'rgba(126, 87, 194, 0.75)'}),
      stroke: new Stroke({color: '#ede7f6', width: 0.8}),
    }),
  }),
};

const highlightPolygonStyle = new Style({
  fill: new Fill({color: 'rgba(255, 255, 255, 0.25)'}),
  stroke: new Stroke({color: '#ffb300', width: 3}),
});
const highlightPlateStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({color: 'rgba(255, 241, 118, 0.9)'}),
    stroke: new Stroke({color: '#f57f17', width: 1.6}),
  }),
});
const highlightStyles = {
  city: highlightPolygonStyle,
  house: highlightPolygonStyle,
  room: highlightPolygonStyle,
  roomText: highlightPolygonStyle,
  table: highlightPolygonStyle,
  plate: highlightPlateStyle,
};

const LETTER_GRID_COLS = 5;
const LETTER_GRID_ROWS = 7;
const LETTER_PATTERNS = {
  R: ['#####', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
};

const COORD_STRIDE = 2;
const LEVEL_PROPERTIES = {
  city: Object.freeze({level: 'city'}),
  house: Object.freeze({level: 'house'}),
  room: Object.freeze({level: 'room'}),
  roomText: Object.freeze({level: 'roomText'}),
  table: Object.freeze({level: 'table'}),
  plate: Object.freeze({level: 'plate'}),
};

let hoveredFeature = null;
let hoveredLayer = null;

const styleForFeature = (feature) => {
  const level = feature.get('level');
  if (!level) {
    return null;
  }
  if (feature === hoveredFeature) {
    return highlightStyles[level] ?? styles[level];
  }
  return styles[level];
};

const baseLayer = new TileLayer({
  source: new OSM(),
});

const vectorLayers = [];
let layerClassCounter = 0;

function nextLayerClassName() {
  // layerClassCounter += 1;
  return `ol-layer cluster-layer-${layerClassCounter}`;
}

function createVectorLayer() {
  return new VectorLayer({
    source: new VectorSource(),
    style: styleForFeature,
    className: nextLayerClassName(),
  });
}

const map = new Map({
  target: 'map',
  layers: [baseLayer],
  view: new View({
    center: [0, 0],
    zoom: 3,
  }),
});

const viewportElement = map.getViewport();

function updateHoveredFeature(feature, layer) {
  if (feature === hoveredFeature && layer === hoveredLayer) {
    return;
  }
  const previousLayer = hoveredLayer;
  hoveredFeature = feature;
  hoveredLayer = layer;
  if (previousLayer && previousLayer !== hoveredLayer) {
    previousLayer.changed();
  }
  hoveredLayer?.changed();
}

map.on('pointermove', (event) => {
  if (event.dragging) {
    return;
  }
  const hit = map.forEachFeatureAtPixel(event.pixel, (feature, layer) => ({
    feature,
    layer,
  }));
  if (hit) {
    updateHoveredFeature(hit.feature, hit.layer);
  } else {
    updateHoveredFeature(null, null);
  }
  viewportElement.style.cursor = hit ? 'pointer' : '';
});

viewportElement.addEventListener('mouseout', () => {
  viewportElement.style.cursor = '';
  updateHoveredFeature(null, null);
});

let lastFrameTimestamp = null;
let frameSequence = 0;
const frameHistory = [];

function updateLayerCollection(targetCount) {
  const count = Math.min(Math.max(targetCount, 1), MAX_LAYER_COUNT);
  while (vectorLayers.length > count) {
    const layer = vectorLayers.pop();
    map.removeLayer(layer);
  }
  while (vectorLayers.length < count) {
    const layer = createVectorLayer();
    vectorLayers.push(layer);
    map.addLayer(layer);
  }
}

map.on('postrender', (event) => {
  if (!renderStatsElement) {
    return;
  }
  const {frameState} = event;
  const timingsMap = frameState.layerTimings;
  if (!timingsMap) {
    return;
  }
  let build = 0;
  let draw = 0;
  let lod = 0;
  let rendered = 0;
  let skipped = 0;
  let total = 0;
  let layerTimingsCount = 0;
  for (let i = 0; i < vectorLayers.length; ++i) {
    const timings = timingsMap.get(getUid(vectorLayers[i]));
    if (!timings) {
      continue;
    }
    build += timings.build ?? 0;
    draw += timings.draw ?? 0;
    lod += timings.lod ?? 0;
    rendered += timings.renderedFeatures ?? 0;
    skipped += timings.skippedFeatures ?? 0;
    total += timings.total ?? 0;
    layerTimingsCount += 1;
  }
  if (!layerTimingsCount) {
    return;
  }
  const zoom = frameState.viewState?.zoom ?? null;
  const currentTime = frameState.time;
  let fps = null;
  if (lastFrameTimestamp !== null && currentTime > lastFrameTimestamp) {
    fps = 1000 / (currentTime - lastFrameTimestamp);
  }
  lastFrameTimestamp = currentTime;
  frameSequence += 1;
  const entry = {
    index: frameSequence,
    build,
    draw,
    lod,
    rendered,
    skipped,
    total,
    zoom,
    fps,
    layerCount: vectorLayers.length,
  };
  frameHistory.push(entry);
  if (frameHistory.length > 120) {
    frameHistory.shift();
  }
  const format = (value) => value.toFixed(1);
  const formatZoom = (value) => (value !== null && isFinite(value) ? value.toFixed(2) : '—');
  const formatCount = (value) => value.toLocaleString('en-US');
  const formatFps = (value) => (value !== null ? value.toFixed(1) : '—');
  const lines = frameHistory
    .slice()
    .reverse()
    .map((item) => {
      const label = `#${String(item.index).padStart(5, ' ')}`;
      return `${label} | Layers: ${item.layerCount} | Zoom: ${formatZoom(item.zoom)} | Build: ${format(item.build)} ms | Draw: ${format(item.draw)} ms | LOD: ${format(item.lod)} ms | Total: ${format(item.total)} ms | Rendered: ${formatCount(item.rendered)} | Skipped: ${formatCount(item.skipped)} | FPS: ${formatFps(item.fps)}`;
    });
  renderStatsElement.textContent = lines.join(`
`);
});

function updateCityCountLabel() {
  if (!cityCountValue || !cityCountInput) {
    return;
  }
  cityCountValue.textContent = cityCountInput.value;
}

function updateLayerCountLabel() {
  if (!layerCountInput || !layerCountValue) {
    return;
  }
  layerCountValue.textContent = layerCountInput.value;
}

function applySliderLimit() {
  if (!cityCountInput) {
    return;
  }
  const max = extendRangeInput?.checked ? EXTENDED_MAX_CITIES : DEFAULT_MAX_CITIES;
  cityCountInput.max = String(max);
  if (Number(cityCountInput.value) > max) {
    cityCountInput.value = String(max);
    updateCityCountLabel();
  }
}

function reportPendingSelection() {
  if (!statusElement) {
    return;
  }
  const pendingCities = Number(cityCountInput?.value ?? DEFAULT_MAX_CITIES);
  const pendingLayers = Number(layerCountInput?.value ?? DEFAULT_LAYER_COUNT);
  statusElement.textContent = `Ready to render ${pendingCities.toLocaleString()} city area(s) split into ${pendingLayers} layer(s). Click Apply to update the map.`;
}

function createBounds(center, size) {
  const half = size / 2;
  return [
    center[0] - half,
    center[1] - half,
    center[0] + half,
    center[1] + half,
  ];
}

function shrinkBounds(bounds, fraction) {
  const [minX, minY, maxX, maxY] = bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  const padX = width * fraction;
  const padY = height * fraction;
  return [minX + padX, minY + padY, maxX - padX, maxY - padY];
}

function subdivideBounds(bounds, cols, rows, paddingFraction) {
  const [minX, minY, maxX, maxY] = bounds;
  const cellWidth = (maxX - minX) / cols;
  const cellHeight = (maxY - minY) / rows;
  const paddingX = cellWidth * paddingFraction;
  const paddingY = cellHeight * paddingFraction;
  const result = [];
  for (let row = 0; row < rows; ++row) {
    const baseMinY = minY + row * cellHeight + paddingY;
    const baseMaxY = baseMinY + cellHeight - 2 * paddingY;
    for (let col = 0; col < cols; ++col) {
      const baseMinX = minX + col * cellWidth + paddingX;
      const baseMaxX = baseMinX + cellWidth - 2 * paddingX;
      result.push([baseMinX, baseMinY, baseMaxX, baseMaxY]);
    }
  }
  return result;
}

function rectangleRingFromBounds(bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  return [
    [minX, minY],
    [minX, maxY],
    [maxX, maxY],
    [maxX, minY],
    [minX, minY],
  ];
}

function triangleRingFromBounds(bounds, variant) {
  const [minX, minY, maxX, maxY] = bounds;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const variants = [
    [
      [minX, minY],
      [maxX, minY],
      [midX, maxY],
      [minX, minY],
    ],
    [
      [minX, maxY],
      [minX, minY],
      [maxX, midY],
      [minX, maxY],
    ],
    [
      [minX, maxY],
      [maxX, maxY],
      [midX, minY],
      [minX, maxY],
    ],
    [
      [maxX, minY],
      [maxX, maxY],
      [minX, midY],
      [maxX, minY],
    ],
  ];
  return variants[variant % variants.length];
}

function createPointFeature(coordinate, level) {
  const flat = new Float32Array(COORD_STRIDE);
  flat[0] = coordinate[0];
  flat[1] = coordinate[1];
  return new RenderFeature(
    'Point',
    flat,
    null,
    COORD_STRIDE,
    LEVEL_PROPERTIES[level],
  );
}

function createPolygonFeatureFromRing(ring, level) {
  const flat = new Float32Array(ring.length * COORD_STRIDE);
  let offset = 0;
  for (let i = 0; i < ring.length; ++i) {
    const [x, y] = ring[i];
    flat[offset++] = x;
    flat[offset++] = y;
  }
  return new RenderFeature(
    'Polygon',
    flat,
    [flat.length],
    COORD_STRIDE,
    LEVEL_PROPERTIES[level],
  );
}

function createPolygonFeatureFromRings(rings, level) {
  let coordinateCount = 0;
  for (let i = 0; i < rings.length; ++i) {
    coordinateCount += rings[i].length;
  }
  const flat = new Float32Array(coordinateCount * COORD_STRIDE);
  const ends = new Array(rings.length);
  let offset = 0;
  for (let i = 0; i < rings.length; ++i) {
    const ring = rings[i];
    for (let j = 0; j < ring.length; ++j) {
      const [x, y] = ring[j];
      flat[offset++] = x;
      flat[offset++] = y;
    }
    ends[i] = offset;
  }
  return new RenderFeature(
    'Polygon',
    flat,
    ends,
    COORD_STRIDE,
    LEVEL_PROPERTIES[level],
  );
}

function createTriangleFeature(bounds, variant, level) {
  return createPolygonFeatureFromRing(
    triangleRingFromBounds(bounds, variant),
    level,
  );
}

function plateFeatures(bounds, count) {
  const [minX, minY, maxX, maxY] = bounds;
  if (count <= 0) {
    return [];
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const stepX = (maxX - minX) / (columns + 1);
  const stepY = (maxY - minY) / (rows + 1);
  const features = [];
  let created = 0;
  for (let row = 0; row < rows && created < count; ++row) {
    for (let col = 0; col < columns && created < count; ++col) {
      const x = minX + (col + 1) * stepX;
      const y = minY + (row + 1) * stepY;
      features.push(createPointFeature([x, y], 'plate'));
      created += 1;
    }
  }
  return features;
}

function buildLetterPolygons(bounds, pattern) {
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  if (width <= 0 || height <= 0) {
    return [];
  }
  const cellWidth = width / LETTER_GRID_COLS;
  const cellHeight = height / LETTER_GRID_ROWS;
  const paddingX = cellWidth * 0.1;
  const paddingY = cellHeight * 0.1;
  const rings = [];
  for (let row = 0; row < LETTER_GRID_ROWS; ++row) {
    const rowPattern = pattern[row];
    if (!rowPattern) {
      continue;
    }
    for (let col = 0; col < LETTER_GRID_COLS; ++col) {
      if (rowPattern[col] !== '#') {
        continue;
      }
      const minX = bounds[0] + col * cellWidth + paddingX;
      const maxX = bounds[0] + (col + 1) * cellWidth - paddingX;
      const maxY = bounds[3] - row * cellHeight - paddingY;
      const minY = maxY - cellHeight + 2 * paddingY;
      rings.push([
        [minX, minY],
        [minX, maxY],
        [maxX, maxY],
        [maxX, minY],
        [minX, minY],
      ]);
    }
  }
  return rings;
}

function buildWordRings(bounds, word) {
  const letters = word.toUpperCase().split('');
  if (!letters.length) {
    return [rectangleRingFromBounds(bounds)];
  }
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  if (width <= 0 || height <= 0) {
    return [rectangleRingFromBounds(bounds)];
  }
  const verticalInset = height * 0.15;
  let currentX = bounds[0];
  const letterWidth = width / letters.length;
  const rings = [];
  for (let i = 0; i < letters.length; ++i) {
    const pattern = LETTER_PATTERNS[letters[i]];
    const insetX = letterWidth * 0.12;
    const minX = currentX + insetX;
    const maxX = currentX + letterWidth - insetX;
    const letterBounds = [
      minX,
      bounds[1] + verticalInset,
      maxX,
      bounds[3] - verticalInset,
    ];
    if (pattern) {
      rings.push(...buildLetterPolygons(letterBounds, pattern));
    }
    currentX += letterWidth;
  }
  if (!rings.length) {
    return [rectangleRingFromBounds(bounds)];
  }
  return rings;
}

function createRectangleFeature(bounds, level) {
  return createPolygonFeatureFromRing(rectangleRingFromBounds(bounds), level);
}

function createRoomTextFeature(bounds, word) {
  const rings = buildWordRings(bounds, word);
  if (!rings || !rings.length) {
    return createRectangleFeature(bounds, 'roomText');
  }
  if (rings.length === 1) {
    return createPolygonFeatureFromRing(rings[0], 'roomText');
  }
  return createPolygonFeatureFromRings(rings, 'roomText');
}

function cityCenterFromIndex(index, total) {
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const offsetX = (col - (cols - 1) / 2) * CITY_SPACING;
  const offsetY = ((rows - 1) / 2 - row) * CITY_SPACING;
  return [offsetX, offsetY];
}

function extendExtent(extent, bounds) {
  if (!extent) {
    return bounds.slice();
  }
  extent[0] = Math.min(extent[0], bounds[0]);
  extent[1] = Math.min(extent[1], bounds[1]);
  extent[2] = Math.max(extent[2], bounds[2]);
  extent[3] = Math.max(extent[3], bounds[3]);
  return extent;
}

function generateCityFeatures(cityIndex, totalCities) {
  const cityCenter = cityCenterFromIndex(cityIndex, totalCities);
  const cityBounds = createBounds(cityCenter, CITY_SIZE);
  const innerCityBounds = shrinkBounds(cityBounds, 0.08);
  const houseBounds = subdivideBounds(innerCityBounds, HOUSE_GRID.cols, HOUSE_GRID.rows, 0.12);

  const features = [];
  features.push(createRectangleFeature(cityBounds, 'city'));

  const roomBoundsCollection = [];
  for (let i = 0; i < houseBounds.length; ++i) {
    const bounds = houseBounds[i];
    features.push(createRectangleFeature(bounds, 'house'));
    const roomBounds = subdivideBounds(shrinkBounds(bounds, 0.12), ROOM_GRID.cols, ROOM_GRID.rows, 0.18);
    roomBoundsCollection.push(...roomBounds);
  }

  const tableBoundsCollection = [];
  for (let i = 0; i < roomBoundsCollection.length; ++i) {
    const bounds = roomBoundsCollection[i];
    features.push(createRectangleFeature(bounds, 'room'));
    const labelBounds = shrinkBounds(bounds, 0.22);
    features.push(createRoomTextFeature(labelBounds, 'ROOM'));
    const tableBounds = subdivideBounds(shrinkBounds(bounds, 0.18), TABLE_GRID.cols, TABLE_GRID.rows, 0.2);
    tableBoundsCollection.push(...tableBounds);
  }

  let tableIndex = 0;
  const totalTables = tableBoundsCollection.length;
  const basePlatesPerTable = Math.floor(PLATES_PER_CITY / totalTables);
  const extraPlates = PLATES_PER_CITY - basePlatesPerTable * totalTables;

  for (let i = 0; i < tableBoundsCollection.length; ++i) {
    const bounds = tableBoundsCollection[i];
    const triangleFeature = createTriangleFeature(bounds, (i + cityIndex) % 4, 'table');
    features.push(triangleFeature);
    const extra = tableIndex < extraPlates ? 1 : 0;
    const plateCount = basePlatesPerTable + extra;
    const plateArea = shrinkBounds(bounds, 0.28);
    const plateRenderFeatures = plateFeatures(plateArea, plateCount);
    features.push(...plateRenderFeatures);
    tableIndex += 1;
  }

  return {features, bounds: cityBounds};
}

let generationToken = 0;

function regenerate() {
  applySliderLimit();
  const requestedCities = Number(cityCountInput.value);
  const requestedLayers = Math.min(
    Math.max(Number(layerCountInput?.value ?? DEFAULT_LAYER_COUNT), 1),
    MAX_LAYER_COUNT,
  );
  updateCityCountLabel();
  updateLayerCountLabel();
  const token = ++generationToken;
  const totalTarget = requestedCities * FEATURES_PER_CITY;
  statusElement.textContent = `Generating ${requestedCities} city area(s) with ${totalTarget.toLocaleString()} features split across ${requestedLayers} layer(s)...`;

  setTimeout(() => {
    if (token !== generationToken) {
      return;
    }
    updateLayerCollection(requestedLayers);
    for (let i = 0; i < vectorLayers.length; ++i) {
      vectorLayers[i].getSource().clear(true);
    }

    const allFeatures = [];
    let extent = null;
    for (let i = 0; i < requestedCities; ++i) {
      const {features, bounds} = generateCityFeatures(i, requestedCities);
      allFeatures.push(...features);
      extent = extendExtent(extent, bounds);
    }

    const layerCount = vectorLayers.length || 1;
    const baseCount = Math.floor(allFeatures.length / layerCount);
    const remainder = allFeatures.length % layerCount;
    let offset = 0;
    for (let i = 0; i < layerCount; ++i) {
      const count = baseCount + (i < remainder ? 1 : 0);
      const slice = allFeatures.slice(offset, offset + count);
      vectorLayers[i].getSource().addFeatures(slice);
      offset += count;
    }

    statusElement.textContent = `Rendered ${allFeatures.length.toLocaleString()} features across ${requestedCities} city area(s) split into ${layerCount} layer(s).`;

    if (extent) {
      map.getView().fit(extent, {
        padding: [80, 80, 80, 80],
        duration: 300,
        maxZoom: 12,
      });
    }
  }, 0);
}

cityCountInput.addEventListener('input', () => {
  updateCityCountLabel();
  reportPendingSelection();
});

if (layerCountInput) {
  layerCountInput.addEventListener('input', () => {
    updateLayerCountLabel();
    reportPendingSelection();
  });
}

if (extendRangeInput) {
  extendRangeInput.addEventListener('change', () => {
    applySliderLimit();
    updateCityCountLabel();
    reportPendingSelection();
  });
}

if (applyButton) {
  applyButton.addEventListener('click', regenerate);
}

applySliderLimit();
updateCityCountLabel();
updateLayerCountLabel();
updateLayerCollection(DEFAULT_LAYER_COUNT);
regenerate();
