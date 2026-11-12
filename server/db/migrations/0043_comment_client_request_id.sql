ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "client_request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "comments_thread_request_idx" ON "comments" USING btree ("parent_id","client_request_id") WHERE "comments"."client_request_id" is not null;
