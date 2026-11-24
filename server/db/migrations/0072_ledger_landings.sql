CREATE TABLE IF NOT EXISTS "ledger_landings" (
	"id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"merge_sha" text NOT NULL,
	"lock_path" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"source_page_id" text NOT NULL,
	"ledger_page_id" text NOT NULL,
	"label" text NOT NULL,
	"topic_issue_id" text NOT NULL,
	"close_decision_id" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"frames" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ledger_landings_canvas_id_merge_sha_lock_path_pk" PRIMARY KEY("canvas_id","merge_sha","lock_path")
);
