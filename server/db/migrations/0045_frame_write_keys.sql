CREATE TABLE IF NOT EXISTS "frame_write_keys" (
	"frame_id" text NOT NULL,
	"key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"version_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "frame_write_keys_frame_id_key_pk" PRIMARY KEY("frame_id","key")
);
--> statement-breakpoint
ALTER TABLE "frame_versions" ADD COLUMN IF NOT EXISTS "name" text;
