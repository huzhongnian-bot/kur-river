ALTER TABLE "memories" ADD COLUMN "kind" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "covers_count" integer;