import { SAMPLE_SCENES } from "../sample";

/**
 * The editor's own arithmetic and strings for the sample cut, shared by the
 * server-drawn mock-ups and the script that moves them (EditorLive).
 */

/** lib/timelineMath: fmtTime, fmtTimeTenths. */
export const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
export const fmtTimeTenths = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = Math.floor(s);
  return `${m}:${String(whole).padStart(2, "0")}.${Math.floor((s - whole) * 10)}`;
};

/** The scene playing at `t` (the last one past the end). */
export const sceneAt = (t: number) => {
  const index = SAMPLE_SCENES.findIndex((scene) => t >= scene.start && t < scene.start + scene.seconds);
  return index === -1 ? SAMPLE_SCENES.length - 1 : index;
};

/** The inspector's line under "ฉาก N" (SelectedSceneHeader). */
export const sceneMeta = (index: number) => {
  const scene = SAMPLE_SCENES[index];
  return `จาก ${SAMPLE_SCENES.length} · ยาว ${scene.seconds.toFixed(2)} วิ · เริ่มที่ ${fmtTimeTenths(scene.sourceIn)} ในคลิป ${String.fromCharCode(65 + scene.clip)}`;
};

/** The scenes that show voiceover line `line` — its angles. */
export const lineScenes = (line: number) => SAMPLE_SCENES.map((scene, index) => ({ scene, index })).filter(({ scene }) => scene.line === line);

/** ScriptTab's label over the line's textarea. */
export const lineLabel = (index: number) => {
  const line = SAMPLE_SCENES[index].line;
  const angles = lineScenes(line).length;
  return `ประโยคพากย์ที่ ${line}` + (angles > 1 ? ` — แก้ที่นี่ เปลี่ยนทั้ง ${angles} มุม` : "");
};
