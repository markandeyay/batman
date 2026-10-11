import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, display, text, ui } from "../theme";
import { at } from "../timing";
import { clamp, fadeOut, pop, ramp } from "../ui/anim";
import { Card, Kicker, Pop, Sounds, Words } from "../ui/kit";
import { messageSounds, Msg, Phone } from "../ui/Phone";

const PHONE_RIGHT = { position: "absolute" as const, right: 170, top: 105 };
const LEFT = { position: "absolute" as const, left: 150, width: 900 };

// ---------- S04: sign up, onboarding, backup opt-in ----------
const s04Me: Msg[] = [
  { from: "me", at: at(2.95), text: "Hi, I'm Robin", typed: true },
  {
    from: "them",
    at: at(3.75),
    typing: 12,
    text: "Hey Robin, I'm Batman. Text me before you meet someone new (a date, a Marketplace pickup, an apartment viewing) and I'll quietly look out for you.",
  },
  {
    from: "them",
    at: at(4.25),
    typing: 0,
    text: "Quick setup, takes a minute. Who should I contact if you might need help? Send their number, or share their contact card.",
  },
  { from: "me", at: at(5.2), kind: "contact", contactName: "Alfred Pennyworth" },
  { from: "them", at: at(6.0), typing: 12, text: "Got it. Ask Alfred to text hi to (415) 555-0199. Once they do, I'll ask if they're okay being your backup." },
  { from: "them", at: at(8.75), typing: 12, text: "Alfred's in. 👍", bold: true, pulseAt: at(8.95) },
];

const s04Alfred: Msg[] = [
  { from: "me", at: at(6.5), text: "hi", typed: true },
  {
    from: "them",
    at: at(7.15),
    typing: 10,
    text: "Hi Alfred, Robin added you as their backup on Batman. You'd only hear from me if Robin might need help. Reply YES to accept or NO to decline.",
  },
  { from: "me", at: at(8.25), text: "YES", typed: true },
];

const SignupCard: React.FC = () => {
  const frame = useCurrentFrame();
  const num = "(919) 555-0142";
  const typed = num.slice(0, Math.round(num.length * interpolate(frame, [at(0.15), at(1.0)], [0, 1], clamp)));
  const press = interpolate(frame, [at(1.15), at(1.25), at(1.4)], [1, 0.95, 1], clamp);
  const res = pop(frame, at(1.55), 14, 170);
  return (
    <Card style={{ width: 640, padding: 0, overflow: "hidden" }}>
      <div style={{ background: "#F1F0F7", padding: "14px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: 13, background: c }} />
        ))}
        <div style={{ marginLeft: 16, flex: 1, background: "white", borderRadius: 10, padding: "6px 14px", fontFamily: text, fontSize: 18, color: C.slate }}>
          trybatman.vercel.app
        </div>
      </div>
      <div style={{ padding: "30px 36px 36px" }}>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 40, color: C.ink, letterSpacing: "-0.02em" }}>Get your Batman number</div>
        <div style={{ marginTop: 20, border: `2px solid ${C.lilac}`, borderRadius: 16, padding: "14px 18px", fontFamily: text, fontSize: 28, color: typed ? C.ink : "#A9A6BD" }}>
          {typed || "Your phone number"}
        </div>
        <div
          style={{
            marginTop: 16,
            background: C.indigo,
            color: "white",
            borderRadius: 16,
            padding: "14px 0",
            textAlign: "center",
            fontFamily: text,
            fontWeight: 700,
            fontSize: 26,
            transform: `scale(${press})`,
          }}
        >
          Get my number
        </div>
        <div
          style={{
            marginTop: 22,
            background: C.lilac,
            borderRadius: 18,
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            opacity: res,
            transform: `translateY(${(1 - res) * 16}px)`,
          }}
        >
          <div>
            <div style={{ fontFamily: text, fontSize: 18, color: C.slate }}>Your Batman number</div>
            <div style={{ fontFamily: display, fontWeight: 800, fontSize: 36, color: C.indigo }}>(415) 555-0199</div>
          </div>
          <div style={{ background: C.blue, color: "white", borderRadius: 999, padding: "10px 20px", fontFamily: text, fontWeight: 700, fontSize: 22 }}>Tap to text</div>
        </div>
      </div>
    </Card>
  );
};

export const S04: React.FC = () => {
  const frame = useCurrentFrame();
  const a = fadeOut(frame, at(2.65), 10);
  const b = Math.min(ramp(frame, at(2.9), 10), fadeOut(frame, at(5.35), 10));
  const c = ramp(frame, at(5.75), 12);
  return (
    <AbsoluteFill>
      <div style={{ ...LEFT, top: 150, opacity: a }}>
        <Kicker at={0}>Step 1 · Sign up</Kicker>
        <div style={{ marginTop: 28 }}>
          <Pop at={2} y={30}>
            <SignupCard />
          </Pop>
        </div>
      </div>
      <div style={{ ...LEFT, top: 330, opacity: b }}>
        <Kicker at={at(2.9)}>Step 2 · Say hi</Kicker>
        <div style={{ marginTop: 26 }}>
          <Words text="Setup takes about a minute." at={at(2.95)} size={92} highlight={["minute."]} />
        </div>
      </div>
      <div style={{ ...LEFT, top: 105, opacity: c, display: "flex", gap: 44, alignItems: "flex-start" }}>
        <div style={{ transform: "scale(0.86)", transformOrigin: "top left", width: 358, height: 750 }}>
          <Pop at={at(5.75)} x={-40} y={0} from={0.96}>
            <Phone frame={frame} name="Batman" messages={s04Alfred} time="6:44" />
          </Pop>
        </div>
        <div style={{ marginTop: 250, width: 420 }}>
          <Kicker at={at(5.9)}>Step 3 · Pick a backup</Kicker>
          <div style={{ marginTop: 24 }}>
            <Words text="Your backup opts in first." at={at(6.1)} size={66} highlight={["opts", "in"]} />
          </div>
          <div style={{ fontFamily: text, fontSize: 28, color: C.slate, marginTop: 18, opacity: ramp(frame, at(7.2), 12) }}>
            No surprise texts. Alfred says yes before Batman ever reaches out.
          </div>
        </div>
      </div>
      <div style={PHONE_RIGHT}>
        <Pop at={4} x={60} y={0} from={0.96}>
          <Phone frame={frame} name="Batman" messages={s04Me} time="6:43" />
        </Pop>
      </div>
      <Sounds list={[...messageSounds(s04Me), ...messageSounds(s04Alfred)]} />
    </AbsoluteFill>
  );
};

// ---------- S05: code words ----------
const s05: Msg[] = [
  {
    from: "them",
    at: at(0.15),
    typing: 0,
    text: "Now pick two secret code words. Text one to me anytime during a meetup:\n1) an EXIT word: an excuse to leave\n2) an ALERT word: I quietly text Alfred your location",
  },
  { from: "me", at: at(2.35), text: "exit pineapple, alert blue moon", typed: true },
  {
    from: "them",
    at: at(6.0),
    typing: 12,
    text: 'Locked in. Last thing: save me as a contact under any name. Most people pick something boring like "Mom" so my texts look normal on your lock screen.',
  },
];

const DoorIcon = () => (
  <svg width="56" height="56" viewBox="0 0 56 56">
    <rect x="10" y="6" width="26" height="44" rx="4" fill="none" stroke={C.indigo} strokeWidth={4} />
    <circle cx="29" cy="29" r="2.6" fill={C.indigo} />
    <path d="M34 28 H52 M45 21 L52 28 L45 35" stroke={C.glow} strokeWidth={4.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const BellIcon = () => (
  <svg width="56" height="56" viewBox="0 0 56 56">
    <path d="M28 8 C19 8 14 15 14 24 V34 L9 41 H47 L42 34 V24 C42 15 37 8 28 8 Z" fill="none" stroke={C.indigo} strokeWidth={4} strokeLinejoin="round" />
    <path d="M22 46 A6 6 0 0 0 34 46" stroke={C.indigo} strokeWidth={4} fill="none" strokeLinecap="round" />
    <circle cx="43" cy="12" r="6" fill={C.glow} />
  </svg>
);

const WordCard: React.FC<{ at: number; label: string; word: string; desc: string; icon: React.ReactNode }> = ({ at: a, label, word, desc, icon }) => (
  <Pop at={a} x={-40} y={0} from={0.95}>
    <Card style={{ width: 760, display: "flex", gap: 26, alignItems: "center", padding: "28px 34px" }}>
      <div style={{ width: 96, height: 96, borderRadius: 26, background: C.lilac, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontFamily: text, fontWeight: 700, fontSize: 20, letterSpacing: "0.14em", color: C.slate }}>{label}</div>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 56, color: C.indigo, lineHeight: 1.05, letterSpacing: "-0.02em" }}>{word}</div>
        <div style={{ fontFamily: text, fontSize: 28, color: C.ink, marginTop: 4 }}>{desc}</div>
      </div>
    </Card>
  </Pop>
);

export const S05: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <div style={{ ...LEFT, top: 150 }}>
        <Kicker at={0}>Step 4 · Code words</Kicker>
        <div style={{ marginTop: 26 }}>
          <Words text="Two secret code words." at={at(0)} size={92} highlight={["secret"]} />
        </div>
        <div style={{ marginTop: 50, display: "flex", flexDirection: "column", gap: 26 }}>
          <WordCard at={at(2.7)} label="EXIT WORD" word="pineapple" desc="Gets you an excuse to leave" icon={<DoorIcon />} />
          <WordCard at={at(5.31)} label="ALERT WORD" word="blue moon" desc="Quietly texts your backup" icon={<BellIcon />} />
        </div>
      </div>
      <div style={PHONE_RIGHT}>
        <Phone frame={frame} name="Batman" messages={s05} time="6:45" />
      </div>
      <Sounds list={messageSounds(s05).filter((s) => s.at > 2)} />
    </AbsoluteFill>
  );
};

// ---------- S06: the plan ----------
const s06: Msg[] = [
  { from: "me", at: at(2.2), text: "first date w Sam tonight! blue bottle on market st at 7, prob done by 9", typed: true },
  {
    from: "them",
    at: at(3.55),
    typing: 14,
    text: "Here's the plan:\nFirst date with Sam, today 7:00 PM at Blue Bottle, Market St\nBack by about 9:00 PM.\nIf something seems off I'll text you, then text Alfred.\nReply GO to lock it in, or tell me what to change.",
  },
  { from: "me", at: at(6.05), text: "GO", typed: true, readAt: at(6.4) },
  { from: "them", at: at(6.95), typing: 10, text: "Locked in. Around 6:30 PM I'll ask you to share your location until it's over." },
];

const Field: React.FC<{ at: number; k: string; v: string }> = ({ at: a, k, v }) => (
  <Pop at={a} x={-50} y={0} from={0.9}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 22, padding: "18px 0", borderTop: `2px solid ${C.lilac}` }}>
      <span style={{ fontFamily: text, fontWeight: 700, fontSize: 20, letterSpacing: "0.14em", color: C.slate, width: 110 }}>{k}</span>
      <span style={{ fontFamily: display, fontWeight: 600, fontSize: 40, color: C.ink }}>{v}</span>
    </div>
  </Pop>
);

export const S06: React.FC = () => {
  const frame = useCurrentFrame();
  const lock = pop(frame, at(6.1), 12, 170);
  return (
    <AbsoluteFill>
      <div style={{ ...LEFT, top: 130 }}>
        <Kicker at={0}>Before you go</Kicker>
        <div style={{ marginTop: 26 }}>
          <Words text="Text your plan like you'd text a friend." at={at(0)} size={84} highlight={["friend."]} />
        </div>
        <Card style={{ marginTop: 44, width: 720, padding: "22px 34px 14px", position: "relative", opacity: ramp(frame, at(3.4), 10) }}>
          <div style={{ fontFamily: text, fontWeight: 700, fontSize: 22, color: C.indigo, marginBottom: 6 }}>Batman pulled out</div>
          <Field at={at(3.55)} k="WHO" v="Sam, first date" />
          <Field at={at(4.05)} k="WHERE" v="Blue Bottle, Market St" />
          <Field at={at(4.55)} k="WHEN" v="7:00 to 9:00 PM" />
          <div
            style={{
              position: "absolute",
              right: -26,
              top: -26,
              background: C.green,
              color: "white",
              borderRadius: 999,
              padding: "12px 24px",
              fontFamily: text,
              fontWeight: 700,
              fontSize: 26,
              opacity: lock,
              transform: `scale(${0.5 + 0.5 * lock}) rotate(${4 * lock}deg)`,
              boxShadow: "0 14px 30px -12px rgba(47,180,99,0.7)",
            }}
          >
            ✓ Locked in
          </div>
        </Card>
      </div>
      <div style={PHONE_RIGHT}>
        <Phone frame={frame} name="Batman" messages={s06} time="6:12" />
      </div>
      <Sounds list={messageSounds(s06)} />
    </AbsoluteFill>
  );
};

// ---------- S07: arrival, then quiet ----------
const s07: Msg[] = [
  { from: "them", at: at(0.05), typing: 0, text: 'Tap Share on the card below and pick "Share Until End of Day." I\'ll stop looking when you\'re done.' },
  { from: "them", at: at(0.45), typing: 0, kind: "findmy" },
  { from: "them", at: at(4.05), typing: 14, text: "Have fun! Text me when you head out.", pulseAt: at(4.4) },
];

/** Stylized light street map with a geofence around the venue. */
export const MapView: React.FC<{
  w: number;
  h: number;
  dot: { x: number; y: number };
  dotOpacity?: number;
  fence: number;
  fenceColor?: string;
  label?: string;
  children?: React.ReactNode;
}> = ({ w, h, dot, dotOpacity = 1, fence, fenceColor = C.indigo, label = "Blue Bottle", children }) => {
  const frame = useCurrentFrame();
  const halo = 1 + 0.5 * ((frame % 36) / 36);
  return (
    <div style={{ width: w, height: h, borderRadius: 30, overflow: "hidden", position: "relative", background: "#F1F0F6", boxShadow: "0 24px 60px -24px rgba(28,26,51,0.3), 0 0 0 1px rgba(28,26,51,0.06)" }}>
      <svg width={w} height={h} viewBox="0 0 820 560" preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", inset: 0 }}>
        <rect x="560" y="0" width="260" height="560" fill="#D7E6F7" />
        <path d="M560 0 C600 140 540 300 600 560 L820 560 L820 0 Z" fill="#CFE0F5" />
        <rect x="70" y="330" width="200" height="150" rx="18" fill="#DCEEDB" />
        <rect x="330" y="40" width="150" height="110" rx="14" fill="#DCEEDB" />
        <g stroke="white" strokeLinecap="round">
          <path d="M-20 250 L600 140" strokeWidth={26} />
          <path d="M140 -20 L260 600" strokeWidth={18} />
          <path d="M420 -20 L470 600" strokeWidth={18} />
          <path d="M-20 520 L620 400" strokeWidth={14} />
          <path d="M-20 90 L560 20" strokeWidth={10} />
          <path d="M300 300 L560 260" strokeWidth={10} />
        </g>
        <path d="M-20 250 L600 140" stroke="#ECEAF4" strokeWidth={2} strokeDasharray="14 14" />
      </svg>
      <div
        style={{
          position: "absolute",
          left: (430 / 820) * w - fence,
          top: (205 / 560) * h - fence,
          width: fence * 2,
          height: fence * 2,
          borderRadius: "50%",
          background: `${fenceColor}1F`,
          border: `3px dashed ${fenceColor}`,
        }}
      />
      <div style={{ position: "absolute", left: (430 / 820) * w - 22, top: (205 / 560) * h - 54 }}>
        <svg width="44" height="56" viewBox="0 0 44 56">
          <path d="M22 54 C22 54 3 34 3 21 A19 19 0 0 1 41 21 C41 34 22 54 22 54 Z" fill={C.indigo} />
          <circle cx="22" cy="21" r="8" fill={C.glow} />
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          left: (430 / 820) * w + 28,
          top: (205 / 560) * h - 52,
          background: "white",
          borderRadius: 12,
          padding: "6px 12px",
          fontFamily: ui,
          fontWeight: 700,
          fontSize: 20,
          color: C.ink,
          boxShadow: "0 6px 16px -8px rgba(28,26,51,0.4)",
        }}
      >
        {label}
      </div>
      <div style={{ position: "absolute", left: dot.x - 15, top: dot.y - 15, opacity: dotOpacity }}>
        <div style={{ position: "absolute", left: -8, top: -8, width: 46, height: 46, borderRadius: 46, background: "rgba(10,124,255,0.25)", transform: `scale(${halo})`, opacity: 2 - halo }} />
        <div style={{ width: 30, height: 30, borderRadius: 30, background: C.blue, border: "5px solid white", boxShadow: "0 4px 10px rgba(0,0,0,0.25)" }} />
      </div>
      {children}
    </div>
  );
};

export const S07: React.FC = () => {
  const frame = useCurrentFrame();
  const W = 860;
  const H = 560;
  // Walk in from the lower left toward the venue.
  const t = interpolate(frame, [at(0.4), at(2.6)], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 2) });
  const path = [
    { x: 60, y: 470 },
    { x: 205, y: 400 },
    { x: 330, y: 300 },
    { x: (430 / 820) * W - 10, y: (205 / 560) * H + 30 },
  ];
  const seg = Math.min(path.length - 2, Math.floor(t * (path.length - 1)));
  const lt = t * (path.length - 1) - seg;
  const dot = { x: path[seg]!.x + (path[seg + 1]!.x - path[seg]!.x) * lt, y: path[seg]!.y + (path[seg + 1]!.y - path[seg]!.y) * lt };
  const arrived = pop(frame, at(2.43), 12, 170);
  const quiet = ramp(frame, at(5.3), 16);
  return (
    <AbsoluteFill>
      <div style={{ ...LEFT, top: 110 }}>
        <Kicker at={0}>During the meetup</Kicker>
        <div style={{ marginTop: 24 }}>
          <Words text="It watches quietly." at={at(0.1)} size={84} highlight={["quietly."]} />
        </div>
        <div style={{ marginTop: 36, position: "relative" }}>
          <Pop at={6} y={30} from={0.97}>
            <MapView w={W} h={H} dot={dot} fence={110 + 8 * arrived} fenceColor={arrived > 0.5 ? C.green : C.indigo}>
              <div
                style={{
                  position: "absolute",
                  left: 28,
                  top: 24,
                  background: C.green,
                  color: "white",
                  borderRadius: 999,
                  padding: "10px 20px",
                  fontFamily: text,
                  fontWeight: 700,
                  fontSize: 24,
                  opacity: arrived,
                  transform: `scale(${0.6 + 0.4 * arrived})`,
                  transformOrigin: "left center",
                }}
              >
                ✓ Arrived 6:58 PM
              </div>
              <div
                style={{
                  position: "absolute",
                  right: 24,
                  bottom: 24,
                  background: C.ink,
                  color: C.moon,
                  borderRadius: 999,
                  padding: "12px 22px",
                  fontFamily: text,
                  fontWeight: 700,
                  fontSize: 24,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  opacity: quiet,
                  transform: `translateY(${(1 - quiet) * 14}px)`,
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <path d="M20 14.5 A8.5 8.5 0 1 1 9.5 4 A7 7 0 0 0 20 14.5 Z" fill={C.glow} />
                </svg>
                Watching quietly. No pings.
              </div>
            </MapView>
          </Pop>
        </div>
      </div>
      <div style={PHONE_RIGHT}>
        <Phone frame={frame} name="Batman" messages={s07} time="6:58" dim={quiet * 0.5} />
      </div>
      <Sounds list={messageSounds(s07).filter((s) => s.at > 20)} />
    </AbsoluteFill>
  );
};
