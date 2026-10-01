// The studio and the product: a clear-glass dropper bottle of golden serum on
// travertine and linen, lit like a small tabletop product shoot. Real-world
// units (metres), so the path tracer's depth of field behaves like a lens.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { brushed, carton, linen, oak, travertine, label, makeNoise, mottled } from "./textures.js";

const GOLD = new THREE.Color("#d9a441");

/** Revolve a (radius, height) outline into a closed solid. */
function lathe(points, segments = 128) {
  const geometry = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
  geometry.computeVertexNormals();
  return geometry;
}

/** Round a polyline's corners so the lathe reads as moulded glass. */
function smoothOutline(points, iterations = 2) {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/**
 * The serum in a bottle lying on its side (local +z is up once it is tipped
 * over): it pools below a level plane, leaving a strip of air along the top
 * of the body, instead of standing in the bottle's own frame.
 */
function lyingSerum(material) {
  const r = 0.0134;
  const bevel = 0.0005;
  const level = r * 0.42;
  const from = Math.acos(level / r);
  const shape = new THREE.Shape();
  const steps = 72;
  for (let k = 0; k <= steps; k++) {
    const phi = from + ((Math.PI * 2 - 2 * from) * k) / steps;
    // (u, v) = (x, -z): extruded along the bottle's axis below.
    const u = r * Math.sin(phi);
    const v = -r * Math.cos(phi);
    if (k === 0) shape.moveTo(u, v);
    else shape.lineTo(u, v);
  }
  shape.closePath();
  const length = 0.042;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 72,
  });
  // Extrusion runs along +z; turn it onto the bottle's axis (+y), with v back to z.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0.0056, 0);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export function buildBottle({ lying = false } = {}) {
  const bottle = new THREE.Group();
  bottle.name = "bottle";

  // Glass: outer wall up, over the lip, inner wall down — one closed volume.
  const outer = smoothOutline([
    [0.0, 0.0],
    [0.0148, 0.0],
    [0.016, 0.0014],
    [0.016, 0.05],
    [0.0156, 0.0535],
    [0.0142, 0.0572],
    [0.0118, 0.0604],
    [0.0096, 0.0628],
    [0.0092, 0.064],
    [0.0092, 0.0712],
    [0.0086, 0.072],
  ]);
  const inner = smoothOutline([
    [0.0072, 0.072],
    [0.0072, 0.0642],
    [0.0082, 0.0622],
    [0.0104, 0.0598],
    [0.0128, 0.0566],
    [0.0139, 0.053],
    [0.0141, 0.05],
    [0.0141, 0.0058],
    [0.0132, 0.0046],
    [0.0, 0.0044],
  ]);
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color("#fbfaf6"),
    metalness: 0,
    roughness: 0.02,
    transmission: 1,
    ior: 1.5,
    thickness: 0.002,
    attenuationColor: new THREE.Color("#f3efe2"),
    attenuationDistance: 0.35,
    specularIntensity: 1,
    clearcoat: 0,
    side: THREE.DoubleSide,
  });
  const glass = new THREE.Mesh(lathe([...outer, ...inner]), glassMaterial);
  bottle.add(glass);

  // Serum: fills the body to just under the shoulder, slightly inset from the
  // wall, so a band of it shows above the label; its surface climbs the glass
  // at the edge (the meniscus) instead of ending in a hard flat block.
  const serumMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color("#ffffff"),
    roughness: 0.0,
    transmission: 1,
    ior: 1.38,
    thickness: 0.02,
    attenuationColor: new THREE.Color("#dea24a"),
    attenuationDistance: 0.036,
    side: THREE.DoubleSide,
  });
  const fill = 0.0462;
  const serum = lying
    ? lyingSerum(serumMaterial)
    : new THREE.Mesh(
        lathe(
          smoothOutline([
            [0.0, 0.0047],
            [0.0131, 0.0049],
            [0.0138, 0.0062],
            [0.0138, fill + 0.0011],
            [0.0134, fill + 0.0005],
            [0.0122, fill + 0.0001],
            [0.0, fill],
          ]),
        ),
        serumMaterial,
      );
  bottle.add(serum);

  // Pipette: a thin glass tube reaching into the serum, with serum drawn up.
  const pipetteGlass = new THREE.Mesh(
    lathe(
      smoothOutline(
        [
          [0.0, 0.0115],
          [0.0009, 0.0118],
          [0.0021, 0.016],
          [0.0034, 0.022],
          [0.0034, 0.078],
          [0.0026, 0.078],
          [0.0026, 0.0225],
          [0.0015, 0.0165],
          [0.0005, 0.0125],
          [0.0, 0.0123],
        ],
        1,
      ),
      64,
    ),
    glassMaterial,
  );
  bottle.add(pipetteGlass);
  const pipetteSerum = new THREE.Mesh(
    lathe(
      [
        [0.0, 0.0126],
        [0.0005, 0.0128],
        [0.0014, 0.0168],
        [0.0024, 0.023],
        [0.0024, 0.034],
        [0.0, 0.034],
      ],
      48,
    ),
    serum.material,
  );
  bottle.add(pipetteSerum);

  // Collar: brushed gold with fine ribs.
  const collarOutline = [[0.0094, 0.0655]];
  for (let i = 0; i <= 28; i++) {
    const y = 0.0662 + i * 0.00052;
    collarOutline.push([i % 2 ? 0.0104 : 0.0101, y]);
  }
  collarOutline.push([0.0103, 0.0814], [0.0096, 0.0822], [0.0072, 0.0824], [0.0072, 0.0655]);
  const collar = new THREE.Mesh(
    lathe(collarOutline, 160),
    new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#d4ab62"), metalness: 1, roughness: 1, roughnessMap: brushed(13) }),
  );
  bottle.add(collar);

  // Bulb: soft-touch rubber in warm ivory.
  const bulb = new THREE.Mesh(
    lathe(
      smoothOutline([
        [0.0068, 0.0822],
        [0.0078, 0.0836],
        [0.0079, 0.091],
        [0.0074, 0.0958],
        [0.0058, 0.0992],
        [0.0032, 0.1008],
        [0.0, 0.1012],
      ]),
      96,
    ),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#efe7d9"),
      roughness: 0.42,
      sheen: 0.3,
      sheenRoughness: 0.5,
      clearcoat: 0.25,
      clearcoatRoughness: 0.45,
    }),
  );
  bottle.add(bulb);

  // Label: printed paper on the front two-thirds of the body.
  const labelMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01615, 0.01615, 0.026, 128, 1, true, -Math.PI * 0.65, Math.PI * 1.3),
    new THREE.MeshPhysicalMaterial({ map: label(1024), roughness: 0.62, side: THREE.FrontSide }),
  );
  labelMesh.position.y = 0.024;
  // CylinderGeometry puts theta 0 on +z, so the label's centre faces +z.
  bottle.add(labelMesh);

  bottle.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return bottle;
}

/**
 * A drop of serum resting on a surface: a spherical cap meeting it at the
 * contact angle (radians), closed underneath, with its base at y = 0.
 * `radius` is the footprint's radius.
 */
export function buildDrop(material, radius, contact = 0.95) {
  const R = radius / Math.sin(contact);
  const cap = new THREE.SphereGeometry(R, 96, 48, 0, Math.PI * 2, 0, contact);
  cap.translate(0, -R * Math.cos(contact), 0);
  const base = new THREE.CircleGeometry(radius, 96);
  base.rotateX(Math.PI / 2);
  const drop = new THREE.Group();
  drop.add(new THREE.Mesh(cap, material), new THREE.Mesh(base, material));
  return drop;
}

export function buildPlinth() {
  const tex = travertine(3);
  tex.map.repeat.set(2, 1);
  tex.roughnessMap.repeat.set(2, 1);
  tex.normalMap.repeat.set(2, 1);
  const outline = smoothOutline(
    [
      [0.0, 0.0],
      [0.058, 0.0],
      [0.06, 0.002],
      [0.06, 0.036],
      [0.0585, 0.038],
      [0.0, 0.038],
    ],
    2,
  );
  const plinth = new THREE.Mesh(
    lathe(outline, 160),
    new THREE.MeshPhysicalMaterial({
      map: tex.map,
      roughnessMap: tex.roughnessMap,
      normalMap: tex.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.85,
    }),
  );
  plinth.name = "plinth";
  return plinth;
}

/** A river pebble: flattened, lopsided, its stone mottled and flecked. */
export function buildPebble(seed, size, tint = "#c8bca9") {
  const noise = makeNoise(seed, 64);
  const geometry = new THREE.SphereGeometry(size, 96, 64);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  const stretch = 1.15 + (seed % 3) * 0.12;
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const n = noise((v.x / size) * 1.6 + seed, (v.z / size) * 1.6 + (v.y / size) * 0.8 + seed, 3);
    v.multiplyScalar(0.78 + n * 0.44);
    v.x *= stretch;
    v.y *= 0.46;
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshPhysicalMaterial({ map: mottled(seed, tint), roughness: 0.62, clearcoat: 0.08, clearcoatRoughness: 0.6 }),
  );
}

/**
 * The bottle's carton: folding board with softened edges, its printed
 * panels laid on the faces (one material per mesh: the path tracer is given
 * no multi-material geometry). Its base sits at y = 0.
 */
export function buildCarton() {
  const w = 0.036;
  const h = 0.104;
  const group = new THREE.Group();
  const box = new THREE.Mesh(
    new RoundedBoxGeometry(w, h, w, 3, 0.0012),
    new THREE.MeshPhysicalMaterial({ color: "#efe7d8", roughness: 0.8, sheen: 0.15, sheenRoughness: 0.8 }),
  );
  box.position.y = h / 2;
  group.add(box);
  const print = carton(512);
  const panel = (map, x, z, turn) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w - 0.0024, h - 0.0024),
      new THREE.MeshPhysicalMaterial({ map, roughness: 0.78, sheen: 0.15, sheenRoughness: 0.8 }),
    );
    mesh.position.set(x, h / 2, z);
    mesh.rotation.y = turn;
    group.add(mesh);
  };
  const out = w / 2 + 0.00015;
  panel(print.front, 0, out, 0);
  panel(print.front, 0, -out, Math.PI);
  panel(print.side, out, 0, Math.PI / 2);
  panel(print.side, -out, 0, -Math.PI / 2);
  group.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return group;
}

/** A shallow saucer in glazed off-white ceramic. */
export function buildDish() {
  const outline = smoothOutline([
    [0.0, 0.0],
    [0.03, 0.0],
    [0.034, 0.004],
    [0.036, 0.009],
    [0.0342, 0.009],
    [0.0322, 0.0048],
    [0.0292, 0.0022],
    [0.0, 0.0022],
  ]);
  return new THREE.Mesh(
    lathe(outline, 128),
    new THREE.MeshPhysicalMaterial({ color: "#efe8dd", roughness: 0.28, clearcoat: 0.7, clearcoatRoughness: 0.12, side: THREE.DoubleSide }),
  );
}

/** The set: a seamless linen sweep on an oak tabletop edge. */
export function buildSet({ surface = "linen" } = {}) {
  const set = new THREE.Group();
  const cloth = linen(5);
  cloth.map.repeat.set(20, 20);
  cloth.normalMap.repeat.set(20, 20);
  const floorMaterial =
    surface === "oak"
      ? (() => {
          const wood = oak(9);
          wood.map.repeat.set(1.5, 1.5);
          wood.roughnessMap.repeat.set(1.5, 1.5);
          wood.normalMap.repeat.set(1.5, 1.5);
          return new THREE.MeshPhysicalMaterial({
            map: wood.map,
            roughnessMap: wood.roughnessMap,
            normalMap: wood.normalMap,
            normalScale: new THREE.Vector2(0.35, 0.35),
            roughness: 0.7,
            clearcoat: 0.25,
            clearcoatRoughness: 0.35,
          });
        })()
      : new THREE.MeshPhysicalMaterial({
          map: cloth.map,
          normalMap: cloth.normalMap,
          normalScale: new THREE.Vector2(0.35, 0.35),
          roughness: 0.95,
          sheen: 0.6,
          sheenRoughness: 0.8,
          sheenColor: new THREE.Color("#fff1dc"),
        });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  set.add(floor);

  // The sweep behind: a quarter cylinder rising into a wall.
  const sweepMaterial = new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide,
    map: cloth.map,
    normalMap: cloth.normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3),
    color: new THREE.Color("#f3e9da"),
    roughness: 0.95,
  });
  const radius = 0.35;
  const curve = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 3, 64, 1, true, Math.PI, Math.PI / 2),
    sweepMaterial,
  );
  curve.rotation.z = Math.PI / 2;
  curve.position.set(0, radius, -0.45);
  set.add(curve);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), sweepMaterial);
  wall.position.set(0, radius + 1, -0.45 - radius);
  set.add(wall);
  return set;
}

/**
 * A studio as an environment map, drawn procedurally: a warm grey room, a
 * large key softbox, a strip light behind for the glass edges and a soft
 * ceiling bounce. It lights the scene and is what the glass reflects.
 */
export function studioEnvironment(width = 1024, height = 512) {
  const data = new Float32Array(width * height * 4);
  const boxes = [
    // [azimuth°, elevation°, width°, height°, intensity, r, g, b]
    [-58, 18, 46, 34, 9.5, 1.0, 0.86, 0.66],
    [135, 12, 14, 56, 7.0, 1.0, 0.95, 0.88],
    [10, 78, 70, 20, 2.2, 1.0, 0.97, 0.92],
    [70, 8, 24, 20, 1.6, 1.0, 0.93, 0.84],
  ];
  const soft = (d, half, edge) => {
    const x = (Math.abs(d) - half) / edge;
    return x <= 0 ? 1 : x >= 1 ? 0 : 1 - x * x * (3 - 2 * x);
  };
  for (let y = 0; y < height; y++) {
    const elevation = 90 - (y / (height - 1)) * 180;
    for (let x = 0; x < width; x++) {
      const azimuth = (x / width) * 360 - 180;
      // Ambient: warm walls, a darker floor.
      const up = Math.max(0, Math.min(1, (elevation + 20) / 110));
      let r = 0.2 + up * 0.28;
      let g = 0.18 + up * 0.25;
      let b = 0.15 + up * 0.21;
      for (const [az, el, w, h, intensity, cr, cg, cb] of boxes) {
        let dAz = azimuth - az;
        dAz = ((dAz + 540) % 360) - 180;
        const k = soft(dAz, w / 2, 6) * soft(elevation - el, h / 2, 5);
        r += k * intensity * cr;
        g += k * intensity * cg;
        b += k * intensity * cb;
      }
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Studio light: the environment above plus a warm key and a rim as area lights. */
export function buildLights(renderer, scene) {
  scene.environment = studioEnvironment();
  scene.environmentIntensity = 0.45;
  scene.background = new THREE.Color("#e9dfd2");

  const key = new THREE.RectAreaLight(new THREE.Color("#ffdcaa"), 16, 0.5, 0.6);
  key.position.set(-0.55, 0.42, 0.35);
  key.lookAt(0, 0.05, 0);
  scene.add(key);

  const rim = new THREE.RectAreaLight(new THREE.Color("#fff4e6"), 12, 0.25, 0.7);
  rim.position.set(0.42, 0.3, -0.3);
  rim.lookAt(0, 0.06, 0);
  scene.add(rim);

  return { key, rim };
}

export { GOLD };
