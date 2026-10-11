import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, display, text, ui } from "../theme";
import { at } from "../timing";
import { clamp, pop, ramp } from "../ui/anim";
import { Kicker, Pop, Words } from "../ui/kit";

// ---------- S11: AI understands, rules decide ----------
const Node: React.FC<{ title: string; sub: string; on: number; color?: string; w?: number; icon?: React.ReactNode }> = ({
  title,
  sub,
  on,
  color = C.indigo,
  w = 300,
  icon,
}) => (
  <div
    style={{
      width: w,
      flexShrink: 0,
      background: "white",
      borderRadius: 26,
      padding: "24px 24px",
      boxShadow: on > 0 ? `0 0 0 ${4 * on}px ${color}, 0 24px 50px -22px rgba(28,26,51,0.35)` : "0 16px 40px -22px rgba(28,26,51,0.25), 0 0 0 1px rgba(28,26,51,0.07)",
      transform: `scale(${1 + 0.04 * on})`,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {icon}
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 32, color: C.ink, letterSpacing: "-0.01em" }}>{title}</div>
    </div>
    <div style={{ fontFamily: text, fontSize: 22, color: C.slate, marginTop: 8, lineHeight: 1.35 }}>{sub}</div>
  </div>
);

const Arrow: React.FC<{ w?: number }> = ({ w = 56 }) => (
  <svg width={w} height="30" viewBox={`0 0 ${w} 30`} style={{ flexShrink: 0 }}>
    <path d={`M4 15 H${w - 8}`} stroke={C.slate} strokeWidth={4} strokeLinecap="round" />
    <path d={`M${w - 18} 6 L${w - 6} 15 L${w - 18} 24`} stroke={C.slate} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Row geometry (px): input, arrow, code words, arrow, Claude, arrow, rules, arrow, outcome.
const ROW = [210, 50, 290, 50, 300, 50, 300, 50, 210];
const GAP = 10;
const ROW_W = ROW.reduce((a, b) => a + b, 0) + GAP * (ROW.length - 1);
const ROW_X = (1920 - ROW_W) / 2;
const centerOf = (i: number) => ROW_X + ROW.slice(0, i).reduce((a, b) => a + b, 0) + GAP * i + ROW[i]! / 2;
const ROW_TOP = 400;

export const S11: React.FC = () => {
  const frame = useCurrentFrame();
  const claude = ramp(frame, at(0.2), 10) * (1 - 0.6 * ramp(frame, at(4.3), 10));
  const never = pop(frame, at(1.96), 13, 160);
  const rules = ramp(frame, at(4.44), 10) * (1 - 0.5 * ramp(frame, at(6.9), 10));
  const cw = ramp(frame, at(6.96), 10);
  const arc = interpolate(frame, [at(7.2), at(8.3)], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) });
  const backup = pop(frame, at(8.2), 13, 170);
  const isAlert = frame > at(6.85);
  const stats = [
    { n: "1,189", l: "automated tests" },
    { n: "98.7%", l: "reply accuracy" },
    { n: "0", l: "distress replies read as fine" },
    { n: "100%", l: "code word recall" },
  ];
  const sparkle = (
    <svg width="34" height="34" viewBox="0 0 34 34">
      <path d="M17 2 C18.5 11 23 15.5 32 17 C23 18.5 18.5 23 17 32 C15.5 23 11 18.5 2 17 C11 15.5 15.5 11 17 2 Z" fill="#D97757" />
    </svg>
  );
  const x1 = centerOf(2);
  const x2 = centerOf(8);
  const y = ROW_TOP + 6;
  const arcPath = `M${x1} ${y} C ${x1 + 220} ${y - 120}, ${x2 - 220} ${y - 120}, ${x2} ${y}`;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 80, width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Kicker at={0}>Built to be trusted</Kicker>
        <div style={{ marginTop: 22 }}>
          <Words text="AI understands. Rules decide." at={at(0)} size={86} highlight={["Rules", "decide."]} />
        </div>
      </div>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <path d={arcPath} fill="none" stroke={C.red} strokeWidth={5} strokeLinecap="round" strokeDasharray="1700" strokeDashoffset={1700 * (1 - arc)} opacity={cw} />
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, top: y - 118, textAlign: "center", opacity: arc }}>
        <span
          style={{
            background: "white",
            color: C.red,
            fontFamily: text,
            fontWeight: 700,
            fontSize: 24,
            padding: "10px 20px",
            borderRadius: 999,
            boxShadow: "0 10px 24px -12px rgba(229,72,77,0.6)",
          }}
        >
          Alert word skips the AI and goes straight to your backup
        </span>
      </div>
      <div style={{ position: "absolute", top: ROW_TOP + 30, left: ROW_X, display: "flex", alignItems: "center", gap: GAP }}>
        <div style={{ width: ROW[0], flexShrink: 0, display: "flex", justifyContent: "center" }}>
          <div style={{ background: C.blue, color: "white", fontFamily: ui, fontSize: 24, padding: "12px 20px", borderRadius: 24, textAlign: "center", whiteSpace: "nowrap" }}>
            {isAlert ? "blue moon" : "all good, thx!"}
          </div>
        </div>
        <Arrow w={ROW[1]} />
        <Node title="Code words" sub="Exact match, checked first. Never sent to AI." on={cw} color={C.glow} w={ROW[2]} />
        <Arrow w={ROW[3]} />
        <div style={{ position: "relative", flexShrink: 0 }}>
          <Node title="Claude" sub="Reads plans and replies like a person would." on={claude} color="#D97757" w={ROW[4]} icon={sparkle} />
          <div style={{ position: "absolute", left: -60, right: -60, top: 214, textAlign: "center", opacity: never, transform: `translateY(${(1 - never) * 14}px)` }}>
            <span
              style={{
                background: "#FDE8E8",
                color: C.red,
                fontFamily: text,
                fontWeight: 700,
                fontSize: 24,
                padding: "10px 18px",
                borderRadius: 999,
                whiteSpace: "nowrap",
              }}
            >
              ✕ Never decides to escalate
            </span>
          </div>
        </div>
        <Arrow w={ROW[5]} />
        <Node title="Safety rules" sub="Fixed triggers and timers decide every alert." on={rules} color={C.green} w={ROW[6]} />
        <Arrow w={ROW[7]} />
        <div style={{ width: ROW[8], flexShrink: 0, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              background: isAlert ? C.red : C.lilac,
              color: isAlert ? "white" : C.indigo,
              fontFamily: text,
              fontWeight: 700,
              fontSize: 24,
              padding: "14px 20px",
              borderRadius: 20,
              textAlign: "center",
              transform: `scale(${1 + 0.08 * backup * (isAlert ? 1 : 0)})`,
            }}
          >
            {isAlert ? "Backup alerted" : "Fixed check-in text"}
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", top: 790, width: "100%", display: "flex", justifyContent: "center", gap: 30 }}>
        {stats.map((s, i) => (
          <Pop key={s.l} at={at(8.6) + i * 5} y={26}>
            <div
              style={{
                width: 330,
                textAlign: "center",
                background: "rgba(255,255,255,0.75)",
                borderRadius: 24,
                padding: "22px 10px",
                boxShadow: "0 0 0 1px rgba(28,26,51,0.06)",
              }}
            >
              <div style={{ fontFamily: display, fontWeight: 800, fontSize: 60, color: C.indigo, letterSpacing: "-0.02em" }}>{s.n}</div>
              <div style={{ fontFamily: text, fontSize: 23, color: C.slate }}>{s.l}</div>
            </div>
          </Pop>
        ))}
      </div>
    </AbsoluteFill>
  );
};
