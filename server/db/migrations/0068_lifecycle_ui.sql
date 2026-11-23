ALTER TABLE "comments" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolution_ref" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "locked_at" bigint;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "lock_reason" text;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "archive_origin" jsonb;