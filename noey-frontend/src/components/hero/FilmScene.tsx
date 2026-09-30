"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * The hero's backdrop: film frames drifting in depth, their edges catching
 * the gold of the brand accent, leaning with the pointer. Loaded only on
 * capable desktops, after idle (HeroBackdrop decides); paused whenever it is
 * off screen or the tab is hidden. Every colour is read from the CSS tokens
 * at runtime and redrawn the moment the theme changes.
 */

interface Palette {
  gold: string;
  deep: string;
  film: string;
  light: string;
  dark: boolean;
}

function readPalette(): Palette {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const dark = css.getPropertyValue("color-scheme").includes("dark") || root.getAttribute("data-theme") === "dark";
  return {
    gold: token("--color-accent") || "#d9a441",
    deep: token("--color-accent-800") || "#5a3b0a",
    film: dark ? token("--color-neutral-900") || "#0e0d0c" : token("--color-surface") || "#eae9e9",
    light: token("--color-accent-300") || "#facb8d",
    dark,
  };
}

const FRAMES: ReadonlyArray<{ x: number; y: number; z: number; r: number; w: number; tall: boolean; speed: number }> = [
  { x: -4.6, y: 1.4, z: -3.2, r: -0.16, w: 1.9, tall: false, speed: 0.6 },
  { x: -2.7, y: -1.7, z: -5.5, r: 0.12, w: 1.4, tall: true, speed: 0.8 },
  { x: 4.4, y: 1.9, z: -4.4, r: 0.2, w: 1.7, tall: true, speed: 0.5 },
  { x: 3.1, y: -1.5, z: -2.6, r: -0.1, w: 2.1, tall: false, speed: 0.7 },
  { x: 0.4, y: 2.6, z: -7.5, r: 0.06, w: 2.4, tall: false, speed: 0.4 },
  { x: -6.2, y: -0.4, z: -8.2, r: 0.24, w: 1.8, tall: true, speed: 0.55 },
  { x: 6.6, y: -0.2, z: -9, r: -0.22, w: 2.2, tall: false, speed: 0.45 },
  { x: -0.9, y: -2.8, z: -6.6, r: -0.05, w: 1.6, tall: false, speed: 0.65 },
];

/** A film frame drawn on a 2D canvas: dark base, sprocket holes, a warm picture, a glowing gold rim. */
function drawFrame(palette: Palette, tall: boolean, seed: number): THREE.CanvasTexture {
  const width = tall ? 288 : 512;
  const height = tall ? 512 : 288;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const pad = 22;
  const radius = 18;

  context.clearRect(0, 0, width, height);
  context.save();
  context.shadowColor = palette.gold;
  context.shadowBlur = palette.dark ? 26 : 14;
  context.fillStyle = palette.film;
  context.globalAlpha = palette.dark ? 0.92 : 0.9;
  context.beginPath();
  context.roundRect(pad, pad, width - pad * 2, height - pad * 2, radius);
  context.fill();
  context.restore();

  // Sprocket holes along the long edges.
  context.fillStyle = palette.dark ? "rgba(243,242,242,0.10)" : "rgba(32,31,29,0.14)";
  const holes = tall ? 9 : 14;
  for (let index = 0; index < holes; index += 1) {
    const along = pad + 18 + (index * ((tall ? height : width) - pad * 2 - 36)) / (holes - 1);
    if (tall) {
      context.fillRect(pad + 8, along - 6, 12, 12);
      context.fillRect(width - pad - 20, along - 6, 12, 12);
    } else {
      context.fillRect(along - 7, pad + 8, 14, 10);
      context.fillRect(along - 7, height - pad - 18, 14, 10);
    }
  }

  // The picture: warm light on a surface, a little different each time.
  const inset = tall ? { x: pad + 32, y: pad + 20 } : { x: pad + 20, y: pad + 30 };
  const picture = { x: inset.x, y: inset.y, w: width - inset.x * 2, h: height - inset.y * 2 };
  const gradient = context.createLinearGradient(picture.x, picture.y, picture.x + picture.w * 0.3, picture.y + picture.h);
  gradient.addColorStop(0, palette.light);
  gradient.addColorStop(0.55, palette.gold);
  gradient.addColorStop(1, palette.deep);
  context.globalAlpha = palette.dark ? 0.55 : 0.5;
  context.fillStyle = gradient;
  context.beginPath();
  context.roundRect(picture.x, picture.y, picture.w, picture.h, 8);
  context.fill();
  const glow = context.createRadialGradient(
    picture.x + picture.w * (0.3 + (seed % 3) * 0.2),
    picture.y + picture.h * 0.35,
    4,
    picture.x + picture.w * 0.5,
    picture.y + picture.h * 0.5,
    picture.w * 0.8,
  );
  glow.addColorStop(0, "rgba(255,243,228,0.55)");
  glow.addColorStop(1, "rgba(255,243,228,0)");
  context.globalAlpha = 1;
  context.fillStyle = glow;
  context.fill();

  // The gold rim.
  context.globalAlpha = 1;
  context.lineWidth = 3;
  context.strokeStyle = palette.gold;
  context.shadowColor = palette.gold;
  context.shadowBlur = palette.dark ? 18 : 8;
  context.beginPath();
  context.roundRect(pad, pad, width - pad * 2, height - pad * 2, radius);
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function Frames({ palette }: { palette: Palette }) {
  const group = useRef<THREE.Group>(null);
  const meshes = useRef<Array<THREE.Mesh | null>>([]);
  const { pointer } = useThree();
  const textures = useMemo(() => FRAMES.map((frame, index) => drawFrame(palette, frame.tall, index)), [palette]);

  useEffect(() => () => textures.forEach((texture) => texture.dispose()), [textures]);

  useFrame((state, delta) => {
    const time = state.clock.elapsedTime;
    const g = group.current;
    if (g) {
      g.rotation.y += (pointer.x * 0.16 - g.rotation.y) * Math.min(1, delta * 2.2);
      g.rotation.x += (-pointer.y * 0.1 - g.rotation.x) * Math.min(1, delta * 2.2);
      g.position.x += (pointer.x * 0.35 - g.position.x) * Math.min(1, delta * 1.6);
    }
    FRAMES.forEach((frame, index) => {
      const mesh = meshes.current[index];
      if (!mesh) return;
      mesh.position.y = frame.y + Math.sin(time * frame.speed + index) * 0.18;
      mesh.rotation.z = frame.r + Math.sin(time * frame.speed * 0.6 + index * 2) * 0.05;
      mesh.rotation.y = Math.sin(time * frame.speed * 0.4 + index) * 0.18;
    });
  });

  return (
    <group ref={group}>
      {FRAMES.map((frame, index) => {
        const height = frame.tall ? frame.w * (512 / 288) : frame.w * (288 / 512);
        return (
          <mesh
            key={index}
            ref={(mesh) => {
              meshes.current[index] = mesh;
            }}
            position={[frame.x, frame.y, frame.z]}
            rotation={[0, 0, frame.r]}
          >
            <planeGeometry args={[frame.w, height]} />
            <meshBasicMaterial
              map={textures[index]}
              transparent
              depthWrite={false}
              opacity={0.9}
              blending={palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export default function FilmScene({ onReady }: { onReady?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [running, setRunning] = useState(true);

  // Colours come from the tokens, and follow every theme switch.
  useEffect(() => {
    const read = () => setPalette(readPalette());
    const frame = window.requestAnimationFrame(read);
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      media.removeEventListener("change", read);
    };
  }, []);

  // Render only while visible and the tab is in front.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let visible = true;
    const apply = () => setRunning(visible && document.visibilityState === "visible");
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      apply();
    });
    io.observe(element);
    document.addEventListener("visibilitychange", apply);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);

  return (
    <div ref={host} className="film-scene" aria-hidden="true">
      {palette ? (
        <Canvas
          dpr={[1, 1.5]}
          frameloop={running ? "always" : "never"}
          camera={{ position: [0, 0, 6], fov: 42 }}
          gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
          onCreated={() => onReady?.()}
          eventSource={typeof document !== "undefined" ? document.documentElement : undefined}
          eventPrefix="client"
        >
          <Frames palette={palette} />
        </Canvas>
      ) : null}
    </div>
  );
}
