import {createVexContext} from '../mock.js';

const canvas = document.getElementById('scene');
const statusEl = document.getElementById('status');
const viewInfoEl = document.getElementById('view-info');
const panXInput = document.getElementById('pan-x');
const panYInput = document.getElementById('pan-y');
const zoomInput = document.getElementById('zoom');
const rebuildBtn = document.getElementById('rebuild');
const commitBtn = document.getElementById('commit');
const addShapeBtn = document.getElementById('add-shape');
const cleanBtn = document.getElementById('clean');

const SCENE_WIDTH = 1800;
const SCENE_HEIGHT = 1200;

let vexCtx;

init();

async function init() {
  toggleButtons(true);
  setStatus('Creating Vex context…');
  vexCtx = await createVexContext(canvas);
  setStatus('Context ready. Building base scene…');
  panXInput.max = Math.max(0, SCENE_WIDTH - canvas.width);
  panYInput.max = Math.max(0, SCENE_HEIGHT - canvas.height);
  rebuildBaseScene();
  toggleButtons(false);
  bindUi();
}

function bindUi() {
  rebuildBtn.addEventListener('click', () => {
    toggleButtons(true);
    rebuildBaseScene();
    toggleButtons(false);
  });

  commitBtn.addEventListener('click', () => {
    if (!vexCtx) return;
    toggleButtons(true);
    vexCtx.commit();
    vexCtx.setSceneView(getViewportX(), getViewportY(), getViewportZoom());
    setStatus(`Committed ${vexCtx.instructionsCount} instructions again.`);
    toggleButtons(false);
  });

  addShapeBtn.addEventListener('click', () => {
    if (!vexCtx) return;
    toggleButtons(true);
    addRandomStar();
    vexCtx.commit();
    vexCtx.setSceneView(getViewportX(), getViewportY(), getViewportZoom());
    setStatus(`Added a star. Total instructions: ${vexCtx.instructionsCount}.`);
    toggleButtons(false);
  });

cleanBtn.addEventListener('click', () => {
  if (!vexCtx) return;
  vexCtx.clear();
  setStatus('Instructions cleared. Rebuild the base scene to draw again.');
});

  [panXInput, panYInput, zoomInput].forEach((input) => {
    input.addEventListener('input', () => {
      if (!vexCtx) return;
      const x = getViewportX();
      const y = getViewportY();
      const zoom = getViewportZoom();
      vexCtx.setSceneView(x, y, zoom);
      updateViewInfo(x, y, zoom);
    });
  });
}

function rebuildBaseScene() {
  if (!vexCtx) return;
  vexCtx.clear();
  drawBackground();
  drawGrid();
  drawDistricts();
  drawOrbiters();
  drawLabels();
  vexCtx.commit();
  const x = getViewportX();
  const y = getViewportY();
  const zoom = getViewportZoom();
  vexCtx.setSceneView(x, y, zoom);
  updateViewInfo(x, y, zoom);
  setStatus(`Base scene committed with ${vexCtx.instructionsCount} instructions.`);
}

function drawBackground() {
  vexCtx.save();
  const gradient = vexCtx.createLinearGradient(0, 0, 0, SCENE_HEIGHT);
  gradient.addColorStop(0, '#050608');
  gradient.addColorStop(0.7, '#11162a');
  gradient.addColorStop(1, '#151d38');
  vexCtx.fillStyle = gradient;
  vexCtx.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
  vexCtx.restore();
}

function drawGrid() {
  vexCtx.save();
  vexCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  vexCtx.lineWidth = 2;
  for (let x = 0; x <= SCENE_WIDTH; x += 120) {
    vexCtx.beginPath();
    vexCtx.moveTo(x, 0);
    vexCtx.lineTo(x, SCENE_HEIGHT);
    vexCtx.stroke();
  }
  for (let y = 0; y <= SCENE_HEIGHT; y += 120) {
    vexCtx.beginPath();
    vexCtx.moveTo(0, y);
    vexCtx.lineTo(SCENE_WIDTH, y);
    vexCtx.stroke();
  }
  vexCtx.restore();
}

function drawDistricts() {
  const palette = ['#4356ff', '#98e2ff', '#ff7598', '#ffe071', '#74f0b4'];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const idx = row * 6 + col;
      const color = palette[idx % palette.length];
      const baseX = 80 + col * 260;
      const baseY = 140 + row * 220;
      const size = 160 + wave(idx, 30);
      vexCtx.save();
      vexCtx.translate(baseX, baseY);
      vexCtx.fillStyle = color;
      vexCtx.globalAlpha = 0.65;
      vexCtx.beginPath();
      roundedRect(vexCtx, 0, 0, size, size * 0.6, 24);
      vexCtx.fill();
      vexCtx.lineWidth = 4;
      vexCtx.globalAlpha = 1;
      vexCtx.strokeStyle = 'rgba(255,255,255,0.35)';
      vexCtx.stroke();
      vexCtx.restore();
    }
  }
}

function drawOrbiters() {
  vexCtx.save();
  vexCtx.strokeStyle = 'rgba(255,255,255,0.2)';
  vexCtx.lineWidth = 3;
  vexCtx.setLineDash([10, 12]);
  vexCtx.beginPath();
  vexCtx.arc(900, 600, 520, 0, Math.PI * 2);
  vexCtx.stroke();
  vexCtx.setLineDash([]);

  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    const radius = 520 + ((i % 3) - 1) * 26;
    const x = 900 + Math.cos(angle) * radius;
    const y = 600 + Math.sin(angle) * radius;
    vexCtx.beginPath();
    vexCtx.fillStyle = i % 2 === 0 ? '#ff9bd4' : '#8ef2ff';
    vexCtx.arc(x, y, 14, 0, Math.PI * 2);
    vexCtx.fill();
  }
  vexCtx.restore();
}

function drawLabels() {
  vexCtx.save();
  vexCtx.fillStyle = '#ffffff';
  vexCtx.font = 'bold 42px/1 "Fira Code", "Segoe UI", sans-serif';
  vexCtx.fillText('Vex City', 70, 90);
  vexCtx.font = '24px/1.4 "Fira Code", "Segoe UI", sans-serif';
  vexCtx.fillStyle = 'rgba(255,255,255,0.7)';
  vexCtx.fillText('Buffered scene demo', 72, 130);
  vexCtx.restore();
}

function addRandomStar() {
  const x = 200 + Math.random() * (SCENE_WIDTH - 400);
  const y = 200 + Math.random() * (SCENE_HEIGHT - 400);
  const spikes = 6 + Math.floor(Math.random() * 4);
  const outerRadius = 30 + Math.random() * 30;
  const innerRadius = outerRadius / 2;
  const rotation = Math.random() * Math.PI;
  vexCtx.save();
  vexCtx.translate(x, y);
  vexCtx.rotate(rotation);
  vexCtx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (i / (spikes * 2)) * Math.PI * 2;
    vexCtx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  vexCtx.closePath();
  vexCtx.fillStyle = '#ffe56b';
  vexCtx.shadowColor = '#ffdd57';
  vexCtx.shadowBlur = 20;
  vexCtx.fill();
  vexCtx.restore();
}

function wave(index, amplitude) {
  return Math.sin(index * 1.7) * amplitude;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function getViewportX() {
  return Number(panXInput.value);
}

function getViewportY() {
  return Number(panYInput.value);
}

function getViewportZoom() {
  return Number(zoomInput.value);
}

function updateViewInfo(x, y, zoom) {
  viewInfoEl.textContent = `Viewport: x${x.toFixed(0)} y${y.toFixed(0)} zoom${zoom.toFixed(2)}`;
}

function toggleButtons(disabled) {
  [rebuildBtn, commitBtn, addShapeBtn, cleanBtn].forEach((btn) => {
    btn.disabled = disabled;
  });
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
