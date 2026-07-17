import { relations } from "drizzle-orm"
import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

export const planEnum = pgEnum("plan", ["free"])
export const webhookSourceEnum = pgEnum("webhook_source", ["clerk", "stripe"])

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

export const orgRelations = relations(orgs, () => ({}))
export const userRelations = relations(users, () => ({}))
