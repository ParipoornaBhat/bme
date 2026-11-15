CREATE TABLE "case_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar(32) NOT NULL,
	"reviewer" varchar(40) NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(24) NOT NULL,
	"locked" boolean DEFAULT true NOT NULL,
	"marked_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "case_review_case_reviewer_idx" ON "case_review" USING btree ("case_id","reviewer");
