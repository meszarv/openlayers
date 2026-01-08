import Feature from '../src/ol/Feature.js';
import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import Point from '../src/ol/geom/Point.js';
import Polygon from '../src/ol/geom/Polygon.js';
import TileLayer from '../src/ol/layer/Tile.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import {fromLonLat} from '../src/ol/proj.js';
import OSM from '../src/ol/source/OSM.js';
import VectorSource from '../src/ol/source/Vector.js';
import CircleStyle from '../src/ol/style/Circle.js';
import Fill from '../src/ol/style/Fill.js';
import Stroke from '../src/ol/style/Stroke.js';
import Style from '../src/ol/style/Style.js';

const neighborhoods = [
  [
    [-122.42058, 37.7899],
    [-122.41433, 37.7899],
    [-122.41433, 37.7845],
    [-122.42058, 37.7845],
    [-122.42058, 37.7899],
  ],
  [
    [-122.4188, 37.7842],
    [-122.413, 37.7842],
    [-122.413, 37.7794],
    [-122.4188, 37.7794],
    [-122.4188, 37.7842],
  ],
  [
    [-122.4172, 37.7922],
    [-122.4122, 37.7922],
    [-122.4122, 37.7886],
    [-122.4172, 37.7886],
    [-122.4172, 37.7922],
  ],
].map((ring) => ring.map((coord) => fromLonLat(coord)));

const plazaPoints = [
  [-122.4176, 37.7864],
  [-122.4156, 37.7883],
  [-122.4144, 37.7822],
].map((coord) => fromLonLat(coord));

const blockFeatures = neighborhoods.map(
  (ring, index) =>
    new Feature({
      geometry: new Polygon([ring]),
      name: `Block ${index + 1}`,
    }),
);

const plazaFeatures = plazaPoints.map(
  (coord, index) =>
    new Feature({
      geometry: new Point(coord),
      name: `Plaza ${index + 1}`,
    }),
);

const initialFeatures = [...blockFeatures, ...plazaFeatures];

const vectorSource = new VectorSource({
  features: initialFeatures.slice(),
});
const initialExtent = vectorSource.getExtent().slice();
const hasInitialExtent = initialExtent.every((value) => Number.isFinite(value));

const blockStyle = new Style({
  fill: new Fill({
    color: 'rgba(25, 118, 210, 0.35)',
  }),
  stroke: new Stroke({
    color: '#0d47a1',
    width: 3,
  }),
});

const plazaStyle = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({color: '#ffca28'}),
    stroke: new Stroke({color: '#ff8f00', width: 2}),
  }),
});

const cityStyles = {
  city: new Style({
    fill: new Fill({color: 'rgba(33, 150, 243, 0.12)'}),
    stroke: new Stroke({color: '#0d47a1', width: 2}),
  }),
  house: new Style({
    fill: new Fill({color: 'rgba(30, 136, 229, 0.18)'}),
    stroke: new Stroke({color: '#1976d2', width: 1.3}),
  }),
  room: new Style({
    fill: new Fill({color: 'rgba(76, 175, 80, 0.2)'}),
    stroke: new Stroke({color: '#2e7d32', width: 1}),
  }),
  roomText: new Style({
    fill: new Fill({color: 'rgba(165, 214, 167, 0.35)'}),
    stroke: new Stroke({color: '#1b5e20', width: 1}),
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

const styleFunction = (feature) => {
  const level = feature.get('level');
  if (level && cityStyles[level]) {
    return cityStyles[level];
  }
  const geometry = feature.getGeometry();
  if (!geometry) {
    return blockStyle;
  }
  return geometry.getType() === 'Polygon' ? blockStyle : plazaStyle;
};

const baseLayer = new TileLayer({
  source: new OSM(),
});

const mapCenter = fromLonLat([-122.41669, 37.7853]);

const map = new Map({
  target: 'map',
  layers: [baseLayer],
  view: new View({
    center: mapCenter.slice(),
    zoom: 15,
  }),
});

const vexToggle = document.getElementById('use-vex');
const zoomButton = document.getElementById('zoom-features');
const addFeaturesButton = document.getElementById('add-features');
const clearLayerButton = document.getElementById('clear-layer');
const cityCountInput = document.getElementById('city-count');
const cityCountValue = document.getElementById('city-count-value');
const cityApplyButton = document.getElementById('city-apply');
const cityExtendInput = document.getElementById('city-extend');
const generationStatus = document.getElementById('generation-status');

const DEFAULT_MAX_CITIES = 50;
const EXTENDED_MAX_CITIES = 200;
const FEATURES_PER_CITY = 10000;
const CITY_SIZE = 200000;
const CITY_SPACING = CITY_SIZE * 2.6;
const HOUSE_GRID = {cols: 6, rows: 6};
const ROOM_GRID = {cols: 4, rows: 4};
const TABLE_GRID = {cols: 4, rows: 2};
const TABLES_PER_ROOM = TABLE_GRID.cols * TABLE_GRID.rows;
const LETTER_GRID_COLS = 5;
const LETTER_GRID_ROWS = 7;
const LETTER_PATTERNS = {
  R: ['#####', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
};

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

const PLATES_PER_CITY = Math.max(0, FEATURES_PER_CITY - STRUCTURED_COUNT);

let vectorLayer = createVectorLayer(vexToggle.checked);
map.addLayer(vectorLayer);

vexToggle.addEventListener('change', () => {
  map.removeLayer(vectorLayer);
  vectorLayer = createVectorLayer(vexToggle.checked);
  map.addLayer(vectorLayer);
});

zoomButton.addEventListener('click', () => {
  const extent = vectorSource.getExtent();
  if (extent) {
    map.getView().fit(extent, {
      padding: [40, 40, 40, 40],
      duration: 400,
    });
  }
});

addFeaturesButton.addEventListener('click', () => {
  const features = createRandomPlazaFeatures();
  vectorLayer.addFeatures(features);
});

clearLayerButton.addEventListener('click', () => {
  vectorLayer.clear();
});

cityCountInput?.addEventListener('input', () => {
  updateCityCountLabel();
  reportGenerationReady();
});

cityExtendInput?.addEventListener('change', () => {
  applySliderLimit();
  updateCityCountLabel();
  reportGenerationReady();
});

cityApplyButton?.addEventListener('click', regenerateSyntheticCities);

applySliderLimit();
updateCityCountLabel();
reportGenerationReady();

function createVectorLayer(useVex) {
  const layer = new VectorLayer({
    rendererHint: useVex ? 'vex' : 'canvas',
    source: vectorSource,
    style: styleFunction,
    opacity: 0.95,
  });
  if (typeof layer.addFeatures !== 'function') {
    layer.addFeatures = function addFeatures(features) {
      const source = this.getSource();
      if (source && features && features.length) {
        source.addFeatures(features);
      }
    };
  }
  if (typeof layer.clear !== 'function') {
    layer.clear = function clearLayer(fast) {
      const source = this.getSource();
      if (source) {
        source.clear(fast);
      }
    };
  }
  return layer;
}

function createRandomPlazaFeatures(count = 3) {
  const view = map.getView();
  const center = view.getCenter() || mapCenter;
  const resolution = view.getResolution() || 1;
  const spread = resolution * 400;
  const features = [];
  for (let i = 0; i < count; i += 1) {
    const offsetX = (Math.random() - 0.5) * 2 * spread;
    const offsetY = (Math.random() - 0.5) * 2 * spread;
    const pointX = center[0] + offsetX;
    const pointY = center[1] + offsetY;
    const hue = Math.floor(Math.random() * 360);
    const pointColor = `hsl(${hue},85%,55%)`;
    const polygonFill = `hsla(${hue},80%,60%,0.35)`;
    const polygonStroke = `hsl(${hue},75%,35%)`;
    const point = new Point([pointX, pointY]);
    const pointFeature = new Feature({
      geometry: point,
      name: `Added plaza ${Date.now()}-${i + 1}`,
    });
    pointFeature.setStyle(
      new Style({
        image: new CircleStyle({
          radius: 8 + Math.random() * 4,
          fill: new Fill({color: pointColor}),
          stroke: new Stroke({color: '#0d1b2a', width: 2}),
        }),
      }),
    );
    features.push(pointFeature);
    const halfSize = resolution * (60 + Math.random() * 60);
    const polygonCoords = [
      [pointX - halfSize, pointY - halfSize],
      [pointX + halfSize, pointY - halfSize],
      [pointX + halfSize, pointY + halfSize],
      [pointX - halfSize, pointY + halfSize],
      [pointX - halfSize, pointY - halfSize],
    ];
    const polygonFeature = new Feature({
      geometry: new Polygon([polygonCoords]),
      name: `Added plaza block ${Date.now()}-${i + 1}`,
    });
    polygonFeature.setStyle(
      new Style({
        fill: new Fill({color: polygonFill}),
        stroke: new Stroke({color: polygonStroke, width: 3}),
      }),
    );
    features.push(polygonFeature);
  }
  return features;
}

function applySliderLimit() {
  if (!cityCountInput) {
    return;
  }
  const max = cityExtendInput?.checked ? EXTENDED_MAX_CITIES : DEFAULT_MAX_CITIES;
  cityCountInput.max = String(max);
  if (Number(cityCountInput.value) > max) {
    cityCountInput.value = String(max);
  }
}

function updateCityCountLabel() {
  if (!cityCountValue || !cityCountInput) {
    return;
  }
  const cities = Number(cityCountInput.value);
  const totalFeatures = cities * FEATURES_PER_CITY;
  cityCountValue.textContent = totalFeatures.toLocaleString();
}

function reportGenerationReady() {
  if (!generationStatus || !cityCountInput) {
    return;
  }
  const pendingCities = Number(cityCountInput.value);
  const pendingFeatures = pendingCities * FEATURES_PER_CITY;
  generationStatus.textContent = `Ready to generate approximately ${pendingFeatures.toLocaleString()} synthetic features (${pendingCities.toLocaleString()} city area${pendingCities === 1 ? '' : 's'}).`;
}

function createBounds(center, size) {
  const half = size / 2;
  return [center[0] - half, center[1] - half, center[0] + half, center[1] + half];
}

function shrinkBounds(bounds, factor) {
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  const insetX = width * factor * 0.5;
  const insetY = height * factor * 0.5;
  return [
    bounds[0] + insetX,
    bounds[1] + insetY,
    bounds[2] - insetX,
    bounds[3] - insetY,
  ];
}

function subdivideBounds(bounds, cols, rows, paddingFraction = 0) {
  const [minX, minY, maxX, maxY] = bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const paddingX = cellWidth * paddingFraction * 0.5;
  const paddingY = cellHeight * paddingFraction * 0.5;
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
  const feature = new Feature({
    geometry: new Point(coordinate),
  });
  feature.set('level', level);
  return feature;
}

function createPolygonFeatureFromRing(ring, level) {
  const feature = new Feature({
    geometry: new Polygon([ring]),
  });
  feature.set('level', level);
  return feature;
}

function createPolygonFeatureFromRings(rings, level) {
  const feature = new Feature({
    geometry: new Polygon(rings),
  });
  feature.set('level', level);
  return feature;
}

function createTriangleFeature(bounds, variant, level) {
  return createPolygonFeatureFromRing(triangleRingFromBounds(bounds, variant), level);
}

function plateFeatures(bounds, count) {
  if (count <= 0) {
    return [];
  }
  const [minX, minY, maxX, maxY] = bounds;
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
  const letterWidth = width / letters.length;
  const rings = [];
  let currentX = bounds[0];
  for (let i = 0; i < letters.length; ++i) {
    const pattern = LETTER_PATTERNS[letters[i]];
    const insetX = letterWidth * 0.12;
    const letterBounds = [
      currentX + insetX,
      bounds[1] + verticalInset,
      currentX + letterWidth - insetX,
      bounds[3] - verticalInset,
    ];
    if (pattern) {
      rings.push(...buildLetterPolygons(letterBounds, pattern));
    }
    currentX += letterWidth;
  }
  return rings.length ? rings : [rectangleRingFromBounds(bounds)];
}

function createRoomTextFeature(bounds, word) {
  const rings = buildWordRings(bounds, word);
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

function extendExtent(currentExtent, bounds) {
  if (!currentExtent) {
    return bounds.slice();
  }
  currentExtent[0] = Math.min(currentExtent[0], bounds[0]);
  currentExtent[1] = Math.min(currentExtent[1], bounds[1]);
  currentExtent[2] = Math.max(currentExtent[2], bounds[2]);
  currentExtent[3] = Math.max(currentExtent[3], bounds[3]);
  return currentExtent;
}

function generateCityFeatures(cityIndex, totalCities) {
  const cityCenter = cityCenterFromIndex(cityIndex, totalCities);
  const cityBounds = createBounds(cityCenter, CITY_SIZE);
  const innerCityBounds = shrinkBounds(cityBounds, 0.08);
  const houseBounds = subdivideBounds(innerCityBounds, HOUSE_GRID.cols, HOUSE_GRID.rows, 0.1);

  const features = [];
  features.push(createPolygonFeatureFromRing(rectangleRingFromBounds(cityBounds), 'city'));

  const roomBoundsCollection = [];
  for (const bounds of houseBounds) {
    features.push(createPolygonFeatureFromRing(rectangleRingFromBounds(bounds), 'house'));
    const rooms = subdivideBounds(shrinkBounds(bounds, 0.12), ROOM_GRID.cols, ROOM_GRID.rows, 0.18);
    roomBoundsCollection.push(...rooms);
  }

  const tableBoundsCollection = [];
  for (const bounds of roomBoundsCollection) {
    features.push(createPolygonFeatureFromRing(rectangleRingFromBounds(bounds), 'room'));
    const labelBounds = shrinkBounds(bounds, 0.2);
    features.push(createRoomTextFeature(labelBounds, 'ROOM'));
    const tables = subdivideBounds(shrinkBounds(bounds, 0.18), TABLE_GRID.cols, TABLE_GRID.rows, 0.2);
    tableBoundsCollection.push(...tables);
  }

  const totalTables = tableBoundsCollection.length || 1;
  const basePlatesPerTable = Math.floor(PLATES_PER_CITY / totalTables);
  const extraPlates = PLATES_PER_CITY - basePlatesPerTable * totalTables;

  for (let i = 0; i < tableBoundsCollection.length; ++i) {
    const bounds = tableBoundsCollection[i];
    features.push(createTriangleFeature(bounds, (i + cityIndex) % 4, 'table'));
    const plateArea = shrinkBounds(bounds, 0.25);
    const plateCount = basePlatesPerTable + (i < extraPlates ? 1 : 0);
    features.push(...plateFeatures(plateArea, plateCount));
  }

  return {features, bounds: cityBounds};
}

let generationToken = 0;

function regenerateSyntheticCities() {
  if (!cityCountInput || !generationStatus) {
    return;
  }
  applySliderLimit();
  updateCityCountLabel();
  const requestedCities = Number(cityCountInput.value);
  const token = ++generationToken;
  const totalTarget = requestedCities * FEATURES_PER_CITY;
  generationStatus.textContent = `Generating approximately ${totalTarget.toLocaleString()} features (${requestedCities.toLocaleString()} city area${requestedCities === 1 ? '' : 's'})...`;

  setTimeout(() => {
    if (token !== generationToken) {
      return;
    }
    const syntheticFeatures = [];
    let extent = null;
    for (let i = 0; i < requestedCities; ++i) {
      const {features, bounds} = generateCityFeatures(i, requestedCities);
      syntheticFeatures.push(...features);
      extent = extendExtent(extent, bounds);
    }
    vectorSource.clear(true);
    vectorSource.addFeatures(initialFeatures.concat(syntheticFeatures));
    const totalRendered = initialFeatures.length + syntheticFeatures.length;
    generationStatus.textContent = `Rendered ${totalRendered.toLocaleString()} features (including ${requestedCities.toLocaleString()} synthetic city area${requestedCities === 1 ? '' : 's'}).`;
    if (extent && hasInitialExtent) {
      extent = extendExtent(extent, initialExtent);
    }
    if (extent) {
      map.getView().fit(extent, {
        padding: [80, 80, 80, 80],
        duration: 400,
        maxZoom: 12,
      });
    }
  }, 0);
}
