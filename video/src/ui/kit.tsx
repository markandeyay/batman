import React from "react";
import { AbsoluteFill, Html5Audio, interpolate, random, Sequence, staticFile, useCurrentFrame } from "remotion";
import { C, display, text } from "../theme";
import { clamp, fadeOut, pop, ramp } from "./anim";

/** Headline whose words rise into place one after another. */
export const Words: React.FC<{
  text: string;
  at: number;
  size?: number;
  color?: string;
  weight?: number;
  stagger?: number;
  font?: string;
  style?: React.CSSProperties;
  highlight?: string[];
  highlightColor?: string;
}> = ({ text: t, at, size = 84, color = C.ink, weight = 800, stagger = 2.2, font = display, style, highlight = [], highlightColor = C.indigo }) => {
  const frame = useCurrentFrame();
  const words = t.split(" ");
  return (
    <div style={{ fontFamily: font, fontWeight: weight, fontSize: size, lineHeight: 1.06, letterSpacing: "-0.02em", color, ...style }}>
      {words.map((w, i) => {
        const p = pop(frame, at + i * stagger, 16, 150);
        const norm = (x: string) => x.replace(/[.,?!]/g, "").toLowerCase();
        const hl = highlight.map(norm).includes(norm(w));
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: "0.08em", marginBottom: "-0.08em" }}>
            <span
              style={{
                display: "inline-block",
                transform: `translateY(${(1 - p) * 105}%)`,
                color: hl ? highlightColor : undefined,
              }}
            >
              {w}
              {i < words.length - 1 ? " " : ""}
            </span>
          </span>
        );
      })}
    </div>
  );
};

/** Small uppercase label above a headline. */
export const Kicker: React.FC<{ children: React.ReactNode; at: number; color?: string; bg?: string }> = ({ children, at, color = C.indigo, bg = C.lilac }) => {
  const frame = useCurrentFrame();
  const p = pop(frame, at);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        fontFamily: text,
        fontWeight: 700,
        fontSize: 22,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color,
        background: bg,
        padding: "9px 18px",
        borderRadius: 999,
        opacity: p,
        transform: `translateY(${(1 - p) * 16}px)`,
      }}
    >
      {children}
    </div>
  );
};

export const Body: React.FC<{ children: React.ReactNode; at: number; size?: number; color?: string; style?: React.CSSProperties }> = ({
  children,
  at,
  size = 32,
  color = C.slate,
  style,
}) => {
  const frame = useCurrentFrame();
  const p = ramp(frame, at, 14);
  return (
    <div style={{ fontFamily: text, fontSize: size, lineHeight: 1.4, color, opacity: p, transform: `translateY(${(1 - p) * 14}px)`, ...style }}>{children}</div>
  );
};

/** Pop-in wrapper. */
export const Pop: React.FC<{ at: number; children: React.ReactNode; from?: number; y?: number; x?: number; style?: React.CSSProperties; out?: number }> = ({
  at,
  children,
  from = 0.85,
  y = 24,
  x = 0,
  style,
  out,
}) => {
  const frame = useCurrentFrame();
  const p = pop(frame, at);
  const o = out !== undefined ? fadeOut(frame, out, 10) : 1;
  return (
    <div
      style={{
        opacity: Math.min(1, p * 1.4) * o,
        transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px) scale(${from + (1 - from) * p})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Light brand backdrop: Moonmilk with two slow glows. */
export const LightBg: React.FC = () => {
  const frame = useCurrentFrame();
  const a = Math.sin(frame / 90) * 60;
  const b = Math.cos(frame / 110) * 50;
  return (
    <AbsoluteFill style={{ background: C.moon, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: 1100,
          height: 1100,
          left: -260 + a,
          top: -420 + b,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(228,224,255,0.95) 0%, rgba(228,224,255,0) 68%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 900,
          height: 900,
          right: -240 - a,
          bottom: -420 - b,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,164,126,0.22) 0%, rgba(255,164,126,0) 66%)",
        }}
      />
    </AbsoluteFill>
  );
};

/** Night backdrop with a few twinkling stars. */
export const NightBg: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 70% 20%, ${C.nightHi} 0%, ${C.night} 62%)`, overflow: "hidden" }}>
      {new Array(70).fill(0).map((_, i) => {
        const x = random(`x${i}`) * 1920;
        const y = random(`y${i}`) * 1080;
        const s = 1 + random(`s${i}`) * 2.2;
        const tw = 0.25 + 0.75 * Math.abs(Math.sin(frame / (25 + random(`t${i}`) * 40) + i));
        return <div key={i} style={{ position: "absolute", left: x, top: y, width: s, height: s, borderRadius: s, background: "white", opacity: tw * 0.7 }} />;
      })}
    </AbsoluteFill>
  );
};

/** Enter/exit motion shared by every scene. */
export const SceneWrap: React.FC<{ frames: number; children: React.ReactNode }> = ({ frames, children }) => {
  const frame = useCurrentFrame();
  const inP = ramp(frame, 0, 10);
  const outP = interpolate(frame, [frames - 8, frames], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ opacity: Math.min(inP, outP), transform: `translateY(${(1 - inP) * 18}px) scale(${0.985 + 0.015 * outP})` }}>
      {children}
    </AbsoluteFill>
  );
};

export type Sfx = { at: number; kind: "send" | "receive" | "alert" };

export const Sounds: React.FC<{ list: Sfx[] }> = ({ list }) => (
  <>
    {list.map((s, i) => (
      <Sequence key={i} from={s.at} durationInFrames={30} layout="none">
        <Html5Audio src={staticFile(`sfx/${s.kind}.wav`)} volume={s.kind === "alert" ? 0.32 : s.kind === "send" ? 0.22 : 0.18} />
      </Sequence>
    ))}
  </>
);

/** Rounded white card. */
export const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      background: "white",
      borderRadius: 28,
      boxShadow: "0 24px 60px -24px rgba(28,26,51,0.28), 0 0 0 1px rgba(28,26,51,0.06)",
      padding: 28,
      ...style,
    }}
  >
    {children}
  </div>
);
