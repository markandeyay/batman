import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, display, text, ui } from "../theme";
import { at } from "../timing";
import { clamp, fadeOut, pop, ramp } from "../ui/anim";
import { Logo } from "../ui/Logo";
import { Card, Kicker, Pop, Sfx, Sounds, Words } from "../ui/kit";
import { messageSounds, Msg, Phone } from "../ui/Phone";

// ---------- S08: triggers ----------
const TriggerCard: React.FC<{ at: number; title: string; sub: string; children: React.ReactNode }> = ({ at: a, title, sub, children }) => (
  <Pop at={a} y={40} from={0.9}>
    <Card style={{ width: 380, padding: 0, overflow: "hidden" }}>
      <div style={{ height: 250, background: "#F4F3FA", position: "relative", overflow: "hidden" }}>{children}</div>
      <div style={{ padding: "22px 26px 26px" }}>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 34, color: C.ink, letterSpacing: "-0.015em" }}>{title}</div>
        <div style={{ fontFamily: text, fontSize: 23, color: C.slate, marginTop: 6 }}>{sub}</div>
      </div>
    </Card>
  </Pop>
);

const Fence: React.FC<{ r?: number; color?: string }> = ({ r = 70, color = C.indigo }) => (
  <div
    style={{
      position: "absolute",
      left: 190 - r,
      top: 125 - r,
      width: r * 2,
      height: r * 2,
      borderRadius: "50%",
      background: `${color}1A`,
      border: `3px dashed ${color}`,
    }}
  />
);

const Dot: React.FC<{ x: number; y: number; o?: number }> = ({ x, y, o = 1 }) => (
  <div style={{ position: "absolute", left: x - 14, top: y - 14, width: 28, height: 28, borderRadius: 28, background: C.blue, border: "5px solid white", boxShadow: "0 3px 8px rgba(0,0,0,0.25)", opacity: o }} />
);

export const S08: React.FC = () => {
  const frame = useCurrentFrame();
  const c1 = at(2.71);
  const c2 = at(4.6);
  const c3 = at(5.6);
  const c4 = at(7.1);
  // 1: clock passes the planned end
  const hand = interpolate(frame, [c1 + 6, c1 + 40], [-60, 75], clamp);
  // 2: walk out of the geofence
  const walk = interpolate(frame, [c2 + 6, c2 + 34], [0, 1], clamp);
  // 3: fast departure
  const drive = interpolate(frame, [c3 + 6, c3 + 26], [0, 1], { ...clamp, easing: (x) => x * x });
  // 4: location goes dark
  const dark = interpolate(frame, [c4 + 8, c4 + 30], [1, 0.15], clamp);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 120, width: "100%", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Kicker at={0}>Triggers, not guesses</Kicker>
        <div style={{ marginTop: 24 }}>
          <Words text="It only speaks up when something looks off." at={at(0)} size={78} highlight={["off."]} />
        </div>
      </div>
      <div style={{ position: "absolute", top: 380, width: "100%", display: "flex", justifyContent: "center", gap: 34 }}>
        <TriggerCard at={c1} title="Past your end time" sub="9:00 PM came and went">
          <svg width="380" height="250" viewBox="0 0 380 250">
            <circle cx="190" cy="125" r="84" fill="white" stroke={C.ink} strokeWidth={6} />
            {new Array(12).fill(0).map((_, i) => {
              const a = (i / 12) * Math.PI * 2;
              return <line key={i} x1={190 + Math.sin(a) * 70} y1={125 - Math.cos(a) * 70} x2={190 + Math.sin(a) * 78} y2={125 - Math.cos(a) * 78} stroke={C.slate} strokeWidth={3} />;
            })}
            <line x1="190" y1="125" x2="190" y2="80" stroke={C.ink} strokeWidth={7} strokeLinecap="round" transform="rotate(270 190 125)" />
            <line x1="190" y1="125" x2="190" y2="58" stroke={C.glow} strokeWidth={5} strokeLinecap="round" transform={`rotate(${hand} 190 125)`} />
            <circle cx="190" cy="125" r="7" fill={C.ink} />
          </svg>
          <div style={{ position: "absolute", right: 26, top: 22, background: C.glow, color: C.ink, borderRadius: 999, padding: "6px 14px", fontFamily: text, fontWeight: 700, fontSize: 20, opacity: ramp(frame, c1 + 30, 8) }}>
            +15 min
          </div>
        </TriggerCard>
        <TriggerCard at={c2} title="Left unexpectedly" sub="Walked away mid-meetup">
          <Fence />
          <Dot x={190 + walk * 150} y={125 + walk * 60} />
        </TriggerCard>
        <TriggerCard at={c3} title="Sped off in a car" sub="Fast departure before the end">
          <Fence />
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 190 + drive * 260 - 90 - i * 10,
                top: 113 + i * 12,
                width: 70 * drive,
                height: 4,
                borderRadius: 4,
                background: C.blue,
                opacity: 0.35,
              }}
            />
          ))}
          <Dot x={190 + drive * 260} y={125} />
          <div style={{ position: "absolute", left: 22, top: 22, background: C.ink, color: "white", borderRadius: 999, padding: "6px 14px", fontFamily: text, fontWeight: 700, fontSize: 20, opacity: ramp(frame, c3 + 14, 8) }}>
            38 mph
          </div>
        </TriggerCard>
        <TriggerCard at={c4} title="Location went dark" sub="No updates, no reply">
          <Fence color={C.slate} />
          {[0, 1].map((i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 240 - 36 - i * 22,
                top: 100 - 36 - i * 22,
                width: 72 + i * 44,
                height: 72 + i * 44,
                borderRadius: "50%",
                border: `3px dashed ${C.slate}`,
                opacity: (1 - dark) * 0.6,
              }}
            />
          ))}
          <Dot x={240} y={100} o={dark} />
          <div style={{ position: "absolute", left: 22, bottom: 20, fontFamily: text, fontWeight: 700, fontSize: 20, color: C.slate, opacity: 1 - dark }}>last seen 9:12 PM</div>
        </TriggerCard>
      </div>
      <div style={{ position: "absolute", top: 900, width: "100%", textAlign: "center", fontFamily: text, fontSize: 28, color: C.slate, opacity: ramp(frame, at(8.2), 12) }}>
        Late nights and riskier meetups get shorter timers.
      </div>
    </AbsoluteFill>
  );
};

// ---------- S09: escalation ladder ----------
const GUARDIAN_ALERT =
  "⚠️ Robin might need help.\nRobin hasn't answered my last 3 messages (18 min) during their first date.\nLast location at 9:41 PM (2 min ago, ±12 m): Mission St & 3rd St\nmaps.apple.com/?ll=37.785,-122.401\nPlan: Blue Bottle, 7:00 to 9:00 PM.\nPlease call Robin now. If you think they're in danger, call 911.\nReply GOT IT so I know you're on it.";

const s09a: Msg[] = [
  { from: "them", at: at(0.2), typing: 12, text: "Hey, everything good?" },
  { from: "me", at: at(2.45), text: "all good! having fun 🙂", typed: true, readAt: at(2.8) },
];
const s09b: Msg[] = [
  { from: "them", at: -30, typing: 0, text: "Hey, everything good?" },
  { from: "them", at: at(5.45), typing: 12, text: "Text me back when you can 🙂" },
  { from: "them", at: at(7.25), typing: 12, text: "Hey, can you text me back real quick?" },
];
const s09g: Msg[] = [
  { from: "them", at: -40, typing: 0, text: "Thanks. If I ever text you about Robin, it means they haven't answered me." },
  { from: "them", at: at(8.55), typing: 0, text: GUARDIAN_ALERT, ringAt: at(8.7), ringColor: "rgba(229,72,77,0.35)" },
];

const Step: React.FC<{ n: string; title: string; quote: string; state: "idle" | "active" | "done" | "ok" | "alert"; p: number }> = ({ n, title, quote, state, p }) => {
  const col = state === "ok" ? C.green : state === "alert" ? C.red : state === "idle" ? "#CFCBE4" : C.indigo;
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start", opacity: 0.4 + 0.6 * p, position: "relative", zIndex: 1 }}>
      <div
        style={{
          width: 58,
          height: 58,
          borderRadius: 58,
          background: state === "idle" ? "#F7F6FF" : col,
          border: `3px solid ${col}`,
          color: state === "idle" ? C.slate : "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: display,
          fontWeight: 800,
          fontSize: 24,
          flexShrink: 0,
          boxShadow: state === "active" || state === "alert" ? `0 0 0 8px ${col}26` : "none",
        }}
      >
        {state === "ok" ? "✓" : n}
      </div>
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 32, color: C.ink, letterSpacing: "-0.01em" }}>{title}</div>
        <div style={{ fontFamily: text, fontSize: 22, color: C.slate, marginTop: 2 }}>{quote}</div>
      </div>
    </div>
  );
};

export const S09: React.FC = () => {
  const frame = useCurrentFrame();
  const resolved = frame >= at(3.45) && frame < at(4.6);
  const phaseB = frame >= at(4.6);
  const l0 = frame >= at(0.2);
  const l1 = phaseB && frame >= at(5.45);
  const l2 = phaseB && frame >= at(7.25);
  const l3 = phaseB && frame >= at(8.4);
  const st = (on: boolean, next: boolean): "idle" | "active" | "done" => (!on ? "idle" : next ? "done" : "active");
  const okBadge = resolved ? pop(frame, at(3.45), 12, 170) : 0;
  const swap = phaseB ? ramp(frame, at(4.6), 8) : 0;
  const guard = pop(frame, at(8.3), 15, 140);
  const ticks = [
    { t: "Your plan", a: at(9.0) },
    { t: "Last location", a: at(10.5) },
    { t: "Exactly why", a: at(11.9) },
  ];
  const sfx: Sfx[] = [...messageSounds(s09a).filter((s) => s.at > 0), ...messageSounds(s09b).filter((s) => s.at > 0), { at: at(8.55), kind: "alert" }];
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 110, top: 120, width: 560 }}>
        <Kicker at={0}>If you go quiet</Kicker>
        <div style={{ marginTop: 22 }}>
          <Words text="It asks you first." at={at(0)} size={72} highlight={["you"]} />
        </div>
        <div style={{ marginTop: 44, display: "flex", flexDirection: "column", gap: 30, position: "relative" }}>
          <div style={{ position: "absolute", left: 28, top: 30, width: 3, height: 330, background: "#E1DDF3" }} />
          <Step n="1" title="Casual text" quote="“Hey, everything good?”" state={resolved ? "ok" : st(l0, l1)} p={l0 ? 1 : 0} />
          <Step n="2" title="Gentle nudge" quote="“Text me back when you can”" state={st(l1, l2)} p={l1 ? 1 : 0} />
          <Step n="3" title="One more try" quote="“Can you text me back real quick?”" state={st(l2, l3)} p={l2 ? 1 : 0} />
          <Step n="4" title="Backup alerted" quote="Alfred gets the details" state={l3 ? "alert" : "idle"} p={l3 ? 1 : 0} />
        </div>
        <div style={{ marginTop: 26, marginLeft: 78, display: "flex", flexDirection: "column", gap: 10 }}>
          {ticks.map((k) => {
            const p = pop(frame, k.a, 13, 170);
            return (
              <div key={k.t} style={{ display: "flex", gap: 12, alignItems: "center", fontFamily: text, fontWeight: 700, fontSize: 26, color: C.ink, opacity: p, transform: `translateX(${(1 - p) * -20}px)` }}>
                <span style={{ color: C.red }}>✓</span> {k.t}
              </div>
            );
          })}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 690,
          background: C.green,
          color: "white",
          borderRadius: 999,
          padding: "14px 26px",
          fontFamily: text,
          fontWeight: 700,
          fontSize: 28,
          opacity: okBadge * fadeOut(frame, at(4.35), 6),
          transform: `scale(${0.6 + 0.4 * okBadge})`,
          transformOrigin: "left center",
        }}
      >
        ✓ Replied, so Batman backs off
      </div>
      <div style={{ position: "absolute", left: 700, top: 105 }}>
        <div style={{ position: "relative" }}>
          <div style={{ opacity: 1 - swap }}>
            <Phone frame={frame} name="Batman" messages={s09a} time="8:47" />
          </div>
          <div style={{ position: "absolute", inset: 0, opacity: swap }}>
            {phaseB ? <Phone frame={frame} name="Batman" messages={s09b} time="9:38" /> : null}
          </div>
          <div
            style={{
              position: "absolute",
              left: 40,
              right: 40,
              top: 300,
              textAlign: "center",
              fontFamily: text,
              fontWeight: 700,
              fontSize: 22,
              color: C.slate,
              opacity: phaseB ? Math.min(ramp(frame, at(4.8), 8), fadeOut(frame, at(5.3), 6)) : 0,
            }}
          >
            no reply · 10 min
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 1210, top: 105, opacity: Math.min(1, guard * 1.4), transform: `translateX(${(1 - guard) * 120}px)` }}>
        <div style={{ position: "absolute", top: -50, left: 0, fontFamily: text, fontWeight: 700, fontSize: 22, letterSpacing: "0.12em", color: C.red }}>ALFRED'S PHONE</div>
        <Phone frame={frame} name="Batman" messages={s09g} time="9:43" />
      </div>
      <Sounds list={sfx} />
    </AbsoluteFill>
  );
};

// ---------- S10: code words in action ----------
const s10: Msg[] = [
  { from: "me", at: at(2.3), text: "pineapple", typed: true },
  { from: "them", at: at(3.4), typing: 10, text: "omg ok one sec" },
  { from: "them", at: at(5.1), typing: 12, text: "Call me asap", bold: true, pulseAt: at(5.6) },
  { from: "me", at: at(8.1), text: "blue moon", typed: true },
  { from: "them", at: at(10.7), typing: 12, text: "haha ok", pulseAt: at(11.75) },
];
const s10g: Msg[] = [
  { from: "them", at: -40, typing: 0, text: "Thanks. If I ever text you about Robin, it means they haven't answered me." },
  {
    from: "them",
    at: at(8.95),
    typing: 0,
    text: "⚠️ Robin might need help.\nRobin sent me their private alert word. That means they want help but may not be able to talk.\nLast location at 8:16 PM (just now, ±10 m): Blue Bottle, Market St\nPlease call Robin now. If you think they're in danger, call 911.",
    ringAt: at(9.1),
    ringColor: "rgba(229,72,77,0.35)",
  },
];

const Label: React.FC<{ at: number; k: string; word: string; desc: string; out?: number }> = ({ at: a, k, word, desc, out }) => (
  <Pop at={a} y={24} out={out}>
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: text, fontWeight: 700, fontSize: 20, letterSpacing: "0.16em", color: C.slate }}>{k}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 54, color: C.indigo, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{word}</div>
      <div style={{ fontFamily: text, fontSize: 26, color: C.ink, marginTop: 8 }}>{desc}</div>
    </div>
  </Pop>
);

export const S10: React.FC = () => {
  const frame = useCurrentFrame();
  const guard = pop(frame, 6, 15, 140);
  const arrow = ramp(frame, at(9.0), 10);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 70, width: "100%", textAlign: "center" }}>
        <Words text="Feeling uneasy mid-date?" at={at(0)} size={64} highlight={["uneasy"]} />
      </div>
      <div style={{ position: "absolute", left: 300, top: 170, transform: "scale(0.92)", transformOrigin: "top left" }}>
        <div style={{ position: "absolute", top: -42, left: 0, fontFamily: text, fontWeight: 700, fontSize: 22, letterSpacing: "0.12em", color: C.indigo }}>ROBIN'S PHONE</div>
        <Phone frame={frame} name="Mom" avatar="initials" initials="M" tint="linear-gradient(180deg,#F6A6C1,#E0789E)" messages={s10} time="8:15" />
      </div>
      <div style={{ position: "absolute", left: 300, top: 990, width: 383, textAlign: "center", fontFamily: text, fontSize: 22, color: C.slate, opacity: ramp(frame, at(3.4), 10) }}>
        Batman, saved as “Mom”
      </div>
      <div style={{ position: "absolute", left: 760, width: 400, top: 330, display: "flex", flexDirection: "column", alignItems: "center", gap: 70 }}>
        <Label at={at(1.97)} k="EXIT WORD" word="pineapple" desc="A friend who needs you, right now" out={at(6.6)} />
      </div>
      <div style={{ position: "absolute", left: 760, width: 400, top: 330, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Label at={at(7.05)} k="ALERT WORD" word="blue moon" desc="Your backup is notified. Your screen stays calm." />
        <svg width="300" height="60" viewBox="0 0 300 60" style={{ marginTop: 30, opacity: arrow }}>
          <path d={`M10 30 H${10 + 260 * arrow}`} stroke={C.red} strokeWidth={5} strokeDasharray="12 10" strokeLinecap="round" />
          <path d="M262 16 L286 30 L262 44" stroke={C.red} strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={arrow} />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 1235, top: 170, transform: `scale(0.92) translateX(${(1 - guard) * 140}px)`, transformOrigin: "top left", opacity: Math.min(1, guard * 1.4) }}>
        <div style={{ position: "absolute", top: -42, left: 0, fontFamily: text, fontWeight: 700, fontSize: 22, letterSpacing: "0.12em", color: C.red }}>ALFRED'S PHONE</div>
        <Phone frame={frame} name="Batman" messages={s10g} time="8:16" />
      </div>
      <Sounds list={[...messageSounds(s10), { at: at(8.95), kind: "alert" }]} />
    </AbsoluteFill>
  );
};

// ---------- S12: close ----------
const s12: Msg[] = [
  { from: "me", at: at(0.35), text: "home", typed: true },
  { from: "them", at: at(1.5), typing: 12, text: "Glad you're back. 👍 Plan closed and your location's no longer shared with me." },
];

export const S12: React.FC = () => {
  const frame = useCurrentFrame();
  const out = fadeOut(frame, at(2.75), 10);
  const g = pop(frame, at(1.75), 14, 160);
  const end = pop(frame, at(3.0), 12, 110);
  const url = pop(frame, at(6.1), 13, 150);
  return (
    <AbsoluteFill>
      <div style={{ opacity: out }}>
        <div style={{ position: "absolute", left: 150, top: 330, width: 820 }}>
          <Kicker at={0}>Home safe</Kicker>
          <div style={{ marginTop: 24 }}>
            <Words text="Text home. The plan closes." at={at(0)} size={92} highlight={["home."]} />
          </div>
          <div
            style={{
              marginTop: 40,
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
              background: "white",
              borderRadius: 22,
              padding: "16px 22px",
              boxShadow: "0 16px 40px -18px rgba(28,26,51,0.35)",
              fontFamily: ui,
              fontSize: 26,
              color: C.ink,
              opacity: g,
              transform: `translateY(${(1 - g) * 18}px)`,
            }}
          >
            <span style={{ color: C.green, fontWeight: 700 }}>Alfred:</span> Robin is home safe. Thanks for being their backup.
          </div>
        </div>
        <div style={{ position: "absolute", right: 170, top: 105 }}>
          <Phone frame={frame} name="Batman" messages={s12} time="9:58" />
        </div>
      </div>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: Math.min(1, end * 1.5) }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: `scale(${0.85 + 0.15 * end})`, marginTop: -30 }}>
          <div
            style={{
              width: 230,
              height: 230,
              borderRadius: 60,
              background: C.lilac,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 30px 70px -26px rgba(58,49,145,0.55)",
            }}
          >
            <Logo size={200} frame={frame} blinkAt={[at(4.6), at(7.6)]} />
          </div>
          <Img src={staticFile("img/lettering.svg")} style={{ height: 76, marginTop: 30 }} />
          <div style={{ marginTop: 30 }}>
            <Words text="Someone always has your back." at={at(4.02)} size={72} highlight={["your", "back."]} />
          </div>
          <div
            style={{
              marginTop: 44,
              background: C.indigo,
              color: "white",
              fontFamily: display,
              fontWeight: 800,
              fontSize: 46,
              padding: "18px 40px",
              borderRadius: 999,
              opacity: url,
              transform: `scale(${0.7 + 0.3 * url})`,
              boxShadow: "0 24px 50px -20px rgba(58,49,145,0.7)",
            }}
          >
            trybatman.vercel.app
          </div>
          <div style={{ marginTop: 26, fontFamily: text, fontSize: 24, color: C.slate, opacity: ramp(frame, at(6.7), 12) }}>
            Runs on iMessage via Photon · Language by Claude · No app to install
          </div>
        </div>
      </AbsoluteFill>
      <Sounds list={messageSounds(s12)} />
    </AbsoluteFill>
  );
};
