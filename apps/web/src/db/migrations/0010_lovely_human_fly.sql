CREATE TABLE "user_provisioning_locks" (
	"user_id" text PRIMARY KEY NOT NULL,
	"locked_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claim_token" text;