CREATE TABLE "comment_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"parent_id" text,
	"from_user_id" text,
	"at" bigint NOT NULL,
	"acked_at" bigint
);
--> statement-breakpoint
CREATE INDEX "comment_events_unacked_idx" ON "comment_events" USING btree ("canvas_id","id") WHERE "comment_events"."acked_at" is null;