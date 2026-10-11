import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, display, text, ui } from "../theme";
import { at } from "../timing";
import { clamp, fadeOut, pop, ramp } from "../ui/anim";
import { Logo } from "../ui/Logo";
import { Body, Pop, Sounds, Words } from "../ui/kit";

// ---------- shared lock screen ----------
const Notif: React.FC<{ app: string; title: string; body: string; at: number; icon: React.ReactNode }> = ({ app, title, body, at: a, icon }) => {
  const frame = useCurrentFrame();
  const p = pop(frame, a, 15, 170);
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.16)",
        backdropFilter: "blur(20px)",
        borderRadius: 24,
        padding: "14px 16px",
        display: "flex",
        gap: 12,
        color: "white",
        fontFamily: ui,
        opacity: Math.min(1, p * 1.5),
        transform: `translateY(${(1 - p) * -30}px) scale(${0.92 + 0.08 * p})`,
        marginBottom: 10,
      }}
    >
      <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", ...{} }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, opacity: 0.75 }}>
          <span>{app}</span>
          <span>now</span>
        </div>
        <div style={{ fontWeight: 700, fontSize: 17, marginTop: 1 }}>{title}</div>
        <div style={{ fontSize: 17, lineHeight: 1.3 }}>{body}</div>
      </div>
    </div>
  );
};

const AppIcon: React.FC<{ bg: string; children?: React.ReactNode }> = ({ bg, children }) => (
  <div style={{ width: 40, height: 40, borderRadius: 10, background: bg, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
);

const Heart = () => (
  <svg width="22" height="22" viewBox="0 0 24 24">
    <path d="M12 21 C5 15 2 12 2 8 A5 5 0 0 1 12 6 A5 5 0 0 1 22 8 C22 12 19 15 12 21 Z" fill="white" />
  </svg>
);
const Chat = () => (
  <svg width="24" height="24" viewBox="0 0 24 24">
    <path d="M12 3 C6.5 3 2 6.6 2 11 c0 2.4 1.3 4.5 3.4 6 L4.5 21 l4.3-2.4 c1 .3 2.1.4 3.2.4 5.5 0 10-3.6 10-8 S17.5 3 12 3 Z" fill="white" />
  </svg>
);

const LockScreen: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        width: 416,
        height: 870,
        borderRadius: 68,
        background: "linear-gradient(145deg,#2E2C3A,#121118)",
        padding: 13,
        boxShadow: "0 40px 90px -10px rgba(0,0,0,0.6), 0 0 0 2px #4A4858 inset",
      }}
    >
      <div
        style={{
          width: 390,
          height: 844,
          borderRadius: 56,
          overflow: "hidden",
          position: "relative",
          background: "linear-gradient(170deg,#3B3480 0%,#1E1A45 55%,#0F0D22 100%)",
          padding: "70px 14px 0",
        }}
      >
        <div style={{ position: "absolute", top: 11, left: 133, width: 124, height: 36, borderRadius: 20, background: "#000" }} />
        <div style={{ textAlign: "center", color: "white", fontFamily: ui }}>
          <div style={{ fontSize: 20, opacity: 0.85 }}>Saturday, October 11</div>
          <div style={{ fontFamily: display, fontWeight: 600, fontSize: 104, lineHeight: 1, marginTop: 4, letterSpacing: "-0.02em" }}>6:52</div>
        </div>
        <div style={{ marginTop: 300 }}>
          <Notif app="DATING APP" title="Sam" body="see you at 7! blue bottle on market 😊" at={at(0.9)} icon={<AppIcon bg="#E8457A"><Heart /></AppIcon>} />
          <Notif app="MESSAGES" title="the girls 💜" body="have fun!! text us after" at={at(3.95)} icon={<AppIcon bg="#34C759"><Chat /></AppIcon>} />
        </div>
        <div style={{ position: "absolute", bottom: 8, left: 128, width: 134, height: 5, borderRadius: 5, background: "white", opacity: 0.8 }} />
        <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${0.0 + 0.0 * frame})` }} />
      </div>
    </div>
  );
};

// ---------- S01: the hook ----------
export const S01: React.FC = () => {
  const frame = useCurrentFrame();
  const outA = fadeOut(frame, at(5.45), 10);
  const pin = pop(frame, at(6.2), 12, 120);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 150, top: 300, width: 900, opacity: outA }}>
        <Words text="Tonight." at={at(0)} size={150} color={C.moon} />
        <Body at={at(0.8)} size={40} color="rgba(247,246,255,0.78)" style={{ marginTop: 26, maxWidth: 760 }}>
          You're meeting someone from a dating app for the first time.
        </Body>
        <Body at={at(3.95)} size={40} color="rgba(247,246,255,0.78)" style={{ marginTop: 18 }}>
          Your friends think it'll be fine.
        </Body>
      </div>
      <div style={{ position: "absolute", left: 150, top: 320, width: 900 }}>
        <Words text="But nobody actually knows where you are." at={at(5.73)} size={100} color={C.moon} highlight={["where", "you", "are"]} highlightColor={C.glow} />
        <div style={{ marginTop: 40, display: "flex", alignItems: "center", gap: 18, opacity: pin, transform: `scale(${0.6 + 0.4 * pin})`, transformOrigin: "left center" }}>
          <svg width="56" height="70" viewBox="0 0 56 70">
            <path d="M28 68 C28 68 4 42 4 26 A24 24 0 0 1 52 26 C52 42 28 68 28 68 Z" fill="none" stroke={C.glow} strokeWidth={4} strokeDasharray="8 7" />
            <text x="28" y="36" textAnchor="middle" fill={C.glow} fontFamily={display} fontWeight={800} fontSize="26">?</text>
          </svg>
          <span style={{ fontFamily: text, fontSize: 30, color: "rgba(247,246,255,0.7)" }}>Location: unknown</span>
        </div>
      </div>
      <div style={{ position: "absolute", right: 210, top: 105 }}>
        <Pop at={0} y={60} from={0.94}>
          <LockScreen />
        </Pop>
      </div>
      <Sounds list={[{ at: at(0.9), kind: "receive" }, { at: at(3.95), kind: "receive" }]} />
    </AbsoluteFill>
  );
};

// ---------- S02: why safety apps fail ----------
export const S02: React.FC = () => {
  const frame = useCurrentFrame();
  const hold = interpolate(frame, [at(4.3), at(6.0)], [0, 1], clamp);
  const ripple = (frame % 40) / 40;
  const shake = frame > at(5.4) && frame < at(5.9) ? Math.sin(frame * 2.4) * 6 : 0;
  const steps = [
    { t: "Unlock your phone", a: at(3.0) },
    { t: "Find the safety app", a: at(3.6) },
    { t: "Hold SOS for 3 seconds", a: at(4.2) },
  ];
  const tag = pop(frame, at(5.45), 12, 160);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 150, top: 230, width: 880 }}>
        <Words text="Safety apps only work if you open them." at={at(0)} size={92} color={C.moon} highlight={["open"]} highlightColor={C.glow} />
        <div style={{ marginTop: 50, display: "flex", flexDirection: "column", gap: 16 }}>
          {steps.map((s, i) => (
            <Pop key={i} at={s.a} x={-30} y={0} from={1}>
              <div style={{ display: "flex", alignItems: "center", gap: 18, fontFamily: text, fontSize: 34, color: "rgba(247,246,255,0.85)" }}>
                <span
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 46,
                    border: "2px solid rgba(247,246,255,0.35)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 22,
                    fontWeight: 700,
                  }}
                >
                  {i + 1}
                </span>
                {s.t}
              </div>
            </Pop>
          ))}
        </div>
        <div
          style={{
            marginTop: 40,
            display: "inline-block",
            fontFamily: display,
            fontWeight: 800,
            fontSize: 46,
            color: C.night,
            background: C.glow,
            padding: "10px 24px",
            borderRadius: 16,
            opacity: tag,
            transform: `rotate(${-2 * tag}deg) scale(${0.7 + 0.3 * tag})`,
          }}
        >
          ...in front of a stranger?
        </div>
      </div>
      <div style={{ position: "absolute", right: 210, top: 105, transform: `translateX(${shake}px)` }}>
        <Pop at={0} y={50} from={0.95}>
          <div
            style={{
              width: 416,
              height: 870,
              borderRadius: 68,
              background: "linear-gradient(145deg,#2E2C3A,#121118)",
              padding: 13,
              boxShadow: "0 40px 90px -10px rgba(0,0,0,0.6), 0 0 0 2px #4A4858 inset",
            }}
          >
            <div style={{ width: 390, height: 844, borderRadius: 56, overflow: "hidden", position: "relative", background: "#17151F", fontFamily: ui, color: "white" }}>
              <div style={{ position: "absolute", top: 11, left: 133, width: 124, height: 36, borderRadius: 20, background: "#000" }} />
              <div style={{ textAlign: "center", marginTop: 110, fontSize: 24, fontWeight: 700, opacity: 0.9 }}>Emergency SOS</div>
              <div style={{ textAlign: "center", marginTop: 8, fontSize: 17, opacity: 0.55 }}>Press and hold to send help</div>
              <div style={{ position: "absolute", left: 195 - 130, top: 330, width: 260, height: 260 }}>
                {[0, 1].map((k) => {
                  const r = (ripple + k * 0.5) % 1;
                  return (
                    <div
                      key={k}
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: "50%",
                        border: `3px solid ${C.red}`,
                        transform: `scale(${1 + r * 0.45})`,
                        opacity: 0.5 * (1 - r),
                      }}
                    />
                  );
                })}
                <svg width="260" height="260" viewBox="0 0 260 260" style={{ position: "absolute", inset: 0 }}>
                  <circle cx="130" cy="130" r="122" fill={C.red} />
                  <circle cx="130" cy="130" r="122" fill="none" stroke="white" strokeWidth={8} strokeDasharray={`${hold * 766} 766`} transform="rotate(-90 130 130)" opacity={0.9} />
                  <text x="130" y="148" textAnchor="middle" fill="white" fontFamily={display} fontWeight={800} fontSize="58">
                    SOS
                  </text>
                </svg>
              </div>
              <div style={{ position: "absolute", bottom: 120, width: "100%", textAlign: "center", fontSize: 20, opacity: 0.6 }}>
                {hold > 0 ? `Hold... ${Math.max(0, 3 - Math.floor(hold * 3))}` : " "}
              </div>
            </div>
          </div>
        </Pop>
      </div>
    </AbsoluteFill>
  );
};

// ---------- S03: Meet Batman ----------
const Check: React.FC<{ color?: string }> = ({ color = C.indigo }) => (
  <svg width="30" height="30" viewBox="0 0 30 30">
    <circle cx="15" cy="15" r="15" fill={color} />
    <path d="M8.5 15.5 L13 20 L21.5 10.5" stroke="white" strokeWidth={3.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Pill: React.FC<{ at: number; children: React.ReactNode }> = ({ at: a, children }) => (
  <Pop at={a} y={20}>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "white",
        borderRadius: 999,
        padding: "14px 28px 14px 16px",
        fontFamily: text,
        fontWeight: 700,
        fontSize: 32,
        color: C.ink,
        boxShadow: "0 16px 40px -18px rgba(28,26,51,0.35), 0 0 0 1px rgba(28,26,51,0.06)",
      }}
    >
      <Check />
      {children}
    </div>
  </Pop>
);

export const S03: React.FC = () => {
  const frame = useCurrentFrame();
  const p = pop(frame, at(0) - 2, 11, 120);
  const mark = ramp(frame, at(0.35), 14);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -40 }}>
        <div style={{ transform: `scale(${0.4 + 0.6 * p}) rotate(${(1 - p) * -12}deg)`, opacity: Math.min(1, p * 2) }}>
          <div
            style={{
              width: 250,
              height: 250,
              borderRadius: 64,
              background: C.lilac,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 30px 70px -26px rgba(58,49,145,0.55)",
            }}
          >
            <Logo size={220} frame={frame} blinkAt={[at(1.1), at(4.0)]} />
          </div>
        </div>
        <Img src={staticFile("img/lettering.svg")} style={{ height: 80, marginTop: 34, opacity: mark, transform: `translateY(${(1 - mark) * 20}px)` }} />
        <div style={{ marginTop: 34, textAlign: "center" }}>
          <Words text="A safety buddy that lives in iMessage." at={at(1.42)} size={70} highlight={["iMessage"]} />
        </div>
        <div style={{ display: "flex", gap: 22, marginTop: 40 }}>
          <Pill at={at(3.78)}>No app</Pill>
          <Pill at={at(4.69)}>You just text it</Pill>
        </div>
      </div>
    </AbsoluteFill>
  );
};
