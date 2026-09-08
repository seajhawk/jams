import { relations, sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const planEnum = pgEnum("plan", ["free"])
export const webhookSourceEnum = pgEnum("webhook_source", ["clerk", "stripe"])
export const videoStatusEnum = pgEnum("video_status", [
  "uploading",
  "uploaded",
  "failed",
])
export const analysisStatusEnum = pgEnum("analysis_status", [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
])
export const dispatchStatusEnum = pgEnum("dispatch_status", [
  "pending",
  "dispatched",
  "failed",
])
export const analysisErrorCodeEnum = pgEnum("analysis_error_code", [
  "no_audio",
  "too_long",
  "corrupt_file",
  "transient",
  "unknown",
])
export const measureCategoryEnum = pgEnum("measure_category", [
  "physical",
  "cognitive",
  "time",
  "sentiment",
  "speech",
])
export const measureSourceEnum = pgEnum("measure_source", [
  "video_analysis",
  "telemetry",
  "manual",
])
export const segmentSourceEnum = pgEnum("segment_source", [
  "audio_cue",
  "scene_boundary",
  "llm",
  "manual",
])

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isPersonal: boolean("is_personal").notNull().default(false),
  plan: planEnum("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  ...timestamps,
})

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  ...timestamps,
})

export const webhookEvents = pgTable(
  "webhook_events",
  {
    source: webhookSourceEnum("source").notNull(),
    externalId: text("external_id").primaryKey(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("webhook_events_external_id_idx").on(table.externalId)]
)

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tasks_org_id_name_idx").on(table.orgId, table.name),
    index("tasks_org_id_idx").on(table.orgId),
  ]
)

export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    blobPath: text("blob_path").notNull(),
    posterBlobPath: text("poster_blob_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    contentType: text("content_type"),
    durationMs: integer("duration_ms"),
    width: integer("width"),
    height: integer("height"),
    fps: real("fps"),
    hasAudio: boolean("has_audio"),
    subjectLabel: text("subject_label"),
    variantLabel: text("variant_label"),
    status: videoStatusEnum("status").notNull().default("uploading"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("videos_org_id_created_at_idx").on(table.orgId, table.createdAt.desc()),
    index("videos_org_id_task_id_idx").on(table.orgId, table.taskId),
    check(
      "videos_status_check",
      sql`${table.status} in ('uploading', 'uploaded', 'failed')`
    ),
  ]
)

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    configSource: text("config_source"),
    pipelineVersion: text("pipeline_version").notNull(),
    providerVersions: jsonb("provider_versions").notNull().default({}),
    providerResults: jsonb("provider_results").notNull().default({}),
    status: analysisStatusEnum("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progressPct: integer("progress_pct").notNull().default(0),
    stageDetail: text("stage_detail"),
    errorCode: analysisErrorCodeEnum("error_code"),
    attempt: integer("attempt").notNull().default(0),
    ownerId: text("owner_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => analysisRuns.id,
      { onDelete: "set null" }
    ),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("analysis_runs_org_id_video_id_idx").on(table.orgId, table.videoId),
    index("analysis_runs_org_id_status_idx").on(table.orgId, table.status),
    index("analysis_runs_superseded_by_idx").on(table.supersededBy),
    index("analysis_runs_lease_expires_at_idx").on(table.leaseExpiresAt),
    check(
      "analysis_runs_progress_pct_check",
      sql`${table.progressPct} >= 0 and ${table.progressPct} <= 100`
    ),
  ]
)

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("share_links_token_idx").on(table.token),
    index("share_links_org_id_run_id_idx").on(table.orgId, table.runId),
  ]
)

export const analysisArtifacts = pgTable(
  "analysis_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    blobPath: text("blob_path").notNull(),
    attempt: integer("attempt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("analysis_artifacts_org_id_run_id_idx").on(table.orgId, table.runId),
    index("analysis_artifacts_run_id_kind_idx").on(table.runId, table.kind),
  ]
)

export const analysisDispatchOutbox = pgTable(
  "analysis_dispatch_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    status: dispatchStatusEnum("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    lastError: text("last_error"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("analysis_dispatch_outbox_status_created_at_idx").on(
      table.status,
      table.createdAt
    ),
    index("analysis_dispatch_outbox_status_lease_idx").on(
      table.status,
      table.leaseExpiresAt
    ),
    index("analysis_dispatch_outbox_org_id_idx").on(table.orgId),
    index("analysis_dispatch_outbox_run_id_idx").on(table.runId),
  ]
)

export const measures = pgTable(
  "measures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    kind: text("kind").notNull(),
    category: measureCategoryEnum("category").notNull(),
    tStartMs: integer("t_start_ms").notNull(),
    tEndMs: integer("t_end_ms"),
    valueNum: real("value_num"),
    valueText: text("value_text"),
    unit: text("unit"),
    confidence: real("confidence"),
    source: measureSourceEnum("source").notNull(),
    providerId: text("provider_id").notNull(),
    providerVersion: text("provider_version").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("measures_run_id_kind_t_start_ms_idx").on(
      table.runId,
      table.kind,
      table.tStartMs
    ),
    index("measures_org_id_kind_idx").on(table.orgId, table.kind),
    check("measures_t_start_ms_check", sql`${table.tStartMs} >= 0`),
    check(
      "measures_t_end_ms_check",
      sql`${table.tEndMs} is null or ${table.tEndMs} >= ${table.tStartMs}`
    ),
  ]
)

export const segments = pgTable(
  "segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    parentSegmentId: uuid("parent_segment_id").references(
      (): AnyPgColumn => segments.id,
      { onDelete: "set null" }
    ),
    name: text("name").notNull(),
    tStartMs: integer("t_start_ms").notNull(),
    tEndMs: integer("t_end_ms").notNull(),
    source: segmentSourceEnum("source").notNull(),
    thumbnail: text("thumbnail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("segments_org_id_run_id_idx").on(table.orgId, table.runId),
    index("segments_run_id_t_start_ms_idx").on(table.runId, table.tStartMs),
    check("segments_t_start_ms_check", sql`${table.tStartMs} >= 0`),
    check("segments_t_end_ms_check", sql`${table.tEndMs} > ${table.tStartMs}`),
  ]
)

export const weightProfiles = pgTable(
  "weight_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    weights: jsonb("weights").notNull(),
    normalization: jsonb("normalization").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("weight_profiles_org_id_name_idx").on(table.orgId, table.name),
    uniqueIndex("weight_profiles_org_id_default_idx")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
    index("weight_profiles_org_id_idx").on(table.orgId),
  ]
)

export const effortScores = pgTable(
  "effort_scores",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => weightProfiles.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    physical: integer("physical").notNull(),
    cognitive: integer("cognitive").notNull(),
    time: integer("time").notNull(),
    sentiment: integer("sentiment").notNull(),
    speech: integer("speech").notNull(),
    total: integer("total").notNull(),
    breakdown: jsonb("breakdown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.profileId] }),
    index("effort_scores_org_id_run_id_idx").on(table.orgId, table.runId),
  ]
)

export const orgRelations = relations(orgs, () => ({}))
export const userRelations = relations(users, () => ({}))
export const taskRelations = relations(tasks, ({ many }) => ({
  videos: many(videos),
}))
export const videoRelations = relations(videos, ({ one, many }) => ({
  task: one(tasks, {
    fields: [videos.taskId],
    references: [tasks.id],
  }),
  analysisRuns: many(analysisRuns),
}))
export const analysisRunRelations = relations(analysisRuns, ({ one, many }) => ({
  video: one(videos, {
    fields: [analysisRuns.videoId],
    references: [videos.id],
  }),
  supersededByRun: one(analysisRuns, {
    fields: [analysisRuns.supersededBy],
    references: [analysisRuns.id],
  }),
  shareLinks: many(shareLinks),
  artifacts: many(analysisArtifacts),
  dispatchOutbox: many(analysisDispatchOutbox),
  measures: many(measures),
  segments: many(segments),
  effortScores: many(effortScores),
}))
export const analysisDispatchOutboxRelations = relations(
  analysisDispatchOutbox,
  ({ one }) => ({
    run: one(analysisRuns, {
      fields: [analysisDispatchOutbox.runId],
      references: [analysisRuns.id],
    }),
  })
)
export const shareLinkRelations = relations(shareLinks, ({ one }) => ({
  run: one(analysisRuns, {
    fields: [shareLinks.runId],
    references: [analysisRuns.id],
  }),
}))
export const analysisArtifactRelations = relations(analysisArtifacts, ({ one }) => ({
  run: one(analysisRuns, {
    fields: [analysisArtifacts.runId],
    references: [analysisRuns.id],
  }),
}))
export const measureRelations = relations(measures, ({ one }) => ({
  run: one(analysisRuns, {
    fields: [measures.runId],
    references: [analysisRuns.id],
  }),
}))
export const segmentRelations = relations(segments, ({ one }) => ({
  run: one(analysisRuns, {
    fields: [segments.runId],
    references: [analysisRuns.id],
  }),
  parent: one(segments, {
    fields: [segments.parentSegmentId],
    references: [segments.id],
  }),
}))
export const weightProfileRelations = relations(weightProfiles, ({ many }) => ({
  effortScores: many(effortScores),
}))
export const effortScoreRelations = relations(effortScores, ({ one }) => ({
  run: one(analysisRuns, {
    fields: [effortScores.runId],
    references: [analysisRuns.id],
  }),
  profile: one(weightProfiles, {
    fields: [effortScores.profileId],
    references: [weightProfiles.id],
  }),
}))
