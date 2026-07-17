import { relations, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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

export const orgRelations = relations(orgs, () => ({}))
export const userRelations = relations(users, () => ({}))
export const taskRelations = relations(tasks, ({ many }) => ({
  videos: many(videos),
}))
export const videoRelations = relations(videos, ({ one }) => ({
  task: one(tasks, {
    fields: [videos.taskId],
    references: [tasks.id],
  }),
}))
