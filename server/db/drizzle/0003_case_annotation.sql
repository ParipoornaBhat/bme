CREATE TABLE "case_annotation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar(32) NOT NULL,
	"annotator" varchar(64) NOT NULL,
	"content_b64" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"bytes" integer NOT NULL,
	"scan_fingerprint" varchar(64),
	"has_bone" boolean DEFAULT false NOT NULL,
	"saved_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "case_annotation_case_annotator_idx" ON "case_annotation" USING btree ("case_id","annotator");--> statement-breakpoint
CREATE INDEX "case_annotation_updated_at_idx" ON "case_annotation" USING btree ("updated_at");
