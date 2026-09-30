// Offline renderer entry. The page builds one shot and exposes
// window.renderFrame(t, samples): it poses the shot at time t (seconds, set by
// the caller — never the wall clock), path-traces `samples` samples and
// returns the frame as a PNG data URL.
import * as THREE from "three";
import { PhysicalCamera, WebGLPathTracer } from "three-gpu-pathtracer";
import { buildBottle, buildDish, buildDrop, buildLights, buildPebble, buildPlinth, buildSet } from "./scene.js";

const params = new URLSearchParams(location.search);
const W = Number(params.get("w") ?? 720);
const H = Number(params.get("h") ?? 1280);
const SHOT = params.get("shot") ?? "pedestal";

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(params.get("exposure") ?? 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new PhysicalCamera(20, W / H, 0.005, 20);
camera.apertureBlades = 7;
camera.apertureRotation = 0.3;

const tracer = new WebGLPathTracer(renderer);
tracer.renderDelay = 0;
tracer.fadeDuration = 0;
tracer.minSamples = 1;
tracer.dynamicLowRes = false;
tracer.rasterizeScene = false;
tracer.bounces = 7;
tracer.transmissiveBounces = 10;
// Caustics through glass and serum are the render's fireflies; blurring them
// costs nothing a viewer would miss.
tracer.filterGlossyFactor = 1;
tracer.multipleImportanceSampling = true;
tracer.tiles.set(2, 2);

const lights = buildLights(renderer, scene);

/** A hand-held camera: small, slow, never-repeating sway (sum of sines). */
function handheld(t, amount = 1) {
  const s = (f, p) => Math.sin(t * f + p);
  return {
    x: (s(1.3, 0.2) * 0.6 + s(2.9, 1.7) * 0.3 + s(5.3, 0.9) * 0.1) * 0.0016 * amount,
    y: (s(1.1, 2.1) * 0.6 + s(3.7, 0.4) * 0.3 + s(6.1, 2.8) * 0.1) * 0.0012 * amount,
    roll: (s(0.9, 1.2) * 0.7 + s(2.3, 0.5) * 0.3) * 0.0035 * amount,
  };
}

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function aim(position, target, t, sway = 1) {
  const h = handheld(t, sway);
  camera.position.set(position.x + h.x, position.y + h.y, position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.rotateZ(h.roll);
  camera.updateMatrixWorld();
}

// ── Shots ──────────────────────────────────────────────────────────────────

const shots = {
  /** Bottle on a travertine plinth; a slow dolly in. */
  pedestal() {
    scene.add(buildSet({ surface: "linen" }));
    const plinth = buildPlinth();
    scene.add(plinth);
    const bottle = buildBottle();
    bottle.position.y = 0.038;
    bottle.rotation.y = -0.35;
    scene.add(bottle);
    const pebble = buildPebble(4, 0.012, "#d9cfbf");
    pebble.position.set(0.075, 0.0051, 0.035);
    scene.add(pebble);
    return {
      duration: 3.5,
      pose(t) {
        const k = ease(t / 3.5);
        const z = 0.64 - k * 0.14;
        camera.fov = 19;
        camera.fStop = 2.4;
        aim(new THREE.Vector3(0.02, 0.095, z), new THREE.Vector3(0, 0.086, 0), t);
        camera.focusDistance = camera.position.distanceTo(new THREE.Vector3(0, 0.07, 0.016));
      },
    };
  },

  /** Texture: drops of serum on the stone, the bottle soft behind; a slow slide. */
  texture() {
    scene.add(buildSet({ surface: "linen" }));
    const plinth = buildPlinth();
    scene.add(plinth);
    const bottle = buildBottle();
    bottle.position.set(0.012, 0.038, -0.028);
    bottle.rotation.y = -0.2;
    scene.add(bottle);
    const serumMaterial = bottle.children[1].material;
    // A bead only millimetres deep would be almost clear in the bottle's serum:
    // the beads get a denser amber, as a real drop of serum shows.
    const beadMaterial = serumMaterial.clone();
    beadMaterial.attenuationColor = new THREE.Color("#d9963a");
    beadMaterial.attenuationDistance = 0.006;
    // [x, z, footprint radius, contact angle]: serum beads on the stone.
    // Clustered within the ~2 cm a macro lens sees across a portrait frame.
    [
      [-0.006, 0.02, 0.0042, 0.85],
      [0.0025, 0.0265, 0.0028, 0.95],
      [-0.0005, 0.0135, 0.002, 1.0],
      [-0.0095, 0.0305, 0.0016, 1.02],
      [0.0045, 0.0345, 0.0013, 1.05],
    ].forEach(([x, z, r, contact]) => {
      const drop = buildDrop(beadMaterial, r, contact);
      drop.position.set(x, 0.038, z);
      scene.add(drop);
    });
    return {
      duration: 3.5,
      pose(t) {
        const k = ease(t / 3.5);
        // Looking down onto the stone, so the beads fill the frame and the
        // bottle stands soft behind them.
        camera.fov = 26;
        camera.fStop = 8;
        aim(new THREE.Vector3(-0.008 + k * 0.01, 0.074, 0.092), new THREE.Vector3(-0.002, 0.039, 0.022), t, 0.3);
        camera.focusDistance = camera.position.distanceTo(new THREE.Vector3(-0.004, 0.0405, 0.021));
      },
    };
  },

  /** The bottle turning slowly on the plinth, the label coming round. */
  turntable() {
    scene.add(buildSet({ surface: "oak" }));
    const turn = new THREE.Group();
    const plinth = buildPlinth();
    turn.add(plinth);
    const bottle = buildBottle();
    bottle.position.y = 0.038;
    turn.add(bottle);
    scene.add(turn);
    return {
      duration: 3.5,
      rebuild: true,
      pose(t) {
        turn.rotation.y = -1.2 + t * 0.42;
        camera.fov = 18;
        camera.fStop = 2.8;
        aim(new THREE.Vector3(-0.03, 0.115, 0.5), new THREE.Vector3(0, 0.082, 0), t, 0.6);
        camera.focusDistance = camera.position.distanceTo(new THREE.Vector3(0, 0.07, 0.016));
      },
    };
  },

  /** Flat lay from above: the bottle on linen with pebbles and the dish. */
  flatlay() {
    scene.add(buildSet({ surface: "linen" }));
    const bottle = buildBottle({ lying: true });
    // Lying down, label up: tip it over about x, then turn it about the vertical.
    bottle.rotation.order = "YXZ";
    bottle.rotation.set(-Math.PI / 2, 0.55, 0);
    bottle.position.set(0.006, 0.0161, 0.0);
    scene.add(bottle);
    const dish = buildDish();
    dish.position.set(-0.042, 0.0, 0.066);
    scene.add(dish);
    const serumMaterial = bottle.children[1].material;
    const puddle = buildDrop(serumMaterial, 0.0085, 0.32);
    puddle.position.set(-0.042, 0.0022, 0.066);
    scene.add(puddle);
    [
      [0.052, 0.07, 0.013, "#cdbfa9", 7],
      [0.068, 0.046, 0.009, "#b7a88f", 8],
      [-0.05, -0.066, 0.012, "#d6cab6", 9],
    ].forEach(([x, z, size, tint, seed]) => {
      const pebble = buildPebble(seed, size, tint);
      pebble.position.set(x, size * 0.42, z);
      scene.add(pebble);
    });
    renderer.toneMappingExposure = 0.82;
    return {
      duration: 3.5,
      pose(t) {
        camera.fov = 30;
        camera.fStop = 5.6;
        const k = ease(t / 3.5);
        const h = handheld(t, 0.5);
        camera.position.set(0.0 + h.x, 0.4 - k * 0.025, 0.0005 + h.y);
        const turn = -0.2 + k * 0.08;
        camera.up.set(Math.sin(turn), 0, -Math.cos(turn));
        camera.lookAt(0.0, 0, 0.0);
        camera.updateMatrixWorld();
        camera.focusDistance = camera.position.y - 0.016;
      },
    };
  },

  /** Rack focus: from a dish on a stone block by the lens to the bottle behind it. */
  rack() {
    scene.add(buildSet({ surface: "oak" }));
    const plinth = buildPlinth();
    scene.add(plinth);
    const bottle = buildBottle();
    bottle.position.y = 0.038;
    bottle.rotation.y = 0.2;
    scene.add(bottle);
    // The foreground: a second, taller block with a dish of serum on it.
    const block = buildPlinth();
    block.scale.set(0.9, 1.45, 0.9);
    block.position.set(-0.012, 0, 0.24);
    scene.add(block);
    const dish = buildDish();
    dish.position.set(-0.012, 0.0551, 0.24);
    scene.add(dish);
    const serumMaterial = bottle.children[1].material;
    const puddle = buildDrop(serumMaterial, 0.009, 0.32);
    puddle.position.set(-0.012, 0.0573, 0.24);
    scene.add(puddle);
    return {
      duration: 3.5,
      pose(t) {
        camera.fov = 22;
        camera.fStop = 2.0;
        const cam = new THREE.Vector3(0.004, 0.092, 0.46 - ease(t / 3.5) * 0.015);
        aim(cam, new THREE.Vector3(0.0, 0.072, 0), t, 0.5);
        const nearDist = cam.distanceTo(new THREE.Vector3(-0.012, 0.058, 0.24));
        const farDist = cam.distanceTo(new THREE.Vector3(0, 0.07, 0.016));
        const k = ease((t - 0.9) / 1.5);
        camera.focusDistance = nearDist + (farDist - nearDist) * k;
      },
    };
  },
};

const shot = shots[SHOT]();
let built = false;

async function ensureScene(force) {
  if (!built || force) {
    tracer.setScene(scene, camera);
    built = true;
  } else {
    tracer.updateCamera();
  }
}

window.shotDuration = shot.duration;
window.renderFrame = async (t, samples = 64) => {
  shot.pose(t);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  await ensureScene(!!shot.rebuild);
  tracer.updateCamera();
  tracer.reset();
  // Shaders compile asynchronously: no sample is taken until they are ready.
  const started = performance.now();
  const gl = renderer.getContext();
  while (tracer.samples < samples) {
    if (gl.isContextLost()) throw new Error("webgl context lost");
    tracer.renderSample();
    if (tracer.isCompiling || tracer.samples === 0) await new Promise((resolve) => setTimeout(resolve, 16));
    if (performance.now() - started > 600000) throw new Error("render timed out");
  }
  return renderer.domElement.toDataURL("image/png");
};
window.ready = true;
void lights;
