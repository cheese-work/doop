CREATE TABLE "page_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"page_name" text NOT NULL,
	"name" text NOT NULL,
	"author" text NOT NULL,
	"author_kind" text,
	"created_at" bigint NOT NULL,
	"frames" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_blobs" (
	"canvas_id" text NOT NULL,
	"hash" text NOT NULL,
	"html" text NOT NULL,
	CONSTRAINT "snapshot_blobs_canvas_id_hash_pk" PRIMARY KEY("canvas_id","hash")
);
--> statement-breakpoint
CREATE INDEX "page_snapshots_canvas_idx" ON "page_snapshots" USING btree ("canvas_id","page_id");