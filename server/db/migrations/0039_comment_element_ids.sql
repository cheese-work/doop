ALTER TABLE "comments" ALTER COLUMN "selector" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "element_id" text;