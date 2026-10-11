import { loadFont as loadBricolage } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadAtkinson } from "@remotion/google-fonts/AtkinsonHyperlegible";

export const display = loadBricolage("normal", { weights: ["600", "800"], subsets: ["latin"] }).fontFamily;
export const text = loadAtkinson("normal", { weights: ["400", "700"], subsets: ["latin"] }).fontFamily;
// iMessage UI is set in the system face on real phones; Atkinson keeps it legible at video size.
export const ui = text;

export const C = {
  ink: "#1C1A33",
  indigo: "#3A3191",
  moon: "#F7F6FF",
  lilac: "#E4E0FF",
  glow: "#FFA47E",
  slate: "#5B5874",
  blue: "#0A7CFF",
  bubble: "#E9E9EB",
  bubbleInk: "#111114",
  green: "#2FB463",
  red: "#E5484D",
  night: "#14122A",
  nightHi: "#2B2566",
  white: "#FFFFFF",
};
