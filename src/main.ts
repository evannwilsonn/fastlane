import "./style.css";
import { Genome } from "./neat";
import { CLEARS_TO_PASS, INPUTS, levelSpec, roadShape, Simulation, type SavedState } from "./simulation";
import { drawGenome } from "./visualizer";
import { drawLearningCurve } from "./chart";
import { themeFor } from "./themes";
import { HAZARD_HINTS, HAZARD_NAMES } from "./world/hazards";
import { drawIce, drawWeather } from "./world/scenery";
import type { Car } from "./car";

// Learning lasts for the tab session: a refresh or leaving and coming back in the same tab picks
// up where it left off; closing the tab or window starts over from random brains.
const STORAGE_KEY = "sdc.neat.v1";
/** Max speed runs as many steps as fit in this much of each frame. */
const MAX_BUDGET_MS = 14;
const ROAD_WIDTH = 210;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const roadCanvas = $<HTMLCanvasElement>("#road");
const brainCanvas = $<HTMLCanvasElement>("#brain");
const chartCanvas = $<HTMLCanvasElement>("#chart");
const chartCtx = chartCanvas.getContext("2d")!;
const roadCtx = roadCanvas.getContext("2d")!;
const brainCtx = brainCanvas.getContext("2d")!;

const ui = {
  generation: $("#stat-generation"),
  alive: $("#stat-alive"),
  run: $("#stat-run"),
  level: $("#stat-level"),
  levelNum: $("#stat-level-num"),
  place: $("#stat-place"),
  pips: $("#stat-pips"),
  population: $<HTMLInputElement>("#population"),
  populationOut: $<HTMLOutputElement>("#population-out"),
  mutation: $<HTMLInputElement>("#mutation"),
  mutationOut: $<HTMLOutputElement>("#mutation-out"),
  speed: $<HTMLFieldSetElement>("#speed"),
  sensors: $<HTMLInputElement>("#sensors"),
  drive: $<HTMLButtonElement>("#drive"),
  next: $<HTMLButtonElement>("#next"),
  forget: $<HTMLButtonElement>("#forget"),
  download: $<HTMLButtonElement>("#download"),
  status: $("#status"),
  brainNote: $("#brain-note"),
};

const css = getComputedStyle(document.documentElement);
const color = (name: string) => css.getPropertyValue(name).trim();
const palette = {
  asphalt: color("--asphalt"),
  white: color("--marking-white"),
  yellow: color("--marking-yellow"),
  orange: color("--construction"),
  blue: color("--sign-blue"),
  concrete: color("--concrete"),
  green: color("--sign-green"),
  shoulder: color("--shoulder"),
};

/* Storage is a convenience: the page works when it is blocked. Learning picks up where it left off. */
function loadState(): SavedState | null {
  try {
    localStorage.removeItem(STORAGE_KEY); // earlier versions kept progress forever
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as SavedState) : null;
    return s?.neat?.inputs === INPUTS && Array.isArray(s.neat.genomes) && s.neat.genomes.length ? s : null;
  } catch {
    return null;
  }
}
function saveState(): void {
  try {
    if (sim.generation > 1) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sim.toJSON()));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

let sim: Simulation;
try {
  sim = new Simulation(0, ROAD_WIDTH, { population: Number(ui.population.value), mutation: Number(ui.mutation.value), seed: (Math.random() * 2 ** 32) >>> 0 }, loadState());
} catch {
  sim = new Simulation(0, ROAD_WIDTH, { population: Number(ui.population.value), mutation: Number(ui.mutation.value), seed: (Math.random() * 2 ** 32) >>> 0 });
}

let stepsPerFrame = 1;
let viewW = 0;
let viewH = 0;

function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [width, height];
}

function resize(): void {
  [viewW, viewH] = fitCanvas(roadCanvas, roadCtx);
  fitCanvas(brainCanvas, brainCtx);
  fitCanvas(chartCanvas, chartCtx);
  chartDrawn = -1;
}
new ResizeObserver(resize).observe(roadCanvas);
new ResizeObserver(() => fitCanvas(brainCanvas, brainCtx)).observe(brainCanvas);
new ResizeObserver(() => {
  fitCanvas(chartCanvas, chartCtx);
  chartDrawn = -1;
}).observe(chartCanvas);


function announce(msg: string): void {
  ui.status.textContent = msg;
  // Replay the board's entrance so a new message is noticed.
  ui.status.classList.remove("is-fresh");
  void ui.status.offsetWidth;
  ui.status.classList.add("is-fresh");
}

/** Progress pips: one per layout that has to be cleared, filled as they are. */
function setPips(done: number, total: number, label: string): void {
  const key = `${done}/${total}`;
  if (ui.pips.dataset.key === key) return;
  ui.pips.dataset.key = key;
  ui.pips.replaceChildren(
    ...Array.from({ length: total }, (_, i) => {
      const li = document.createElement("li");
      if (i < done) li.className = "is-done";
      return li;
    }),
  );
  const caption = document.createElement("span");
  caption.textContent = `${done} of ${total} ${label}`;
  ui.pips.append(caption);
}

/** Two beams of light ahead of a car, for night roads. */
function headlights(ctx: CanvasRenderingContext2D, car: Car): void {
  if (car.damaged) return;
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(-car.angle);
  const beam = ctx.createLinearGradient(0, -car.height / 2, 0, -car.height / 2 - 120);
  beam.addColorStop(0, "rgba(255, 240, 200, 0.28)");
  beam.addColorStop(1, "rgba(255, 240, 200, 0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(-car.width / 2 + 3, -car.height / 2);
  ctx.lineTo(car.width / 2 - 3, -car.height / 2);
  ctx.lineTo(car.width / 2 + 26, -car.height / 2 - 120);
  ctx.lineTo(-car.width / 2 - 26, -car.height / 2 - 120);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

let camX = 0;
let camY: number | null = null;
function drawRoad(): void {
  const ctx = roadCtx;
  // Follows the best car still driving. When that changes, the camera glides to the new car
  // instead of jumping; a new layout (far away) snaps.
  const leader = sim.followed;
  if (camY === null || Math.abs(leader.y - camY) > 900) camY = leader.y;
  else camY += (leader.y - camY) * 0.18;
  const theme = themeFor(sim.levelSpec.road, sim.settings.seed);
  ctx.clearRect(0, 0, viewW, viewH);
  if (theme.ground) {
    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  ctx.save();
  const scale = Math.min(1.4, Math.max(1, viewW / (ROAD_WIDTH + 120)));
  ctx.translate(viewW / 2, viewH * 0.74);
  ctx.scale(scale, scale);
  // Follow the road through its curves, easing so the camera doesn't jerk sideways.
  camX += (sim.road.centerX(leader.y - 150) - camX) * 0.08;
  ctx.translate(-camX, -camY);

  const viewTop = camY - (viewH * 0.74) / scale;
  const viewBottom = camY + (viewH * 0.26) / scale;
  sim.road.draw(
    ctx,
    {
      surface: theme.asphalt || palette.asphalt,
      shoulder: theme.shoulder || palette.shoulder,
      lane: palette.white,
      edge: palette.white,
      center: palette.yellow,
      cone: palette.orange,
    },
    viewTop,
    viewBottom,
    theme.hazard === "ice" ? "snow" : theme.hazard === "sandstorm" ? "sand" : theme.hazard === "rain" ? "flood" : "construction",
  );
  theme.scenery(ctx, sim.road, viewTop, viewBottom, sim.settings.seed + sim.levelSpec.road);
  if (theme.night) {
    for (const car of sim.course.near(leader.y, viewH / scale)) headlights(ctx, car);
    headlights(ctx, leader);
  }

  const ice = sim.iceNear(leader.y, viewH / scale);
  if (ice.length) drawIce(ctx, ice);
  for (const car of sim.course.near(leader.y, viewH / scale)) car.draw(ctx, car.color ?? palette.concrete);

  ctx.globalAlpha = 0.16;
  for (const car of sim.cars) if (car !== leader) car.draw(ctx, car.damaged ? palette.concrete : theme.ghost || palette.white);
  ctx.globalAlpha = 1;

  leader.draw(ctx, leader.damaged ? palette.concrete : palette.yellow, ui.sensors.checked ? palette.yellow : undefined);
  const hazards = sim.hazards;
  if (hazards.length) drawWeather(ctx, hazards, { center: { x: camX, y: leader.y }, radius: viewH / scale }, leader, sim.frames);
  ctx.restore();
}

function drawBrain(now: number): void {
  const brain = sim.followed.brain;
  const { width, height } = brainCanvas.getBoundingClientRect();
  if (!(brain instanceof Genome)) {
    brainCtx.clearRect(0, 0, width, height);
    return;
  }
  drawGenome(brainCtx, brain, width, height, {
    positive: palette.yellow,
    negative: palette.blue,
    node: palette.asphalt,
    nodeOn: palette.yellow,
    label: palette.white,
  }, -now / 50);
}

let chartDrawn = -1;
function drawChart(): void {
  if (chartDrawn === sim.history.length) return;
  chartDrawn = sim.history.length;
  const { width, height } = chartCanvas.getBoundingClientRect();
  drawLearningCurve(chartCtx, sim.history, width, height, {
    odd: palette.yellow,
    even: palette.green,
    axis: palette.shoulder,
    label: palette.white,
    muted: palette.concrete,
  });
}

function brainSummary(): string {
  const g = sim.followed.brain instanceof Genome ? sim.followed.brain : null;
  if (!g) return "";
  const n = g.hiddenCount;
  return `${n} hidden ${n === 1 ? "neuron" : "neurons"}, ${g.enabledCount} links, ${sim.neat.species.length || 1} species`;
}

let lastStats = 0;
function updateStats(now: number): void {
  if (now - lastStats < 120) return;
  lastStats = now;
  const keys = sim.mode === "KEYS";
  ui.generation.textContent = keys ? "Manual" : String(sim.generation);
  ui.alive.textContent = keys ? "1" : `${sim.alive}/${sim.cars.length}`;
  const goal = sim.levelSpec.goal;
  const passed = Math.max(sim.bestPassed, sim.passedBy(sim.leader));
  ui.run.textContent = goal ? `${passed}/${goal}` : String(passed);
  // The world's "Sea fog" is just fog on a city highway at night.
  const weather = sim.hazards.map((h) => (h === "fog" && sim.light === "night" ? "Fog at night" : HAZARD_NAMES[h])).join(", ");
  ui.levelNum.textContent = String(sim.level);
  ui.level.textContent = weather || sim.levelSpec.name;
  ui.place.textContent = `${themeFor(sim.levelSpec.road, sim.settings.seed).name}, ${roadShapeText(sim.levelSpec.road)}`;
  setPips(sim.clears, CLEARS_TO_PASS, "layouts cleared");
  ui.brainNote.textContent = brainSummary();
}

function roadShapeText(road: number): string {
  const shape = roadShape(road, sim.settings.seed);
  const parts = [`${shape.laneCount} lanes`];
  if (shape.bends.length) parts.push("curves");
  if (shape.closures) parts.push("construction zones");
  return parts.join(", ");
}

function describeGeneration(): string {
  const s = sim.last;
  if (!s) return "Generation 1: random brains with no hidden neurons, sensors wired straight to the controls.";
  if (s.levelUp) {
    const next = levelSpec(s.level + 1);
    const nextTheme = themeFor(next.road, sim.settings.seed);
    const road = next.road !== levelSpec(s.level).road ? ` New road: ${nextTheme.name}, ${roadShapeText(next.road)}.` : "";
    const hazard = next.weather ? nextTheme.hazard : undefined;
    const weather = hazard ? ` The traffic stays the same, but now: ${HAZARD_NAMES[hazard].toLowerCase()}. ${HAZARD_HINTS[hazard][0].toUpperCase()}${HAZARD_HINTS[hazard].slice(1)}.` : "";
    return `Generation ${s.generation} cleared level ${s.level}.${road} Level ${next.number}: ${next.name}.${weather} Pass ${next.goal} cars on ${CLEARS_TO_PASS} different layouts.`;
  }
  if (s.cleared) return `Generation ${s.generation} passed ${s.passed} cars and cleared this layout: ${s.clears} of ${CLEARS_TO_PASS} needed for level ${s.level}.`;
  if (s.grew) return `Generation ${s.generation}'s best brain grew a neuron: ${s.neurons} hidden now. Passed ${s.passed} cars.`;
  return `Generation ${s.generation}: best car passed ${s.passed} cars. ${s.species} species are competing.`;
}

function frame(now: number): void {
  const t0 = performance.now();
  for (let i = 0; i < stepsPerFrame && performance.now() - t0 < MAX_BUDGET_MS; i++) {
    if (sim.step()) {
      saveState();
      announce(describeGeneration());
    }
  }
  drawRoad();
  drawBrain(now);
  drawChart();
  updateStats(now);
  requestAnimationFrame(frame);
}

/* Controls */
ui.population.addEventListener("input", () => {
  ui.populationOut.value = ui.population.value;
});
ui.population.addEventListener("change", () => {
  sim.setPopulation(Number(ui.population.value));
  announce(`Restarted generation ${sim.generation} with ${sim.settings.population} cars.`);
});
ui.mutation.addEventListener("input", () => {
  ui.mutationOut.value = `${Math.round(Number(ui.mutation.value) * 100)}%`;
  sim.settings.mutation = Number(ui.mutation.value);
  sim.applyMutation();
});

ui.speed.addEventListener("change", (e) => {
  const v = (e.target as HTMLInputElement).value;
  stepsPerFrame = v === "max" ? Infinity : Number(v);
});

ui.drive.addEventListener("click", () => {
  const toKeys = sim.mode === "AI";
  sim.setMode(toKeys ? "KEYS" : "AI");
  ui.drive.setAttribute("aria-pressed", String(toKeys));
  ui.drive.textContent = toKeys ? "Hand back to the cars" : "Drive it yourself";
  ui.next.disabled = toKeys;
  document.body.classList.toggle("is-manual", toKeys);
  announce(toKeys ? "You're driving. Use the arrow keys or W, A, S, D." : "The cars are driving again.");
  roadCanvas.focus();
});

ui.next.addEventListener("click", () => {
  sim.nextGeneration();
  saveState();
  announce(`Skipped ahead. ${describeGeneration()}`);
});

ui.forget.addEventListener("click", () => {
  sim.forget();
  saveState();
  announce("Learning reset: level 1, random brains with no hidden neurons.");
});

ui.download.addEventListener("click", async () => {
  const g = sim.neat.champion ?? (sim.leader.brain instanceof Genome ? sim.leader.brain : null);
  if (!g) return;
  const brain = g.toJSON();
  try {
    await navigator.clipboard.writeText(JSON.stringify(brain, null, 2));
    announce("Brain copied to the clipboard as JSON.");
  } catch {
    announce("Your browser blocked clipboard access. Run sim.neat.champion in the console to get the brain.");
  }
});

// Exposed for console experiments.
(window as unknown as { sim: Simulation }).sim = sim;

announce(sim.last ? `Picked up where you left off. ${describeGeneration()}` : describeGeneration());
resize();
requestAnimationFrame(frame);
