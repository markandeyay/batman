import { Easing, interpolate, spring } from "remotion";
import { FPS } from "../timing";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 -> 1 spring that starts at frame `start`. */
export const pop = (frame: number, start: number, damping = 15, stiffness = 170) =>
  spring({ frame: frame - start, fps: FPS, config: { damping, stiffness, mass: 0.8 } });

/** Eased 0 -> 1 ramp over `dur` frames starting at `start`. */
export const ramp = (frame: number, start: number, dur = 12, ease = Easing.out(Easing.cubic)) =>
  interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: ease });

export const fadeOut = (frame: number, start: number, dur = 10) => 1 - ramp(frame, start, dur, Easing.in(Easing.cubic));

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
