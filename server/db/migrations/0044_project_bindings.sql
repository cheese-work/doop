CREATE TABLE "project_bindings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"bound_by" text NOT NULL,
	"bound_at" bigint NOT NULL
);
