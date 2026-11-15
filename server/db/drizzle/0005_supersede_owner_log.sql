CREATE TABLE "annotation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"case_id" varchar(32) NOT NULL,
	"annotator" varchar(64),
	"actor" varchar(64),
	"action" varchar(32) NOT NULL,
	"sha256" varchar(64),
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "case_owner" (
	"case_id" varchar(32) PRIMARY KEY NOT NULL,
	"annotated_by" varchar(64),
	"source" varchar(16) NOT NULL,
	"set_by" varchar(64),
	"set_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_edit_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_edit_id" uuid NOT NULL,
	"labels_gz_b64" text NOT NULL,
	"note" text,
	"saved_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_annotation" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "case_annotation" ADD COLUMN "deleted_by" varchar(64);--> statement-breakpoint
ALTER TABLE "case_annotation" ADD COLUMN "deleted_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "case_annotation" ADD COLUMN "superseded_by" varchar(64);--> statement-breakpoint
ALTER TABLE "review_edit" ADD COLUMN "applied_by" varchar(64);--> statement-breakpoint
ALTER TABLE "review_edit" ADD COLUMN "claim_token" varchar(64);--> statement-breakpoint
ALTER TABLE "review_edit_version" ADD CONSTRAINT "review_edit_version_review_edit_id_review_edit_id_fk" FOREIGN KEY ("review_edit_id") REFERENCES "public"."review_edit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotation_event_case_at_idx" ON "annotation_event" USING btree ("case_id","at");--> statement-breakpoint
CREATE INDEX "annotation_event_at_idx" ON "annotation_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "review_edit_version_edit_idx" ON "review_edit_version" USING btree ("review_edit_id");
