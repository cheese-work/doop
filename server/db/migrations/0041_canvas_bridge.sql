CREATE TABLE IF NOT EXISTS "canvas_bridge" (
	"canvas_id" text PRIMARY KEY NOT NULL,
	"agent_ref" text,
	"agent_name" text,
	"agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"watcher_seen_at" bigint,
	"updated_by" text,
	"updated_at" bigint NOT NULL
);
