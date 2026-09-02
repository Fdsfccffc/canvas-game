import Matter from "matter-js";
import createElement from "lucide/dist/esm/createElement.js";
import RotateCcw from "lucide/dist/esm/icons/rotate-ccw.js";
import Volume2 from "lucide/dist/esm/icons/volume-2.js";
import VolumeX from "lucide/dist/esm/icons/volume-x.js";
import "./style.css";

const { Engine, Bodies, Body, Composite, Events } = Matter;

const WIDTH = 420;
const HEIGHT = 620;
const FLOOR_Y = 607;
const DANGER_Y = 112;
const DANGER_GRACE_MS = 5000;
const WIN_LEVEL = 11;
const DROP_DELAY = 520;
const PHYSICS_STEP = 1000 / 60;
const LABELS = ["一连", "二连", "三连", "五连", "六连", "七连", "八连", "九连", "十连", "十一连", "十二连", "四连"];
const NUMERALS = ["一", "二", "三", "五", "六", "七", "八", "九", "十", "十一", "十二", "四"];
const RADII = [22, 27, 33, 40, 48, 57, 67, 78, 90, 103, 117, 132];
const COLORS = [
  "#4f8f7d", "#d89a36", "#d66047", "#4f76a7", "#945f8d",
  "#378c9b", "#66723c", "#7d5d46", "#315968", "#263f34",
  "#8e5549", "#c74332",
];
const VERIFY_FINAL_MERGE = import.meta.env.DEV && new URLSearchParams(window.location.search).has("verify-final");
const VERIFY_DANGER = import.meta.env.DEV && new URLSearchParams(window.location.search).has("verify-danger");

const canvas = document.querySelector("#game-canvas");
const ctx = canvas.getContext("2d");
const boardFrame = document.querySelector("#board-frame");
const scoreEl = document.querySelector("#score");
const bestScoreEl = document.querySelector("#best-score");
const nextTokenEl = document.querySelector("#next-token");
const progressBar = document.querySelector("#progress-bar");
const highestLabel = document.querySelector("#highest-label");
const tokenGrid = document.querySelector("#token-grid");
const statusNote = document.querySelector("#status-note");
const dropCursor = document.querySelector("#drop-cursor");
const resultDialog = document.querySelector("#result-dialog");
const resultTitle = document.querySelector("#result-title");
const resultEyebrow = document.querySelector("#result-eyebrow");
const resultCopy = document.querySelector("#result-copy");
const resultSeal = document.querySelector("#result-seal");
const resultScore = document.querySelector("#result-score");
const continueButton = document.querySelector("#continue-button");
const toast = document.querySelector("#toast");
const soundButton = document.querySelector("#sound-button");

let engine;
let walls = [];
let score = 0;
let bestScore = readNumber("silian-best", 0);
let highestLevel = 0;
let discoveredLevel = Math.min(WIN_LEVEL, readNumber("silian-12-chain-discovered", 0));
let nextLevel = 0;
let aimX = WIDTH / 2;
let canDrop = true;
let paused = false;
let gameOver = false;
let victoryShown = false;
let dangerStartedAt = 0;
let lastTime = performance.now();
let physicsAccumulator = 0;
let bodySerial = 0;
let toastTimer;
let pointerStart = null;
let muted = localStorage.getItem("silian-muted") === "true";
let audioContext = null;
const mergeQueue = [];
const particles = [];
const confetti = [];

function readNumber(key, fallback) {
  const value = Number.parseInt(localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function setupIcons() {
  const iconMap = { "rotate-ccw": RotateCcw, "volume-2": Volume2, "volume-x": VolumeX };
  document.querySelectorAll("i[data-lucide]").forEach((placeholder) => {
    const icon = iconMap[placeholder.dataset.lucide];
    if (!icon) return;
    const svg = createElement(icon);
    svg.setAttribute("aria-hidden", "true");
    placeholder.replaceWith(svg);
  });
}

function buildCollection() {
  tokenGrid.innerHTML = "";
  LABELS.forEach((label, index) => {
    const item = document.createElement("li");
    item.className = `token-tile${index <= discoveredLevel ? " unlocked" : ""}`;
    item.style.setProperty("--token-color", COLORS[index]);
    item.dataset.level = index;
    item.textContent = label;
    tokenGrid.append(item);
  });
}

function createEngine() {
  engine = Engine.create({
    gravity: { x: 0, y: 1.08, scale: 0.001 },
    positionIterations: 8,
    velocityIterations: 6,
    constraintIterations: 3,
  });

  const wallOptions = {
    isStatic: true,
    friction: 0.28,
    restitution: 0.08,
    label: "wall",
  };
  walls = [
    Bodies.rectangle(-12, HEIGHT / 2, 28, HEIGHT + 80, wallOptions),
    Bodies.rectangle(WIDTH + 12, HEIGHT / 2, 28, HEIGHT + 80, wallOptions),
    Bodies.rectangle(WIDTH / 2, FLOOR_Y + 18, WIDTH + 50, 36, wallOptions),
  ];
  Composite.add(engine.world, walls);

  Events.on(engine, "collisionStart", ({ pairs }) => {
    for (const pair of pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      if (!a.plugin.gameBall || !b.plugin.gameBall) continue;
      if (a.plugin.level !== b.plugin.level || a.plugin.merging || b.plugin.merging) continue;
      if (a.plugin.level >= LABELS.length - 1) continue;
      a.plugin.merging = true;
      b.plugin.merging = true;
      mergeQueue.push([a, b]);
    }
  });
}

function makeBall(x, y, level, options = {}) {
  const radius = RADII[level];
  const body = Bodies.circle(x, y, radius, {
    restitution: 0.12,
    friction: 0.16,
    frictionStatic: 0.42,
    frictionAir: 0.008,
    density: 0.0011 + level * 0.00012,
    slop: 0.02,
    label: `token-${level + 1}`,
  });
  body.plugin.gameBall = true;
  body.plugin.level = level;
  body.plugin.merging = false;
  body.plugin.bornAt = performance.now();
  body.plugin.serial = bodySerial++;
  if (options.velocity) Body.setVelocity(body, options.velocity);
  if (options.angularVelocity) Body.setAngularVelocity(body, options.angularVelocity);
  Composite.add(engine.world, body);
  unlockLevel(level);
  return body;
}

function unlockLevel(level) {
  if (level > highestLevel) highestLevel = level;
  if (level > discoveredLevel) {
    discoveredLevel = level;
    if (!VERIFY_FINAL_MERGE) localStorage.setItem("silian-12-chain-discovered", String(discoveredLevel));
    const tile = tokenGrid.querySelector(`[data-level="${level}"]`);
    tile?.classList.add("unlocked", "just-unlocked");
    window.setTimeout(() => tile?.classList.remove("just-unlocked"), 500);
  }
  highestLabel.textContent = LABELS[highestLevel];
  progressBar.style.width = `${Math.min(100, ((highestLevel + 1) / (WIN_LEVEL + 1)) * 100)}%`;
}

function chooseNextLevel() {
  const roll = Math.random();
  nextLevel = roll < 0.55 ? 0 : roll < 0.84 ? 1 : 2;
  nextTokenEl.textContent = LABELS[nextLevel];
  nextTokenEl.style.color = "#fff";
}

function dropBall() {
  if (!canDrop || paused || gameOver) return;
  unlockAudio();
  const radius = RADII[nextLevel];
  aimX = clamp(aimX, radius + 5, WIDTH - radius - 5);
  const body = makeBall(aimX, Math.max(30, radius + 8), nextLevel);
  Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.045);
  canDrop = false;
  status("落子中");
  chooseNextLevel();
  window.setTimeout(() => {
    if (!paused && !gameOver) {
      canDrop = true;
      status("等待落子");
    }
  }, DROP_DELAY);
}

function processMerges() {
  while (mergeQueue.length) {
    const [a, b] = mergeQueue.shift();
    if (!Composite.get(engine.world, a.id, "body") || !Composite.get(engine.world, b.id, "body")) continue;
    const next = a.plugin.level + 1;
    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;
    const velocity = {
      x: (a.velocity.x + b.velocity.x) * 0.34,
      y: Math.min(-1.7, (a.velocity.y + b.velocity.y) * 0.2 - 1.5),
    };
    const angularVelocity = (a.angularVelocity + b.angularVelocity) / 2;
    Composite.remove(engine.world, [a, b]);
    makeBall(x, y, next, { velocity, angularVelocity });
    const gained = 10 * 2 ** next;
    score += gained;
    updateScore();
    burst(x, y, COLORS[next], next);
    playMergeSound(next);
    status(`合成${LABELS[next]} · +${gained}`);

    if (next === WIN_LEVEL && !victoryShown) {
      victoryShown = true;
      launchConfetti();
      window.setTimeout(() => showResult("victory"), 650);
    }
  }
}

function updateScore() {
  scoreEl.textContent = score.toLocaleString("zh-CN");
  if (score > bestScore) {
    bestScore = score;
    localStorage.setItem("silian-best", String(bestScore));
  }
  bestScoreEl.textContent = bestScore.toLocaleString("zh-CN");
}

function status(message, danger = false) {
  statusNote.lastElementChild.textContent = message;
  statusNote.classList.toggle("danger", danger);
}

function checkDanger(now) {
  if (paused || gameOver) {
    dangerStartedAt = 0;
    boardFrame.classList.remove("danger-flash");
    return;
  }
  const dangerBodies = Composite.allBodies(engine.world).filter((body) => {
    if (!body.plugin.gameBall || body.plugin.merging) return false;
    const radius = RADII[body.plugin.level];
    return body.position.y - radius <= DANGER_Y;
  });

  if (dangerBodies.length) {
    if (!dangerStartedAt) dangerStartedAt = now;
    const elapsed = now - dangerStartedAt;
    const remaining = Math.max(0, Math.ceil((DANGER_GRACE_MS - elapsed) / 1000));
    boardFrame.classList.add("danger-flash");
    status(`红线预警 · ${remaining}s`, true);
    if (elapsed > DANGER_GRACE_MS) endGame();
  } else {
    if (dangerStartedAt) status("空间恢复");
    dangerStartedAt = 0;
    boardFrame.classList.remove("danger-flash");
  }
}

function endGame() {
  gameOver = true;
  paused = true;
  canDrop = false;
  showResult("gameover");
}

function showResult(type) {
  paused = true;
  resultScore.textContent = score.toLocaleString("zh-CN");
  if (type === "victory") {
    resultEyebrow.textContent = "合成成功";
    resultTitle.textContent = "四连达成";
    resultCopy.textContent = "十二连相合，终成四连。完整棋谱已经点亮。";
    resultSeal.textContent = "四";
    continueButton.hidden = false;
  } else {
    resultEyebrow.textContent = "本局结束";
    resultTitle.textContent = "棋盘已满";
    resultCopy.textContent = victoryShown ? "四连已经到手，这局也算漂亮。" : "调整落点，给大棋子留出相合的空间。";
    resultSeal.textContent = highestLevel >= WIN_LEVEL ? "成" : NUMERALS[highestLevel];
    continueButton.hidden = true;
  }
  resultDialog.hidden = false;
  (continueButton.hidden ? document.querySelector("#dialog-restart") : continueButton).focus();
}

function hideResultAndContinue() {
  resultDialog.hidden = true;
  paused = false;
  canDrop = true;
  status("继续落子");
  canvas.focus();
}

function resetGame() {
  resultDialog.hidden = true;
  mergeQueue.length = 0;
  particles.length = 0;
  confetti.length = 0;
  Composite.allBodies(engine.world).forEach((body) => {
    if (body.plugin.gameBall) Composite.remove(engine.world, body);
  });
  score = 0;
  highestLevel = 0;
  victoryShown = false;
  dangerStartedAt = 0;
  gameOver = false;
  paused = false;
  canDrop = true;
  aimX = WIDTH / 2;
  updateScore();
  unlockLevel(0);
  chooseNextLevel();
  updateCursor();
  status("等待落子");
  showToast("新棋局已开始");
}

function burst(x, y, color, level) {
  const count = Math.min(22, 10 + level * 2);
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
    const speed = 1.2 + Math.random() * (2.4 + level * 0.15);
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      size: 2 + Math.random() * 4,
      color,
    });
  }
}

function launchConfetti() {
  for (let i = 0; i < 80; i += 1) {
    confetti.push({
      x: WIDTH * (0.1 + Math.random() * 0.8),
      y: -20 - Math.random() * 160,
      vx: (Math.random() - 0.5) * 2.1,
      vy: 2 + Math.random() * 2.8,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.22,
      size: 4 + Math.random() * 7,
      color: COLORS[Math.floor(Math.random() * 7)],
    });
  }
}

function updateEffects(delta) {
  const factor = Math.min(2, delta / 16.67);
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.x += p.vx * factor;
    p.y += p.vy * factor;
    p.vy += 0.08 * factor;
    p.life -= 0.035 * factor;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = confetti.length - 1; i >= 0; i -= 1) {
    const p = confetti[i];
    p.x += p.vx * factor;
    p.y += p.vy * factor;
    p.vy += 0.025 * factor;
    p.rotation += p.spin * factor;
    if (p.y > HEIGHT + 20) confetti.splice(i, 1);
  }
}

function render() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.max(1, Math.round(rect.width * dpr));
  const targetHeight = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  ctx.setTransform((rect.width / WIDTH) * dpr, 0, 0, (rect.height / HEIGHT) * dpr, 0, 0);
  drawBoard();
  const balls = Composite.allBodies(engine.world)
    .filter((body) => body.plugin.gameBall)
    .sort((a, b) => a.plugin.level - b.plugin.level || a.plugin.serial - b.plugin.serial);
  balls.forEach(drawBall);
  drawEffects();
}

function drawBoard() {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#f6f8f4";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.save();
  ctx.strokeStyle = "rgba(41, 73, 58, 0.055)";
  ctx.lineWidth = 1;
  for (let y = 20; y < HEIGHT; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }
  for (let x = 18; x < WIDTH; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.setLineDash([7, 7]);
  const dangerPulse = dangerStartedAt ? 0.56 + 0.44 * ((Math.sin(performance.now() / 170) + 1) / 2) : 0;
  ctx.lineDashOffset = dangerStartedAt ? -((performance.now() / 28) % 14) : 0;
  ctx.lineWidth = dangerStartedAt ? 1.2 + dangerPulse * 1.35 : 1.2;
  ctx.strokeStyle = dangerStartedAt
    ? `rgba(199, 67, 50, ${0.35 + dangerPulse * 0.6})`
    : "rgba(199, 67, 50, 0.38)";
  ctx.beginPath();
  ctx.moveTo(0, DANGER_Y);
  ctx.lineTo(WIDTH, DANGER_Y);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "rgba(42, 66, 54, 0.11)";
  ctx.fillRect(0, FLOOR_Y - 2, WIDTH, 4);
}

function drawBall(body) {
  const { x, y } = body.position;
  const level = body.plugin.level;
  const radius = RADII[level];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(body.angle * 0.22);

  ctx.beginPath();
  ctx.arc(3, 5, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(22, 37, 29, 0.18)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = COLORS[level];
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, radius * 0.055);
  ctx.strokeStyle = "rgba(255,255,255,0.72)";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.78, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(-radius * 0.25, -radius * 0.31, Math.max(2, radius * 0.13), Math.PI * 1.08, Math.PI * 1.72);
  ctx.lineWidth = Math.max(1.5, radius * 0.07);
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.58)";
  ctx.stroke();

  const fontSize = Math.max(13, Math.min(37, radius * (level === 9 ? 0.55 : 0.7)));
  ctx.fillStyle = "#fffdf7";
  ctx.font = `700 ${fontSize}px KaiTi, STKaiti, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 1;
  ctx.fillText(NUMERALS[level], 0, level < 2 ? -2 : -radius * 0.08);
  if (radius >= 32) {
    ctx.font = `700 ${Math.max(9, radius * 0.22)}px KaiTi, STKaiti, serif`;
    ctx.fillText("连", 0, radius * 0.38);
  }
  ctx.restore();
}

function drawEffects() {
  particles.forEach((p) => {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  confetti.forEach((p) => {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.65);
    ctx.restore();
  });
}

function loop(now) {
  const delta = Math.min(50, now - lastTime || PHYSICS_STEP);
  lastTime = now;
  if (!paused) {
    physicsAccumulator += delta;
    let steps = 0;
    while (physicsAccumulator >= PHYSICS_STEP && steps < 3) {
      Engine.update(engine, PHYSICS_STEP);
      processMerges();
      physicsAccumulator -= PHYSICS_STEP;
      steps += 1;
    }
    checkDanger(now);
  } else {
    physicsAccumulator = 0;
  }
  updateEffects(delta);
  render();
  requestAnimationFrame(loop);
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
  };
}

function updateAim(event) {
  const pos = pointerPosition(event);
  const radius = RADII[nextLevel];
  aimX = clamp(pos.x, radius + 5, WIDTH - radius - 5);
  updateCursor();
  return pos;
}

function updateCursor() {
  dropCursor.style.left = `${(aimX / WIDTH) * 100}%`;
  dropCursor.style.opacity = canDrop && !paused ? "1" : "0.25";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1600);
}

function unlockAudio() {
  if (muted) return;
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume();
}

function playMergeSound(level) {
  if (muted) return;
  unlockAudio();
  if (!audioContext) return;
  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = level >= WIN_LEVEL ? "sine" : "triangle";
  osc.frequency.setValueAtTime(330 + level * 58, now);
  osc.frequency.exponentialRampToValueAtTime(460 + level * 72, now + 0.12);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  osc.connect(gain).connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + 0.2);
}

function toggleSound() {
  muted = !muted;
  localStorage.setItem("silian-muted", String(muted));
  renderSoundButton();
  if (!muted) {
    unlockAudio();
    showToast("音效已开启");
  }
}

function renderSoundButton() {
  soundButton.innerHTML = `<i data-lucide="${muted ? "volume-x" : "volume-2"}" aria-hidden="true"></i>`;
  soundButton.setAttribute("aria-label", muted ? "开启音效" : "关闭音效");
  soundButton.dataset.tooltip = muted ? "开启音效" : "关闭音效";
  setupIcons();
}

canvas.tabIndex = 0;
canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture?.(event.pointerId);
  const pos = updateAim(event);
  pointerStart = { ...pos, id: event.pointerId };
});
canvas.addEventListener("pointermove", (event) => {
  updateAim(event);
});
canvas.addEventListener("pointerup", (event) => {
  if (!pointerStart || pointerStart.id !== event.pointerId) return;
  updateAim(event);
  pointerStart = null;
  dropBall();
});
canvas.addEventListener("pointercancel", () => { pointerStart = null; });

window.addEventListener("keydown", (event) => {
  if (resultDialog.hidden === false) return;
  const step = event.shiftKey ? 28 : 12;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    aimX = clamp(aimX - step, RADII[nextLevel] + 5, WIDTH - RADII[nextLevel] - 5);
    updateCursor();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    aimX = clamp(aimX + step, RADII[nextLevel] + 5, WIDTH - RADII[nextLevel] - 5);
    updateCursor();
  } else if (event.code === "Space" || event.key === "Enter") {
    event.preventDefault();
    dropBall();
  }
});

document.querySelector("#restart-button").addEventListener("click", resetGame);
document.querySelector("#dialog-restart").addEventListener("click", resetGame);
continueButton.addEventListener("click", hideResultAndContinue);
soundButton.addEventListener("click", toggleSound);
window.addEventListener("resize", render);

buildCollection();
createEngine();
bestScoreEl.textContent = bestScore.toLocaleString("zh-CN");
unlockLevel(0);
chooseNextLevel();
updateScore();
updateCursor();
setupIcons();
renderSoundButton();
if (VERIFY_FINAL_MERGE) {
  const penultimateLevel = WIN_LEVEL - 1;
  const mergeY = FLOOR_Y - RADII[penultimateLevel] - 8;
  makeBall(WIDTH / 2 - 72, mergeY, penultimateLevel, { velocity: { x: 0.8, y: 0 } });
  makeBall(WIDTH / 2 + 72, mergeY, penultimateLevel, { velocity: { x: -0.8, y: 0 } });
}
if (VERIFY_DANGER) {
  const dangerLevel = 0;
  const dangerBody = makeBall(WIDTH / 2, DANGER_Y + RADII[dangerLevel] - 0.5, dangerLevel);
  Body.setStatic(dangerBody, true);
}
requestAnimationFrame(loop);
