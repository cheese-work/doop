CREATE TABLE "page_authors" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"frame_id" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text DEFAULT '' NOT NULL,
	"task_id" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"source_page_id" text DEFAULT '' NOT NULL,
	"first_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "page_authors_writer_uniq" ON "page_authors" USING btree ("canvas_id","page_id","kind","agent_id","task_id","user_id","source","source_page_id");--> statement-breakpoint
CREATE INDEX "page_authors_page_idx" ON "page_authors" USING btree ("canvas_id","page_id");