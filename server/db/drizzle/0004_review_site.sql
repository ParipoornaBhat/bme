CREATE TABLE "review_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(40) NOT NULL,
	"display_name" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"role" varchar(16) DEFAULT 'reviewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "review_account_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "review_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar(32) NOT NULL,
	"reviewer" varchar(40) NOT NULL,
	"base_annotator" varchar(64),
	"labels_gz_b64" text NOT NULL,
	"note" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"kind" varchar(16) DEFAULT 'review' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"applied_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "review_scan" (
	"case_id" varchar(32) PRIMARY KEY NOT NULL,
	"drive_file_id" varchar(128) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_annotation" ADD COLUMN "labels_gz_b64" text;--> statement-breakpoint
CREATE UNIQUE INDEX "review_edit_case_reviewer_open_idx" ON "review_edit" USING btree ("case_id","reviewer") WHERE "review_edit"."status" = 'open';