import React from "react";
import { interpolate } from "remotion";
import { C, text } from "../theme";

/** The Lookout bubble mark (brand/mark.mjs), with blinking porch-light eyes. */
export const Logo: React.FC<{ size: number; frame: number; blinkAt?: number[]; color?: string; eye?: string }> = ({
  size,
  frame,
  blinkAt = [],
  color = C.indigo,
  eye = C.glow,
}) => {
  let s = 1;
  for (const b of blinkAt) {
    const k = interpolate(frame, [b, b + 3, b + 6], [1, 0.1, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    s = Math.min(s, k);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 256 256">
      <g transform="translate(0 -5)">
        <g fill={color} stroke={color} strokeLinejoin="round">
          <path d="M56 136 C50 100 56 62 72 36 C90 52 106 72 116 94 L100 136 Z" strokeWidth={12} />
          <g transform="translate(256 0) scale(-1 1)">
            <path d="M56 136 C50 100 56 62 72 36 C90 52 106 72 116 94 L100 136 Z" strokeWidth={12} />
          </g>
          <path d="M62 128 C46 114 30 108 14 108 C18 124 18 136 16 150 Q36 140 58 154 Z" strokeWidth={8} />
          <g transform="translate(256 0) scale(-1 1)">
            <path d="M62 128 C46 114 30 108 14 108 C18 124 18 136 16 150 Q36 140 58 154 Z" strokeWidth={8} />
          </g>
        </g>
        <rect x={46} y={88} width={164} height={118} rx={59} fill={color} />
        <path d="M82 192 C80 212 70 224 52 232 C80 234 104 224 120 206 Z" fill={color} />
        <ellipse cx={107} cy={142} rx={12} ry={16 * s} fill={eye} />
        <ellipse cx={149} cy={142} rx={12} ry={16 * s} fill={eye} />
        <path d="M118 172 Q128 180 138 172" fill="none" stroke={eye} strokeWidth={7} strokeLinecap="round" />
      </g>
    </svg>
  );
};

export const Avatar: React.FC<{ size: number; kind: "batman" | "initials"; initials?: string; tint?: string; frame?: number }> = ({
  size,
  kind,
  initials,
  tint,
  frame = 0,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size,
      background: kind === "batman" ? C.lilac : (tint ?? "linear-gradient(180deg,#A9AEBB,#868B98)"),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      color: "white",
      fontWeight: 700,
      fontFamily: text,
      fontSize: size * 0.4,
    }}
  >
    {kind === "batman" ? <Logo size={size * 0.86} frame={frame} /> : initials}
  </div>
);
