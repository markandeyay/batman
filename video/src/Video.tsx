import React from "react";
import { AbsoluteFill, Html5Audio, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { S01, S02, S03 } from "./scenes/Intro";
import { S04, S05, S06, S07 } from "./scenes/Setup";
import { S08, S09, S10, S12 } from "./scenes/Safety";
import { S11 } from "./scenes/Trust";
import { LEAD, SCENES } from "./timing";
import { LightBg, NightBg, SceneWrap } from "./ui/kit";

const COMPONENTS = [S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S12];

/** Night for the problem, then the light comes on when Batman shows up. */
const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const t = SCENES[2]!.start - 4;
  const r = interpolate(frame, [t, t + 22], [0, 1250], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (x) => 1 - Math.pow(1 - x, 3) });
  return (
    <AbsoluteFill>
      {frame < t + 24 ? <NightBg /> : null}
      <AbsoluteFill style={{ clipPath: `circle(${r}px at 50% 42%)` }}>
        <LightBg />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const BatmanVideo: React.FC<{ voice: boolean }> = ({ voice }) => (
  <AbsoluteFill style={{ background: "#14122A" }}>
    <Backdrop />
    {SCENES.map((s, i) => {
      const Comp = COMPONENTS[i]!;
      const n = String(i + 1).padStart(2, "0");
      return (
        <Sequence key={n} from={s.start} durationInFrames={s.frames} name={`S${n}`}>
          <SceneWrap frames={s.frames}>
            <Comp />
          </SceneWrap>
          {voice ? (
            <Sequence from={LEAD} layout="none">
              <Html5Audio src={staticFile(`vo/s${n}.mp3`)} volume={1} />
            </Sequence>
          ) : null}
        </Sequence>
      );
    })}
  </AbsoluteFill>
);
