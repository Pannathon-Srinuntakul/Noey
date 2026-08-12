---
name: frontend-3d
description: The 3D-data-world UI design language for services/web (React + React Three Fiber). Load before any frontend/UI work so the look stays distinctive and consistent, not a generic dashboard.
---

# Frontend 3D Skill — the "data world" design language

Scope: `frontend/` (top-level, all TypeScript). React + Vite + TypeScript + **React
Three Fiber (R3F)** + drei + Tailwind. The chosen direction is an immersive **3D data
world** — distinctive and game-like, but with **deliberately simple UX**.

## Core metaphor

Each product / creator is a **sphere** in 3D space:
- **size = GMV**
- **color = commission rate**
- hover → label; click → floating drill-in card (units, commission, per-product breakdown)
- toggle the dimension shown: products ↔ creators ↔ market-trend

## Hard design rules (keep it distinctive AND simple)

1. **Camera = orbit + zoom only** (drei `OrbitControls`, no free-fly). Simple navigation.
2. **2D overlays for interaction-heavy UI.** Metric HUD bar (GMV/commission/units),
   filters, chat panel, prompt-cron manager are flat 2D over the scene — do NOT force
   them into 3D. This is what keeps UX simple despite the 3D centerpiece.
3. **Always provide the 2D-table fallback.** A toggle to a plain table view so all data
   is usable on low-end / WebGL-unsupported devices and for quick scanning.
4. **Performance budget** (non-negotiable):
   - `instancedMesh` for the sphere field.
   - Cap on-screen object count; aggregate / LOD beyond the cap.
   - Lazy-load drill-in detail on click.
   - Graceful degrade to the 2D table when WebGL is unavailable or the device is weak.

## Structure

```
frontend/src/
  scene/
    DataWorld.tsx     # R3F canvas, OrbitControls, lighting
    SphereField.tsx   # instancedMesh of entities (size=GMV, color=commission)
    DrillCard.tsx     # drei Html floating card on click
  hud/
    MetricBar.tsx     # top GMV/commission/units
    Filters.tsx
    ChatPanel.tsx     # streams from /chat
    PromptCron.tsx    # free-text prompt + schedule (presets or raw cron) + run history
  fallback/
    TableView.tsx     # 2D table fallback + toggle
  api/                # typed client for services/api
```

## Visual language

- Encodings are consistent everywhere: sphere = entity, size = GMV, color = commission.
- Define palette, typography, HUD panel style, and motion/easing once and reuse — do not
  drift into generic dashboard styling.
- Tailwind for 2D overlays; keep the HUD minimal and high-contrast over the 3D scene.
- Recharts only for small flat charts inside drill-in cards.
