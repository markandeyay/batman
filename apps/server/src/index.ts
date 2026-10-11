// Batman server entry point (spec 8.1, 8.3). Boots env, the app (store, lock, scheduler,
// runtime, gateway), and plugs the dialogue manager into the inbound loop.
// Run: pnpm dev (with .env), pnpm chat (console), or node --import tsx apps/server/src/index.ts.
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { E164, InboundMessage, TemplateId } from "./contracts.js";
import { handleInbound, handleOptinExpire } from "./dialogue/manager.js";
import type { DialoguePorts, GuardianRegistration } from "./dialogue/ports.js";
import { describeError, last4 } from "./gateway/errors.js";
import type { NormalizedInbound } from "./gateway/normalize.js";
import { createGeocoder } from "./geo/geocode.js";
import { createLlmProvider } from "./nlu/llm.js";
import * as repo from "./store/repo.js";
import { ensureUser } from "../../probe/src/register.js";

const env = loadEnv();
const app = createApp(env);
const { logger, clock, store } = app;

/** Register a guardian on the shared pool and fetch the sms: link Photon generates (spec 11.1, S5). */
async function registerGuardianAddress(address: E164): Promise<GuardianRegistration | null> {
  try {
    const { user } = await ensureUser({ projectId: env.SPECTRUM_PROJECT_ID, projectSecret: env.SPECTRUM_PROJECT_SECRET }, address);
    let smsLink: string | null = null;
    try {
      const r = await fetch(`https://spectrum.photon.codes/users/${encodeURIComponent(user.id)}/redirect`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      smsLink = r.headers.get("location");
    } catch {
      // the link is a convenience; the assigned number alone is enough
    }
    return { assignedNumber: user.assignedPhoneNumber as E164, smsLink };
  } catch (err) {
    logger.warn({ to: last4(address), error: describeError(err) }, "guardian registration failed");
    return null;
  }
}

const ports: DialoguePorts = {
  repo: app.dialogueRepo,
  clock,
  dispatch: async (planId, event) => {
    await app.runtime.dispatch(planId, event);
  },
  sendTemplate: (to, template: TemplateId, params = {}) => {
    const tz = repo.getUserByAddress(store, to)?.tz ?? env.DEFAULT_TZ;
    return app.sendTemplate(to, template, { tz, ...params });
  },
  sendText: (to, text) => app.sendText(to, text),
  react: (messageId) => app.channel.react(messageId, "like"),
  typing: (to, fn) => app.channel.typing(to, fn),
  shareContactCard: (to) => app.channel.shareContactCard(to),
  registerGuardianAddress,
  // Photon rejects advanced-imessage calls to numbers that have not texted Batman (DECISIONS.md),
  // and every user has texted first, so availability is known to be true for users.
  isIMessageAvailable: async () => true,
  schedule: async (job) => {
    app.scheduler.enqueue(job);
  },
  geocoder: createGeocoder(env),
  llm: createLlmProvider(env),
  config: {
    defaultTz: env.DEFAULT_TZ,
    allowNewConversation: async () => !app.channel.quota.status().newConversationsNearCap,
  },
  log: {
    info: (event, data) => logger.info({ ...data, event }, "dialogue"),
    warn: (event, data) => logger.warn({ ...data, event }, "dialogue"),
  },
};

// Planless durable jobs (guardian opt-in expiry, spec 4.3).
app.runtime.setPlanlessJobHandler(async (job) => {
  if (job.kind === "optin_expire" && job.payload) {
    await handleOptinExpire(ports, job.payload as { userId: string; guardianId: string });
    return;
  }
  logger.warn({ jobId: job.id, kind: job.kind }, "planless job has no handler");
});

// Inbound: dedupe already happened in the gateway loop (spec 8.4 step 4). Never throw out of here.
app.onInbound(async (m: NormalizedInbound) => {
  const msg: InboundMessage = m.message;
  try {
    const r = await handleInbound(ports, msg);
    logger.info({ id: msg.id, from: last4(msg.from), kind: msg.content.kind, route: r.route }, "inbound handled");
  } catch (err) {
    logger.error({ id: msg.id, from: last4(msg.from), error: describeError(err) }, "inbound handler failed");
    // I16: during an active plan, fail toward the user with a plain check-in.
    try {
      const user = repo.getUserByAddress(store, msg.from);
      const plan = user ? repo.getOpenPlanForUser(store, user.id) : null;
      if (plan) await app.runtime.dispatch(plan.id, { type: "internal_error", message: describeError(err).message });
    } catch (inner) {
      logger.error({ error: describeError(inner) }, "internal_error dispatch failed");
    }
  }
});

process.on("unhandledRejection", (reason) => logger.error({ error: describeError(reason) }, "unhandled rejection"));

try {
  await app.start();
  logger.info({ line: last4(env.BATMAN_LINE_E164), llm: env.LLM_PROVIDER, caps: app.caps }, "Batman is listening");
} catch (err) {
  logger.error({ error: describeError(err) }, "startup failed");
  await app.stop("startup failed").catch(() => {});
  process.exit(1);
}
