import React from "react";
import { interpolate } from "remotion";
import { C, ui } from "../theme";
import { clamp, pop } from "./anim";
import { Avatar } from "./Logo";

export const SCREEN_W = 390;
export const SCREEN_H = 844;
const BEZEL = 13;
const FONT = 19;
const LINE = 25;
const BUBBLE_MAX = 286;

export type Msg = {
  from: "me" | "them";
  at: number;
  text?: string;
  /** Show the text being typed in the input bar before sending (me only). */
  typed?: boolean;
  kind?: "text" | "contact" | "findmy";
  contactName?: string;
  /** Frame at which "Read" shows under this message (me only). */
  readAt?: number;
  /** Frames of "..." before a reply lands (them only). 0 disables. */
  typing?: number;
  /** Frame at which this bubble pulses for emphasis. */
  pulseAt?: number;
  /** Frame at which the bubble gets a soft highlight ring. */
  ringAt?: number;
  ringColor?: string;
  bold?: boolean;
};

const typeFrames = (m: Msg) => (m.typed && m.text ? Math.min(26, Math.max(10, m.text.length * 0.9)) : 0);

/** Rough height so a new bubble can grow into place (only drives the slide-up speed). */
const estimate = (m: Msg) => {
  if (m.kind === "contact") return 86;
  if (m.kind === "findmy") return 210;
  const t = m.text ?? "";
  const lines = t.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil((p.length * 9.4) / (BUBBLE_MAX - 28))), 0);
  return lines * LINE + 22 + (m.readAt !== undefined ? 22 : 0);
};

const StatusBar: React.FC<{ time: string }> = ({ time }) => {
  const col = "#000";
  return (
    <div
      style={{
        height: 54,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 34px 0 46px",
        fontFamily: ui,
        fontWeight: 700,
        fontSize: 17,
        color: col,
      }}
    >
      <span>{time}</span>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <svg width="19" height="12" viewBox="0 0 19 12">
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={i * 5} y={9 - i * 3} width={3.4} height={3 + i * 3} rx={1} fill={col} />
          ))}
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12">
          <path d="M8.5 11.5 L5.6 8.4 A4 4 0 0 1 11.4 8.4 Z" fill={col} />
          <path d="M2.9 5.7 A8 8 0 0 1 14.1 5.7" stroke={col} strokeWidth={1.9} fill="none" strokeLinecap="round" />
          <path d="M0.6 3.1 A11.5 11.5 0 0 1 16.4 3.1" stroke={col} strokeWidth={1.9} fill="none" strokeLinecap="round" />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13">
          <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke={col} strokeOpacity={0.4} fill="none" />
          <rect x="2.5" y="2.5" width="17" height="8" rx="2" fill={col} />
          <rect x="24.5" y="4.5" width="1.6" height="4" rx="0.8" fill={col} fillOpacity={0.4} />
        </svg>
      </span>
    </div>
  );
};

const Header: React.FC<{ name: string; avatar: "batman" | "initials"; initials?: string; tint?: string; frame: number }> = ({
  name,
  avatar,
  initials,
  tint,
  frame,
}) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      paddingBottom: 10,
      borderBottom: "1px solid #E6E6EA",
      background: "rgba(249,249,251,0.96)",
      position: "relative",
    }}
  >
    <svg style={{ position: "absolute", left: 16, top: 18 }} width="14" height="24" viewBox="0 0 14 24">
      <path d="M12 2 L2 12 L12 22" stroke={C.blue} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <Avatar size={56} kind={avatar} initials={initials} tint={tint} frame={frame} />
    <div style={{ fontFamily: ui, fontSize: 14, color: "#111", marginTop: 5, display: "flex", alignItems: "center", gap: 3 }}>
      {name}
      <span style={{ color: "#8E8E93", fontSize: 13 }}>›</span>
    </div>
  </div>
);

const Typing: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ background: C.bubble, borderRadius: 22, padding: "13px 16px", display: "inline-flex", gap: 5 }}>
    {[0, 1, 2].map((i) => {
      const o = 0.35 + 0.65 * Math.max(0, Math.sin(((frame - i * 4) / 18) * Math.PI * 2));
      return <span key={i} style={{ width: 9, height: 9, borderRadius: 9, background: "#8E8E93", opacity: o }} />;
    })}
  </div>
);

const ContactCard: React.FC<{ name: string }> = ({ name }) => (
  <div style={{ background: C.blue, borderRadius: 20, padding: 12, width: 240, color: "white", fontFamily: ui }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 44,
          background: "rgba(255,255,255,0.28)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: 18,
        }}
      >
        {name
          .split(" ")
          .map((w) => w[0])
          .join("")}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 700, fontSize: FONT }}>{name}</span>
        <span style={{ fontSize: 14, opacity: 0.85 }}>Contact</span>
      </div>
      <span style={{ marginLeft: "auto", fontSize: 22, opacity: 0.8 }}>›</span>
    </div>
  </div>
);

const FindMyCard: React.FC = () => (
  <div style={{ background: "white", border: "1px solid #E3E3E8", borderRadius: 20, width: 270, overflow: "hidden", fontFamily: ui }}>
    <div style={{ height: 120, background: "linear-gradient(135deg,#DDEBDD,#E9EEF6)", position: "relative" }}>
      <svg width="270" height="120" viewBox="0 0 270 120" style={{ position: "absolute", inset: 0 }}>
        <path d="M0 80 L270 50" stroke="white" strokeWidth={10} />
        <path d="M120 0 L150 120" stroke="white" strokeWidth={8} />
        <path d="M0 20 L270 100" stroke="white" strokeWidth={5} opacity={0.8} />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 44,
          width: 30,
          height: 30,
          borderRadius: 30,
          background: C.blue,
          border: "4px solid white",
          boxShadow: "0 0 0 10px rgba(10,124,255,0.18)",
        }}
      />
    </div>
    <div style={{ padding: "10px 14px 12px" }}>
      <div style={{ fontWeight: 700, fontSize: 17, color: "#111" }}>Share My Location</div>
      <div style={{ fontSize: 14, color: "#6B6B72", marginTop: 2 }}>Batman is asking for your location</div>
      <div
        style={{
          marginTop: 10,
          background: C.blue,
          color: "white",
          borderRadius: 12,
          textAlign: "center",
          padding: "8px 0",
          fontWeight: 700,
          fontSize: 15,
        }}
      >
        Share Until End of Day
      </div>
    </div>
  </div>
);

const Bubble: React.FC<{ m: Msg; frame: number }> = ({ m, frame }) => {
  const me = m.from === "me";
  const p = pop(frame, m.at, 14, 210);
  const pulse = m.pulseAt !== undefined ? interpolate(frame, [m.pulseAt, m.pulseAt + 6, m.pulseAt + 16], [1, 1.07, 1], clamp) : 1;
  const ring = m.ringAt !== undefined ? interpolate(frame, [m.ringAt, m.ringAt + 8], [0, 1], clamp) : 0;
  const grow = interpolate(frame, [m.at, m.at + 9], [0, 1], clamp);
  const est = estimate(m);
  let inner: React.ReactNode;
  if (m.kind === "contact") inner = <ContactCard name={m.contactName ?? ""} />;
  else if (m.kind === "findmy") inner = <FindMyCard />;
  else
    inner = (
      <div
        style={{
          background: me ? C.blue : C.bubble,
          color: me ? "white" : C.bubbleInk,
          borderRadius: 22,
          padding: "10px 15px",
          maxWidth: BUBBLE_MAX,
          fontFamily: ui,
          fontSize: FONT,
          lineHeight: `${LINE}px`,
          whiteSpace: "pre-wrap",
          fontWeight: m.bold ? 700 : 400,
          boxShadow: ring > 0 ? `0 0 0 ${5 * ring}px ${m.ringColor ?? "rgba(58,49,145,0.35)"}` : "none",
        }}
      >
        {m.text}
      </div>
    );
  const read = m.readAt !== undefined && frame >= m.readAt;
  return (
    <div style={{ maxHeight: grow < 1 ? est * 1.5 * grow : undefined, overflow: grow < 1 ? "hidden" : "visible", flexShrink: 0 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: me ? "flex-end" : "flex-start",
          padding: "3px 0",
          transform: `scale(${(0.7 + 0.3 * p) * pulse})`,
          transformOrigin: me ? "100% 100%" : "0% 100%",
          opacity: Math.min(1, p * 1.6),
        }}
      >
        {inner}
        {m.readAt !== undefined ? (
          <div style={{ fontFamily: ui, fontSize: 13, color: "#8E8E93", marginTop: 3, marginRight: 4, height: 16, opacity: read ? 1 : 0.9 }}>
            {read ? "Read" : "Delivered"}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export type PhoneProps = {
  frame: number;
  name: string;
  avatar?: "batman" | "initials";
  initials?: string;
  tint?: string;
  messages: Msg[];
  time?: string;
  /** Dim overlay for "quiet" moments. */
  dim?: number;
  children?: React.ReactNode;
};

export const Phone: React.FC<PhoneProps> = ({ frame, name, avatar = "batman", initials, tint, messages, time = "6:41", dim = 0, children }) => {
  const visible = messages.filter((m) => frame >= m.at);
  // Typing indicator for the next incoming reply.
  const nextThem = messages.find((m) => m.from === "them" && (m.typing ?? 16) > 0 && frame < m.at && frame >= m.at - (m.typing ?? 16));
  // Input bar text for the next outgoing message.
  const nextMe = messages.find((m) => m.from === "me" && m.typed && frame < m.at && frame >= m.at - typeFrames(m) - 4);
  let draft = "";
  if (nextMe?.text) {
    const tf = typeFrames(nextMe);
    const k = interpolate(frame, [nextMe.at - tf - 4, nextMe.at - 4], [0, 1], clamp);
    draft = nextMe.text.slice(0, Math.round(nextMe.text.length * k));
  }
  return (
    <div
      style={{
        width: SCREEN_W + BEZEL * 2,
        height: SCREEN_H + BEZEL * 2,
        borderRadius: 68,
        background: "linear-gradient(145deg,#2E2C3A,#121118)",
        padding: BEZEL,
        boxShadow: "0 40px 80px -20px rgba(28,26,51,0.45), 0 0 0 2px #4A4858 inset",
        position: "relative",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 56,
          overflow: "hidden",
          background: "white",
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <StatusBar time={time} />
        <div style={{ position: "absolute", top: 11, left: SCREEN_W / 2 - 62, width: 124, height: 36, borderRadius: 20, background: "#000" }} />
        <Header name={name} avatar={avatar} initials={initials} tint={tint} frame={frame} />
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "0 14px 8px" }}>
          {visible.map((m, i) => (
            <Bubble key={i} m={m} frame={frame} />
          ))}
          {nextThem ? (
            <div
              style={{
                padding: "3px 0",
                opacity: interpolate(frame, [nextThem.at - (nextThem.typing ?? 16), nextThem.at - (nextThem.typing ?? 16) + 4], [0, 1], clamp),
              }}
            >
              <Typing frame={frame} />
            </div>
          ) : null}
        </div>
        <div style={{ height: 86, display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 14px 0" }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 36,
              background: "#EFEFF4",
              color: "#8E8E93",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
              fontFamily: ui,
            }}
          >
            +
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 36,
              borderRadius: 20,
              border: "1px solid #D9D9DE",
              display: "flex",
              alignItems: "center",
              padding: "0 4px 0 14px",
              fontFamily: ui,
              fontSize: 17,
              color: draft ? "#111" : "#B0B0B6",
            }}
          >
            <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{draft || "iMessage"}</span>
            {draft ? (
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 28,
                  background: C.blue,
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 17,
                  fontWeight: 700,
                }}
              >
                ↑
              </span>
            ) : null}
          </div>
        </div>
        <div style={{ position: "absolute", bottom: 8, left: SCREEN_W / 2 - 67, width: 134, height: 5, borderRadius: 5, background: "#111" }} />
        {dim > 0 ? <div style={{ position: "absolute", inset: 0, background: `rgba(20,18,42,${0.55 * dim})` }} /> : null}
        {children}
      </div>
    </div>
  );
};

/** Frames when messages land, for sound effects. */
export const messageSounds = (messages: Msg[]) =>
  messages.map((m) => ({ at: m.at, kind: m.from === "me" ? ("send" as const) : ("receive" as const) }));
