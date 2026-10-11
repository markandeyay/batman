// Scene lengths follow the voiceover clips (ffprobe durations of public/vo/sNN.mp3).
export const FPS = 30;
export const VO = [8.359, 7.236, 5.642, 9.326, 8.046, 7.967, 6.269, 8.908, 13.009, 12.434, 9.953, 9.091];
const LEAD_S = 0.35;
// Extra hold after each line so the visuals can land before the next scene.
const TAIL_S = [0.45, 0.55, 0.7, 1.1, 0.6, 0.65, 0.6, 0.7, 0.9, 1.0, 1.7, 2.6];

export const LEAD = Math.round(LEAD_S * FPS);

export const SCENES = (() => {
  let start = 0;
  return VO.map((d, i) => {
    const frames = Math.round((LEAD_S + d + TAIL_S[i]!) * FPS);
    const s = { index: i, start, frames };
    start += frames;
    return s;
  });
})();

export const TOTAL = SCENES.reduce((n, s) => n + s.frames, 0);

/** Frame (inside a scene) at which the voiceover reaches `sec` seconds into its clip. */
export const at = (sec: number) => LEAD + Math.round(sec * FPS);
