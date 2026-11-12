CREATE TABLE IF NOT EXISTS "automation_approvals" (
	"automation_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"approved_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "state" jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "lease_until" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "trigger" jsonb DEFAULT '{"type":"schedule"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "approval_since" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "automation_approvals_event_idx" ON "automation_approvals" USING btree ("automation_id","frame_id","approved_at");
--> statement-breakpoint
UPDATE "automation_runs" SET "status" = 'failed', "error" = 'The server restarted before this legacy run completed.', "ended_at" = (extract(epoch from now()) * 1000)::bigint WHERE "status" = 'running' AND "state" IS NULL;
