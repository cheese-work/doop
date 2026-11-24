CREATE TABLE "frame_pin_frames" (
	"frame_id" text PRIMARY KEY NOT NULL,
	"card_request_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frame_pins" (
	"card_request_id" text PRIMARY KEY NOT NULL,
	"pin_id" text NOT NULL,
	"state" text NOT NULL,
	"frames" jsonb NOT NULL,
	"pick_request_id" text,
	"picked_frame_id" text,
	"r1" text,
	"r2" text,
	"release_reason" text,
	"state_changed_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "frame_pins_pin_id_unique" UNIQUE("pin_id")
);
--> statement-breakpoint
ALTER TABLE "frame_pin_frames" ADD CONSTRAINT "frame_pin_frames_card_request_id_frame_pins_card_request_id_fk" FOREIGN KEY ("card_request_id") REFERENCES "public"."frame_pins"("card_request_id") ON DELETE no action ON UPDATE no action;