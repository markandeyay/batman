import React from "react";
import { Composition } from "remotion";
import { FPS, TOTAL } from "./timing";
import { BatmanVideo } from "./Video";

export const Root: React.FC = () => (
  <>
    <Composition id="BatmanVideo" component={BatmanVideo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} defaultProps={{ voice: true }} />
    <Composition id="BatmanVideoNoVoice" component={BatmanVideo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} defaultProps={{ voice: false }} />
  </>
);
