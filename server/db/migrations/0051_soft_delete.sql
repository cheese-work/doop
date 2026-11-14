ALTER TABLE "canvases" ADD COLUMN "deleted_pages" jsonb;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "deleted_at" bigint;