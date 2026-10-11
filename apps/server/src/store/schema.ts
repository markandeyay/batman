// Drizzle schema for every table in spec 12, plus the plan columns the engine needs
// (store/migrations.ts holds the matching SQL; a unit test keeps them in sync).
// Times are integer milliseconds since epoch (UTC). Booleans are 0/1 integers.
import { sql } from "drizzle-orm";
import { getTableConfig, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const bool = (name: string) => integer(name, { mode: "boolean" });

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  addressE164: text("address_e164").notNull().unique(),
  displayName: text("display_name"),
  tz: text("tz"),
  onboardingStep: text("onboarding_step").notNull().default("new"),
  /** sha256 of the normalized exit phrase (spec 12: code words stored hashed). */
  exitPhraseHash: text("exit_phrase_hash"),
  /** Normalized exit phrase, needed for fuzzy matching (spec 9.1). Never logged. */
  exitPhraseNorm: text("exit_phrase_norm"),
  alertPhraseHash: text("alert_phrase_hash"),
  alertPhraseNorm: text("alert_phrase_norm"),
  decoyCaller: text("decoy_caller", { enum: ["mom", "roommate", "boss"] }).notNull().default("roommate"),
  homeLat: real("home_lat"),
  homeLng: real("home_lng"),
  replyWithVoice: bool("reply_with_voice").notNull().default(false),
  createdAt: ts("created_at").notNull(),
  deletedAt: ts("deleted_at"),
});

export const guardians = sqliteTable("guardians", {
  id: text("id").primaryKey(),
  addressE164: text("address_e164").notNull().unique(),
  displayName: text("display_name"),
  createdAt: ts("created_at").notNull(),
  stoppedAt: ts("stopped_at"),
});

export const userGuardians = sqliteTable(
  "user_guardians",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    guardianId: text("guardian_id")
      .notNull()
      .references(() => guardians.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "accepted", "declined", "expired", "revoked"] }).notNull(),
    requestedAt: ts("requested_at").notNull(),
    respondedAt: ts("responded_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.guardianId] })],
);

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    guardianId: text("guardian_id").references(() => guardians.id, { onDelete: "set null" }),
    state: text("state").notNull(),
    type: text("type"),
    startAt: ts("start_at"),
    endAt: ts("end_at"),
    graceMin: integer("grace_min").notNull(),
    venueText: text("venue_text"),
    venueLat: real("venue_lat"),
    venueLng: real("venue_lng"),
    venuePlaceType: text("venue_place_type"),
    counterpartName: text("counterpart_name"),
    counterpartSource: text("counterpart_source"),
    transport: text("transport"),
    firstTimeInPerson: bool("first_time_in_person"),
    buyOrSell: text("buy_or_sell"),
    privateAddress: bool("private_address"),
    userNervous: bool("user_nervous").notNull().default(false),
    highVigilance: bool("high_vigilance").notNull().default(false),
    notifyGuardianStartEnd: bool("notify_guardian_start_end").notNull().default(false),
    locationMode: text("location_mode", { enum: ["findmy", "pin", "none"] }).notNull().default("findmy"),
    ladderStep: text("ladder_step"),
    ladderClass: text("ladder_class"),
    ladderTrigger: text("ladder_trigger"),
    ladderStartedAt: ts("ladder_started_at"),
    ladderStepAt: ts("ladder_step_at"),
    escalatedAt: ts("escalated_at"),
    escalationReasonJson: text("escalation_reason_json"),
    guardianAckAt: ts("guardian_ack_at"),
    arrivedAt: ts("arrived_at"),
    arrivalLineSent: bool("arrival_line_sent").notNull().default(false),
    totalExtensionMin: integer("total_extension_min").notNull().default(0),
    suppressedUntilJson: text("suppressed_until_json").notNull().default("{}"),
    exitWordAt: ts("exit_word_at"),
    lastCheckinMessageId: text("last_checkin_message_id"),
    lastCheckinAt: ts("last_checkin_at"),
    guardianRepeatCount: integer("guardian_repeat_count").notNull().default(0),
    lastGuardianUpdateAt: ts("last_guardian_update_at"),
    lastGuardianUpdateLat: real("last_guardian_update_lat"),
    lastGuardianUpdateLng: real("last_guardian_update_lng"),
    locRequestedAt: ts("loc_requested_at"),
    shareConfirmedAt: ts("share_confirmed_at"),
    shareExpiresAt: ts("share_expires_at"),
    lastResolvedAt: ts("last_resolved_at"),
    /** PlanFlags and PendingSpot (plan/types.ts). */
    engineStateJson: text("engine_state_json").notNull().default("{}"),
    closedAt: ts("closed_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("plans_user_state").on(t.userId, t.state)],
);

export const planEvents = sqliteTable(
  "plan_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    at: ts("at").notNull(),
    kind: text("kind").notNull(),
    dataJson: text("data_json"),
  },
  (t) => [index("plan_events_plan").on(t.planId, t.at)],
);

export const locationFixes = sqliteTable(
  "location_fixes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    at: ts("at").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    accuracyM: real("accuracy_m").notNull(),
    locationType: text("location_type").notNull(),
    source: text("source").notNull(),
    expiresAt: ts("expires_at"),
    receivedAt: ts("received_at").notNull(),
  },
  (t) => [index("location_fixes_plan").on(t.planId, t.at)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runAt: ts("run_at").notNull(),
    kind: text("kind").notNull(),
    planId: text("plan_id"),
    payloadJson: text("payload_json"),
    status: text("status", { enum: ["pending", "running", "done", "failed", "cancelled"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("jobs_due").on(t.status, t.runAt), index("jobs_plan").on(t.planId, t.status)],
);

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  platformMessageId: text("platform_message_id").unique(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  addressE164: text("address_e164").notNull(),
  planId: text("plan_id"),
  kind: text("kind").notNull(),
  /** Body with code words replaced by [code] (spec 12). */
  bodyRedacted: text("body_redacted"),
  sentAt: ts("sent_at").notNull(),
});

export const processedInbound = sqliteTable("processed_inbound", {
  messageId: text("message_id").primaryKey(),
  at: ts("at").notNull(),
});

export const counters = sqliteTable(
  "counters",
  {
    day: text("day").notNull(),
    key: text("key").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.key] })],
);

/** M2 (I16): outbound effects written with the plan update, drained after commit, replayed on boot. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    effectJson: text("effect_json").notNull(),
    status: text("status", { enum: ["pending", "sending", "done"] }).notNull(),
    createdAt: ts("created_at").notNull(),
    doneAt: ts("done_at"),
  },
  (t) => [index("outbox_pending").on(t.status, t.createdAt)],
);

export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  acquiredAt: ts("acquired_at").notNull(),
  heartbeatAt: ts("heartbeat_at").notNull(),
});

export const schemaVersion = sqliteTable("schema_version", {
  version: integer("version").primaryKey(),
  appliedAt: integer("applied_at").notNull().default(sql`0`),
});

export const ALL_TABLES = {
  users,
  guardians,
  user_guardians: userGuardians,
  plans,
  plan_events: planEvents,
  location_fixes: locationFixes,
  jobs,
  messages,
  processed_inbound: processedInbound,
  counters,
  locks,
  outbox,
  schema_version: schemaVersion,
} as const;

/** Column names per table as Drizzle sees them (used to check migrations stay in sync). */
export function drizzleColumns(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, table] of Object.entries(ALL_TABLES)) {
    const cfg = getTableConfig(table);
    out[cfg.name] = cfg.columns.map((c) => c.name);
    if (cfg.name !== name) throw new Error(`table key ${name} does not match ${cfg.name}`);
  }
  return out;
}
