// Render review stills: node scripts/stills.mjs 120 480 ...  -> out/stills/fNNN.png
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import fs from "node:fs";

const frames = process.argv.slice(2).map(Number);
const entry = path.resolve("src/index.ts");
const serveUrl = await bundle({ entryPoint: entry, publicDir: path.resolve("public") });
const composition = await selectComposition({ serveUrl, id: "BatmanVideo", inputProps: { voice: false } });
fs.mkdirSync("out/stills", { recursive: true });
for (const frame of frames) {
  const output = `out/stills/f${String(frame).padStart(4, "0")}.png`;
  await renderStill({ serveUrl, composition, frame, output, scale: 0.5, inputProps: { voice: false } });
  console.log(output);
}
