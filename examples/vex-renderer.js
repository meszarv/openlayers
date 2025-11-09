import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import Feature from '../src/ol/Feature.js';
import Polygon from '../src/ol/geom/Polygon.js';
import Point from '../src/ol/geom/Point.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import TileLayer from '../src/ol/layer/Tile.js';
import VectorSource from '../src/ol/source/Vector.js';
import OSM from '../src/ol/source/OSM.js';
import Fill from '../src/ol/style/Fill.js';
import Stroke from '../src/ol/style/Stroke.js';
import Style from '../src/ol/style/Style.js';
import CircleStyle from '../src/ol/style/Circle.js';
import {fromLonLat} from '../src/ol/proj.js';

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

const vectorSource = new VectorSource({
  features: [...blockFeatures, ...plazaFeatures],
});

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

const styleFunction = (feature) => {
  const geometry = feature.getGeometry();
  return geometry.getType() === 'Polygon' ? blockStyle : plazaStyle;
};

const baseLayer = new TileLayer({
  source: new OSM(),
});

const map = new Map({
  target: 'map',
  layers: [baseLayer],
  view: new View({
    center: fromLonLat([-122.41669, 37.7853]),
    zoom: 15,
  }),
});

const vexToggle = document.getElementById('use-vex');
const zoomButton = document.getElementById('zoom-features');

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

function createVectorLayer(useVex) {
  return new VectorLayer({
    rendererHint: useVex ? 'vex' : 'canvas',
    source: vectorSource,
    style: styleFunction,
    opacity: 0.95,
  });
}
