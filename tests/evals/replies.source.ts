// Labeled check-in replies for the classifier eval (spec 7.5, 9.3). Written by hand.
// Tags: plain, slang, typo, sarcasm, voice (STT-style transcript), indirect (indirect distress),
// emoji, excuse. Labels follow 9.3: OK, NOT_OK, AMBIGUOUS, COMMAND (with command).

export interface ReplyCase {
  text: string;
  label: "OK" | "NOT_OK" | "AMBIGUOUS" | "COMMAND";
  command?: "done" | "home" | "extend" | "cancel" | "moving";
  fromVoice?: boolean;
  tag: string;
}

const OK: Array<[string, string]> = [
  ["yeah lol", "slang"], ["yes", "plain"], ["yep all good", "plain"], ["im good", "plain"], ["all good!", "plain"],
  ["doing great", "plain"], ["having fun", "plain"], ["good so far", "plain"], ["were good", "plain"], ["totally fine", "plain"],
  ["yeah he's really nice", "plain"], ["it's going well actually", "plain"], ["so far so good", "plain"], ["all set", "plain"],
  ["no worries im fine", "plain"], ["yup", "slang"], ["ya", "slang"], ["yea im chillin", "slang"], ["lmaooo yes", "slang"],
  ["we vibing", "slang"], ["all gucci", "slang"], ["10/10 night tbh", "slang"], ["bro its fine lol", "slang"], ["ye", "slang"],
  ["yessir", "slang"], ["deadass having a good time", "slang"], ["its lit", "slang"], ["we good fam", "slang"], ["fr fr all good", "slang"],
  ["chillin chillin", "slang"], ["im gud", "typo"], ["yeah im fiine", "typo"], ["all goood", "typo"], ["evrything is good", "typo"],
  ["havin fun lol", "typo"], ["yea were gud", "typo"], ["im okk", "typo"], ["doign great", "typo"], ["so far so god lol", "typo"],
  ["yes sry", "typo"], ["phone died lol all good", "excuse"], ["sorry was in the bathroom, all good", "excuse"],
  ["sry just saw this, im fine", "excuse"], ["omg sorry phone was in my bag, we're good", "excuse"], ["lol yes sorry it's loud in here", "excuse"],
  ["sorry was talking, everything's fine", "excuse"], ["yes!! sorry didnt see", "excuse"], ["haha yeah sorry, we're eating", "excuse"],
  ["oops yes all good", "excuse"], ["my bad, having a great time", "excuse"], ["👍", "emoji"], ["😂 yes", "emoji"], ["❤️ all good", "emoji"],
  ["👌", "emoji"], ["yes 🙂", "emoji"], ["😊", "emoji"], ["having the best time 🥰", "emoji"], ["all good 👍", "emoji"],
  ["😎 we good", "emoji"], ["lol 😂 he's hilarious", "emoji"], ["ugh fine, the food is just slow lol", "sarcasm"],
  ["oh im SUFFERING, they have bottomless fries", "sarcasm"], ["terrible, the dessert is too good", "sarcasm"],
  ["worst date ever (jk he's great)", "sarcasm"], ["help me i ate too much pasta lol jk im fine", "sarcasm"],
  ["send help the karaoke is starting 😂 jk all good", "sarcasm"], ["dying of boredom at this museum lol nah its cute", "sarcasm"],
  ["great, it's raining, but we're fine inside", "sarcasm"], ["absolute disaster, he's taller than his profile said lol", "sarcasm"],
  ["horrible, i'm gonna have to see him again 🙄😂", "sarcasm"], ["yeah um yeah everything is good", "voice"],
  ["yes im fine thanks", "voice"], ["uh yeah were having a good time", "voice"], ["yeah all good um just finishing dinner", "voice"],
  ["everything's good were at the bar", "voice"], ["yep yep doing fine", "voice"], ["im good im good", "voice"],
  ["yeah its going great actually", "voice"], ["all good he's nice", "voice"], ["uh huh yes im okay", "voice"],
  ["still here, it's great", "plain"], ["im alive lol", "slang"], ["yes mom 🙄 lol im fine", "sarcasm"], ["better than expected", "plain"],
  ["really good actually", "plain"], ["he's sweet", "plain"], ["we're just talking, it's nice", "plain"], ["yes we're fine", "plain"],
  ["good good", "plain"], ["fine!", "plain"], ["perfect", "plain"], ["amazing", "plain"], ["yes it's been fun", "plain"],
  ["all good, the item is great", "plain"], ["yep bought it, all good", "plain"], ["the apartment is nice, all good", "plain"],
  ["landlord seems legit, im fine", "plain"], ["yes the seller was friendly", "plain"], ["going well", "plain"], ["great time", "plain"],
  ["im okay", "plain"], ["no problems", "plain"], ["nothing wrong lol", "plain"], ["not bad at all", "plain"], ["yeah no its fine", "slang"],
  ["no worries", "plain"], ["k all good", "slang"], ["yeah good", "plain"], ["mhm all good", "voice"],
  ["all good just busy", "plain"], ["fine fine", "plain"], ["yes im having fun", "plain"], ["it's nice", "plain"], ["good vibes only lol", "slang"],
  ["no problems here", "plain"],
];

const NOT_OK: Array<[string, string]> = [
  ["not really", "plain"], ["no", "plain"], ["nope", "plain"], ["no not good", "plain"], ["not ok", "plain"], ["im not okay", "plain"],
  ["can you call me", "indirect"], ["call me pls", "indirect"], ["please call me now", "indirect"], ["get me out of here lol", "indirect"],
  ["i want to leave", "indirect"], ["i need to go", "indirect"], ["idk he's being weird", "indirect"], ["this is getting weird", "indirect"],
  ["he keeps touching my leg", "indirect"], ["he won't stop touching me", "indirect"], ["he's really pushy", "indirect"],
  ["he's kinda aggressive", "indirect"], ["my drink tastes funny", "indirect"], ["i feel really dizzy", "indirect"],
  ["i think i'm too drunk", "indirect"], ["he locked the door", "indirect"], ["he took my phone for a sec, weird", "indirect"],
  ["there are three guys here not just him", "indirect"], ["this isn't what the listing said", "indirect"],
  ["he wants to go back to his place and i don't", "indirect"], ["he's following me to my car", "indirect"],
  ["i'm uncomfortable", "plain"], ["kinda uncomfortable ngl", "slang"], ["bad vibes", "slang"], ["red flags everywhere", "slang"],
  ["he's creepy", "plain"], ["lowkey scared", "slang"], ["im scared", "plain"], ["nervous af", "slang"], ["not great tbh", "plain"],
  ["he's yelling at me", "indirect"], ["he's mad at me", "indirect"], ["he won't let me leave", "plain"], ["come get me", "plain"],
  ["please come get me", "plain"], ["i don't feel safe", "plain"], ["dont feel safe", "typo"], ["i dont feel saf", "typo"],
  ["help", "plain"], ["help me", "plain"], ["sos", "plain"], ["call 911", "plain"], ["he hit me", "plain"], ["he grabbed me", "plain"],
  ["he's following me", "plain"], ["i'm being followed", "plain"], ["stranded, no ride home", "indirect"], ["he left me here", "indirect"],
  ["he drove off with my stuff", "indirect"], ["they're asking for cash before i see the place", "indirect"],
  ["the landlord is acting sketchy", "indirect"], ["the buyer brought friends and they're blocking my car", "indirect"],
  ["great, he won't stop asking for my address", "sarcasm"], ["oh perfect, he 'forgot' his wallet and wants me to drive him home", "sarcasm"],
  ["love that he keeps ordering me shots 🙃", "sarcasm"], ["fantastic, he's mad i won't go home with him", "sarcasm"],
  ["awesome, i'm locked in the car with him", "sarcasm"], ["super fun, he's screaming at the waiter and now me", "sarcasm"],
  ["wonderful he says i can't leave until we talk", "sarcasm"], ["cool cool cool he grabbed my arm", "sarcasm"],
  ["nah", "slang"], ["nah not really", "slang"], ["naw", "slang"], ["noo", "typo"], ["not rly", "typo"], ["im not ok", "typo"],
  ["pls call", "typo"], ["get me out", "plain"], ["i need help", "plain"], ["scary", "plain"], ["he scares me", "plain"],
  ["um can you call me like now", "voice"], ["no um i dont really feel good about this", "voice"], ["i want to go home he's being weird", "voice"],
  ["uh hes not letting me go", "voice"], ["please call me i need an excuse to leave", "voice"], ["um i think something's in my drink", "voice"],
  ["this guy is scaring me", "voice"], ["no he wont let me leave the car", "voice"], ["im kinda freaking out", "plain"],
  ["he's way drunker than i thought and wants to drive", "indirect"], ["he took my keys", "indirect"], ["he pulled a knife", "plain"],
  ["i'm hiding in the bathroom", "indirect"], ["can you pretend to be my mom and call", "indirect"], ["not good. call me", "plain"],
  ["he's touching me and i said no", "indirect"], ["i'm lost and my phone is dying", "indirect"], ["😬 not great", "emoji"],
  ["😰", "emoji"], ["🆘", "emoji"], ["nope 😟", "emoji"], ["no 😢", "emoji"], ["worried, he's acting off", "indirect"],
  ["he keeps insisting i come over", "indirect"], ["not feeling it, want out", "indirect"], ["he's blocking the door", "indirect"],
];

const AMBIGUOUS: Array<[string, string]> = [
  ["?", "plain"], ["who is this", "plain"], ["wait what", "plain"], ["hold on", "plain"], ["brb", "slang"], ["k?", "plain"],
  ["what do you mean", "plain"], ["huh", "plain"], ["one sec", "plain"], ["hang on", "plain"], ["idk", "slang"], ["maybe", "plain"],
  ["hmm", "plain"], ["why", "plain"], ["what", "plain"], ["ok?", "plain"], ["lol what", "slang"], ["?? who", "plain"],
  ["can't talk", "plain"], ["later", "plain"], ["sorry who?", "plain"], ["what's up", "plain"], ["ummm", "voice"],
  ["uh hold on a second", "voice"], ["what did you say", "voice"], ["sorry can you repeat that", "voice"], ["eh", "plain"],
  ["kinda", "plain"], ["i guess", "plain"], ["sort of", "plain"], ["not sure", "plain"], ["depends", "plain"], ["ask me later", "plain"],
  ["is this the bot", "plain"], ["can i call you back", "plain"], ["did you mean me", "plain"], ["🤔", "emoji"], ["❓", "emoji"],
  ["wdym", "slang"], ["bruh", "slang"], ["who", "plain"], ["?!", "plain"],
];

const COMMANDS: Array<[string, NonNullable<ReplyCase["command"]>, string]> = [
  ["+30", "extend", "plain"], ["+60", "extend", "plain"], ["+15", "extend", "plain"], ["add 30 min", "extend", "plain"],
  ["30 more minutes", "extend", "plain"], ["another hour", "extend", "plain"], ["going to be longer", "extend", "plain"],
  ["we're getting dinner after", "extend", "plain"], ["staying a bit longer", "extend", "plain"], ["gonna be a little longer", "extend", "slang"],
  ["+30 lol", "extend", "slang"], ["add an hour pls", "extend", "plain"], ["um add like 30 minutes", "extend", "voice"],
  ["done", "done", "plain"], ["leaving", "done", "plain"], ["heading home", "done", "plain"], ["all good im out", "done", "plain"],
  ["leaving now", "done", "plain"], ["im out", "done", "slang"], ["just left", "done", "plain"], ["on my way home", "done", "plain"],
  ["omw home", "done", "slang"], ["we're done", "done", "plain"], ["headed home now", "done", "plain"], ["uh were leaving now", "done", "voice"],
  ["home", "home", "plain"], ["made it home", "home", "plain"], ["im home", "home", "plain"], ["home safe", "home", "plain"],
  ["got home", "home", "plain"], ["back home now", "home", "plain"], ["im home lol", "home", "slang"], ["just got home", "home", "plain"],
  ["made it home safe", "home", "voice"], ["finally home", "home", "plain"],
  ["cancel", "cancel", "plain"], ["not going", "cancel", "plain"], ["he cancelled", "cancel", "plain"], ["she canceled", "cancel", "typo"],
  ["they bailed on me", "cancel", "slang"], ["it's off", "cancel", "plain"], ["never mind cancel it", "cancel", "plain"],
  ["we're moving to the bar next door", "moving", "plain"], ["moving to Lazy Bird", "moving", "plain"], ["heading over to the park", "moving", "plain"],
  ["we switched to the coffee shop across the street", "moving", "plain"], ["moved to the patio bar down the block", "moving", "plain"],
];

export const REPLIES: ReplyCase[] = [
  ...OK.map(([text, tag]) => ({ text, label: "OK" as const, tag, ...(tag === "voice" ? { fromVoice: true } : {}) })),
  ...NOT_OK.map(([text, tag]) => ({ text, label: "NOT_OK" as const, tag, ...(tag === "voice" ? { fromVoice: true } : {}) })),
  ...AMBIGUOUS.map(([text, tag]) => ({ text, label: "AMBIGUOUS" as const, tag, ...(tag === "voice" ? { fromVoice: true } : {}) })),
  ...COMMANDS.map(([text, command, tag]) => ({ text, label: "COMMAND" as const, command, tag, ...(tag === "voice" ? { fromVoice: true } : {}) })),
];
