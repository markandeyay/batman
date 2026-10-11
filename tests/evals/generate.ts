// Deterministic generator for tests/evals/data/{intake.jsonl, benign.txt, replies.jsonl}.
// Run: npx tsx tests/evals/generate.ts   (outputs are committed; rerun only to change them)
// The generator lives outside data/ because the project's Read(./data/**) deny rule also
// matches tests/evals/data/, so Claude Code tools cannot edit files there directly.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLIES } from "./replies.source.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");

// ---------- intake.jsonl ----------
// Fixed reference: Sat 2026-10-17 15:00 America/Chicago.
export const INTAKE_NOW = "2026-10-17T15:00:00-05:00";
export const INTAKE_TZ = "America/Chicago";

const TIMES: Array<[string, string | null]> = [
  ["at 7", "2026-10-17T19:00"],
  ["tonight at 8:30", "2026-10-17T20:30"],
  ["at 6pm", "2026-10-17T18:00"],
  ["tomorrow at 2pm", "2026-10-18T14:00"],
  ["tomorrow at noon", "2026-10-18T12:00"],
  ["Sunday at 11am", "2026-10-18T11:00"],
  ["Monday at 6:30pm", "2026-10-19T18:30"],
  ["at 5:15", "2026-10-17T17:15"],
  ["in an hour", "2026-10-17T16:00"],
  ["in 30 minutes", "2026-10-17T15:30"],
  ["Tuesday at 7pm", "2026-10-20T19:00"],
  ["tomorrow morning at 10", "2026-10-18T10:00"],
  ["this evening at 7:30", "2026-10-17T19:30"],
  ["Wednesday at 4pm", "2026-10-21T16:00"],
  ["at 9 tonight", "2026-10-17T21:00"],
  ["", null],
];

const NAMES = ["Jordan", "Sam", "Taylor", "Chris", "Maya", "Dev", "Luis", "Hannah", "Marcus", "Priyanka", "Noah", "Elena", "Andre", "Kim"];
const DATE_SRC = ["Hinge", "Tinder", "Bumble"];
const MKT_SRC = ["Facebook Marketplace", "Craigslist", "OfferUp"];
const DATE_VENUES = ["Lula Cafe", "The Violet Hour", "Kuma's Corner", "Small Cheval", "Cafe Mustache", "Big Star", "the Art Institute", "Millennium Park"];
const MKT_VENUES = ["the Target on Elston", "the Walmart on Cicero", "the police station on Larrabee", "the Starbucks on Clark", "the Jewel Osco on Ashland", "his apartment"];
const VIEW_VENUES = ["1820 N Milwaukee Ave", "2350 W Division St", "455 N Park Dr", "1400 W Wolcott Ave"];
const OTHER_VENUES = ["Intelligentsia on Broadway", "the library on Lincoln", "Dunkin on Western", "Wicker Park"];
const ITEMS = ["couch", "bike", "dresser", "PS5", "desk", "stroller", "mini fridge", "TV"];

export interface IntakeCase {
  id: string;
  text: string;
  now: string;
  tz: string;
  expected: Record<string, string | number | boolean | null>;
}

type Vars = { name: string; src: string; time: string; venue: string; item: string };
type Frame = (v: Vars) => { text: string; extra: Record<string, string | number | boolean> };

const FRAMES: Record<"date" | "marketplace" | "viewing" | "other", Frame[]> = {
  date: [
    (v) => ({ text: `first date with ${v.name} from ${v.src} ${v.time} at ${v.venue}`, extra: { counterpartName: v.name, counterpartSource: v.src, firstTimeInPerson: true } }),
    (v) => ({ text: `meeting ${v.name} (${v.src}) ${v.time} at ${v.venue}, im driving`, extra: { counterpartName: v.name, transport: "self_drive" } }),
    (v) => ({ text: `got a ${v.src} date ${v.time}, ${v.venue}. taking an uber`, extra: { counterpartSource: v.src, transport: "rideshare" } }),
    (v) => ({ text: `drinks with ${v.name} from ${v.src} ${v.time} at ${v.venue}`, extra: { counterpartName: v.name } }),
    (v) => ({ text: `date!! ${v.name} is picking me up ${v.time}, we're going to ${v.venue}`, extra: { counterpartName: v.name, transport: "their_car" } }),
    (v) => ({ text: `${v.src} date with ${v.name} ${v.time} at ${v.venue} for like 2 hours`, extra: { counterpartName: v.name, durationMin: 120 } }),
    (v) => ({ text: `ok so im meeting a guy from ${v.src} named ${v.name} ${v.time}. place is ${v.venue}. kinda nervous ngl`, extra: { counterpartName: v.name, userNervous: true } }),
  ],
  marketplace: [
    (v) => ({ text: `selling my ${v.item} on ${v.src}, buyer ${v.name} meets me ${v.time} at ${v.venue}`, extra: { buyOrSell: "sell", counterpartName: v.name } }),
    (v) => ({ text: `picking up a ${v.item} from ${v.src} ${v.time} at ${v.venue}`, extra: { buyOrSell: "buy" } }),
    (v) => ({ text: `buying a ${v.item} off ${v.src} ${v.time}, meeting at ${v.venue}, should take 15 min`, extra: { buyOrSell: "buy", durationMin: 15 } }),
    (v) => ({ text: `${v.src} pickup ${v.time} at ${v.venue}, guy named ${v.name}, im walking there`, extra: { buyOrSell: "buy", counterpartName: v.name, transport: "walk" } }),
  ],
  viewing: [
    (v) => ({ text: `apartment viewing ${v.time} at ${v.venue}`, extra: {} }),
    (v) => ({ text: `touring a sublet at ${v.venue} ${v.time}, the landlord ${v.name} is meeting me`, extra: { counterpartName: v.name } }),
    (v) => ({ text: `going to see an apartment I found on Zillow ${v.time}, address is ${v.venue}, should take 45 min`, extra: { durationMin: 45 } }),
    (v) => ({ text: `room viewing at ${v.venue} ${v.time}, I'll take the bus`, extra: { transport: "transit" } }),
  ],
  other: [
    (v) => ({ text: `meeting ${v.name} from a facebook group for the first time ${v.time} at ${v.venue}`, extra: { counterpartName: v.name } }),
    (v) => ({ text: `meeting ${v.name} for a language exchange ${v.time} at ${v.venue}, about an hour`, extra: { counterpartName: v.name, durationMin: 60 } }),
    (v) => ({ text: `meeting someone from my running club discord ${v.time} at ${v.venue}, never met them before`, extra: {} }),
  ],
};

export function buildIntake(): IntakeCase[] {
  const out: IntakeCase[] = [];
  const types = ["date", "marketplace", "viewing", "other"] as const;
  const perType = { date: 50, marketplace: 40, viewing: 35, other: 35 };
  let n = 0;
  for (const type of types) {
    const venues = type === "date" ? DATE_VENUES : type === "marketplace" ? MKT_VENUES : type === "viewing" ? VIEW_VENUES : OTHER_VENUES;
    const srcs = type === "date" ? DATE_SRC : type === "marketplace" ? MKT_SRC : ["Zillow"];
    for (let i = 0; i < perType[type]; i++) {
      const frame = FRAMES[type][i % FRAMES[type].length]!;
      const [time, startLocal] = TIMES[(i * 7 + type.length) % TIMES.length]!;
      const v: Vars = { name: NAMES[(i * 3 + n) % NAMES.length]!, src: srcs[i % srcs.length]!, time, venue: venues[(i * 5 + 1) % venues.length]!, item: ITEMS[i % ITEMS.length]! };
      const { text, extra } = frame(v);
      out.push({
        id: `${type}-${String(i + 1).padStart(3, "0")}`,
        text: text.replace(/\s+/g, " ").replace(/ ,/g, ",").replace(/ \./g, ".").trim(),
        now: INTAKE_NOW,
        tz: INTAKE_TZ,
        expected: { type, startLocal, venueText: v.venue, ...extra },
      });
      n++;
    }
  }
  return out;
}

// ---------- benign.txt ----------

const STANDALONE = [
  "hey whats up", "lol", "omg yes", "running late sorry", "be there in 10", "did you eat", "call me when you can", "love you",
  "good morning", "good night!", "how was work", "ugh mondays", "can't wait for friday", "did you feed the cat", "where are my keys",
  "who's driving", "what time is the game", "the wifi is down again", "just landed", "boarding now", "traffic is insane",
  "send me the address", "is the store still open", "we need more coffee", "happy birthday!!", "congrats on the new job",
  "i'm so tired", "brb", "ttyl", "k", "ok", "yes", "no", "maybe later", "sounds good", "perfect", "thank you so much",
  "np", "for sure", "same", "fr", "no cap", "bet", "idk", "lmk", "omw", "here", "outside", "parking now", "coming down",
  "door's unlocked", "text me when you're home", "did you get my email", "i sent the venmo", "can you venmo me 12", "split the check?",
  "that movie was so good", "the ending was wild", "spoilers!!", "are you watching the game", "who won", "we lost again lol",
  "my phone is at 5%", "charger?", "forgot my umbrella", "it's pouring", "so hot today", "it's freezing", "snow day!!",
  "the bus is late", "train delayed 20 min", "uber surge is crazy", "walking over now", "almost there", "save me a seat",
  "the line is so long", "they're out of oat milk", "grab me a croissant", "what do you want for dinner", "tacos?", "pizza tonight?",
  "i'm making pasta", "the oven is preheating", "dishes are done", "laundry is in the dryer", "trash goes out tomorrow",
  "the plumber is coming at 2", "landlord fixed the sink finally", "rent is due friday", "package came", "your mom called",
  "dad says hi", "grandma's doing better", "vet appointment at 4", "dog threw up again", "the cat knocked over the plant",
  "kids are asleep", "pick up the kids at 3:15?", "soccer practice got cancelled", "school's closed tomorrow", "homework done?",
  "meeting ran long", "boss is in a mood", "presentation went well", "got the promotion!!", "interview at 10 wish me luck",
  "class got out early", "exam was brutal", "library till 9", "study group tonight?", "professor cancelled office hours",
  "gym later?", "leg day ugh", "ran 5k today", "yoga at 7", "my back hurts", "need a nap", "coffee first",
  "this guy at work is so funny", "she said yes!!", "we're engaged!", "baby shower is saturday", "wedding rsvp due",
  "the food here is so good", "we're at the bar now", "bathroom line is insane", "he's actually really nice", "having fun",
  "this place is packed", "music is loud lol", "they have karaoke", "we got a table outside", "ordering apps",
  "the waiter is hilarious", "dessert menu looks amazing", "should we get another round", "split a cab home?",
  "lmaooo", "dead 💀", "i'm crying 😂", "stoppp", "no wayyy", "shut up", "for real??", "wait what", "hold on",
  "who is this", "wrong number sorry", "new phone who dis", "save my new number", "my old phone died",
  "thanks for tonight", "had a great time", "let's do it again", "see you sunday", "miss you", "drive safe", "get home ok?",
  "the farmers market has peaches again", "i bought way too many apples", "smoothie bowl for breakfast", "banana pancakes this morning",
  "we watched a documentary about whales", "the aquarium was so cool", "the moon looks huge tonight", "it's so blue outside today",
  "the bread at that bakery is unreal", "toast and eggs?", "need to buy a new iron", "the lighthouse tour was closed",
  "my plant is finally growing", "the bees are back in the garden", "we saw a dragon boat race", "that song is stuck in my head",
];

const GREETINGS = ["hey", "hi", "yo", "omg", "ok so", "lol", "wait", "ugh", "hey so", "quick q", "random but", "btw"];
const QUESTIONS = [
  "are you free saturday", "did you see the game last night", "can you send me that recipe", "what time does it start",
  "is it supposed to rain tomorrow", "did you finish the book", "want to come over later", "do you have the wifi password",
  "where did you park", "did mom call you back", "can i borrow your drill", "are we still on for brunch", "what are you wearing tonight",
  "is the pharmacy open sunday", "did you pay the electric bill", "how much was the ticket", "are you coming to the party",
  "did the package come", "can you feed the dog tonight", "what's the address again", "do we need anything from the store",
  "are you up", "did you hear about the concert", "what show are you watching", "can you call me in 5", "is your sister coming",
  "did you get the tickets", "what's for dinner", "want to split an uber", "did you leave yet",
];
const SUBJECTS = ["the dog", "mom", "my boss", "the landlord", "the train", "your sister", "the package", "dinner", "the game", "class", "the cable guy", "my flight", "the meeting", "practice", "the party"];
const PREDICATES = [
  "is running late", "just called", "wants to know if you're free saturday", "got cancelled", "got moved to 6", "is here",
  "smells amazing", "starts at 8", "is delayed again", "needs to be picked up", "was so fun", "is tomorrow not today",
];
const VERBS = ["grab", "pick up", "drop off", "bring", "order", "return", "find", "check on"];
const OBJECTS = ["milk", "the keys", "my charger", "the laundry", "some coffee", "the kids", "the mail", "a pizza", "paper towels", "the car", "my glasses", "the dry cleaning"];
const WHENS = ["later", "tonight", "after work", "on your way home", "tomorrow", "before 6", "this weekend", "in a bit"];
const REACTS = ["sounds good", "lmao", "no way", "same", "fr", "omw", "running 5 late", "yesss", "nooo", "so true", "love that", "obsessed", "hate that", "ugh fine", "deal", "agreed", "i'm in", "count me out", "maybe", "too real"];
const SUFFIXES = ["", " lol", " 😂", "!!", " haha", " tbh", " ngl", "?"];
const FOODS = ["tacos", "sushi", "pizza", "ramen", "thai", "burgers", "pho", "bbq", "indian", "brunch", "coffee", "ice cream", "dumplings", "a salad"];

const STATUSES = ["just got to work", "heading to the gym", "at the store", "in line at the bank", "stuck in a meeting", "on the train", "at my moms", "at practice"];
const PLACES = [
  "the coffee shop", "the park", "my place", "your place", "the gym", "the library", "the mall", "the bar on 5th", "the taco truck",
  "the station", "the corner store", "the dog park", "the beach", "the bookstore", "the diner", "the food hall", "the rooftop", "the museum",
  "the farmers market", "the bowling alley",
];

export function buildBenign(): string[] {
  const set = new Set<string>(STANDALONE);
  for (const g of GREETINGS) for (const q of QUESTIONS) set.add(`${g} ${q}?`);
  for (const s of SUBJECTS) for (const p of PREDICATES) set.add(`${s} ${p}`);
  for (const v of VERBS) for (const o of OBJECTS) for (const w of WHENS) set.add(`can you ${v} ${o} ${w}?`);
  for (const r of REACTS) for (const s of SUFFIXES) set.add(`${r}${s}`);
  for (const f of FOODS) for (const w of WHENS) set.add(`want to get ${f} ${w}?`);
  for (const v of ["see", "get", "find", "take", "move", "wash", "fix", "hear about"]) for (const o of OBJECTS) set.add(`did you ${v} ${o}?`);
  for (const s of STATUSES) for (const x of ["", " lol", " ugh", " rn", ", call you after"]) set.add(`${s}${x}`);
  for (let h = 1; h <= 12; h++) for (const m of ["am", "pm"]) set.add(`i'll be there around ${h}${m}`);
  for (const n of [2, 5, 10, 15, 20, 30, 45]) for (const x of ["", " sorry", " lol", "!"]) set.add(`${n} minutes away${x}`);
  for (const p of PLACES) for (const w of WHENS) set.add(`meet at ${p} ${w}?`);
  return [...set];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(dataDir, { recursive: true });
  const intake = buildIntake();
  writeFileSync(join(dataDir, "intake.jsonl"), intake.map((c) => JSON.stringify(c)).join("\n") + "\n");
  const benign = buildBenign();
  writeFileSync(join(dataDir, "benign.txt"), benign.join("\n") + "\n");
  writeFileSync(join(dataDir, "replies.jsonl"), REPLIES.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`intake.jsonl: ${intake.length}, benign.txt: ${benign.length}, replies.jsonl: ${REPLIES.length}`);
}
