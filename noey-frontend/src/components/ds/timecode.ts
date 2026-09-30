/**
 * Timecodes are decoration on this site (section labels, the scroll ruler,
 * the mockups) — never a measurement of anything. 25 fps, `HH:MM:SS:FF`.
 */
export const FPS = 25;

export function formatTimecode(seconds: number): string {
  const whole = Math.max(0, seconds);
  const frames = Math.floor((whole % 1) * FPS);
  const s = Math.floor(whole) % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return [h, m, s, frames].map((n) => String(n).padStart(2, "0")).join(":");
}

/** A stable label for the n-th section of a page: 00:00:00:00, 00:00:14:05, … */
export function sectionTimecode(index: number): string {
  return formatTimecode(index * 14.2);
}

/**
 * Deterministic pseudo-random numbers (mulberry32), so a waveform drawn on
 * the server matches the one hydrated on the client.
 */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bar heights (0.12–1) for a speech-like waveform: phrases with pauses between. */
export function waveform(count: number, seed = 7): number[] {
  const random = seeded(seed);
  const bars: number[] = [];
  let phrase = 0;
  for (let index = 0; index < count; index += 1) {
    if (phrase <= 0) phrase = 6 + Math.floor(random() * 14);
    phrase -= 1;
    const pause = phrase < 2 && random() > 0.35;
    const envelope = Math.sin(((phrase % 9) / 9) * Math.PI) * 0.55 + 0.35;
    bars.push(pause ? 0.08 + random() * 0.08 : Math.min(1, Math.max(0.14, envelope * (0.55 + random() * 0.6))));
  }
  return bars;
}
