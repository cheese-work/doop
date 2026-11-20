CREATE TABLE "design_attestations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"frame_updated_at" bigint NOT NULL,
	"ruleset" text NOT NULL,
	"scan_hash" text,
	"inputs" jsonb NOT NULL,
	"result" text NOT NULL,
	"missing" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "multica_task_id" text;--> statement-breakpoint
CREATE INDEX "design_attestations_run_idx" ON "design_attestations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "design_attestations_page_idx" ON "design_attestations" USING btree ("canvas_id","page_id");