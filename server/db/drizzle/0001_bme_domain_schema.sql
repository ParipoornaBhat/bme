-- pgvector backs series_embedding and report_chunk.
-- Declared here, not only in the container initdb script: that script runs
-- solely on first init of an empty volume, so it would not fire on an
-- existing database or on hosted Postgres (Neon, RDS).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."annotation_source" AS ENUM('human', 'model', 'model_corrected');--> statement-breakpoint
CREATE TYPE "public"."case_class" AS ENUM('bme', 'non_bme', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sequence_kind" AS ENUM('edema', 't1', 't2', 'pd', 'other', 'unknown');--> statement-breakpoint
CREATE TABLE "annotation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"author_id" text,
	"source" "annotation_source" DEFAULT 'human' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_id" uuid,
	"format" varchar(16) DEFAULT 'dicom_seg' NOT NULL,
	"storage_key" text NOT NULL,
	"label_schema" jsonb,
	"minutes_spent" integer,
	"confidence" integer,
	"is_gold_standard" boolean DEFAULT false NOT NULL,
	"reviewed_by" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"requested_by" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"stage" varchar(32),
	"progress" real DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prediction_id" uuid NOT NULL,
	"bone_label" varchar(32),
	"volume_mm3" real NOT NULL,
	"max_diameter_mm" real,
	"percent_of_bone" real,
	"centroid_x" real,
	"centroid_y" real,
	"centroid_z" real,
	"mean_si_ratio" real,
	"max_si_ratio" real,
	"confidence" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" varchar(32) NOT NULL,
	"case_class" "case_class" DEFAULT 'unknown' NOT NULL,
	"source_hash" varchar(64),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "patient_case_id_unique" UNIQUE("case_id")
);
--> statement-breakpoint
CREATE TABLE "prediction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"model_name" varchar(64) NOT NULL,
	"model_version" varchar(32) NOT NULL,
	"threshold" real,
	"min_component_mm3" real,
	"bone_mask_key" text,
	"lesion_mask_key" text,
	"mesh_key" text,
	"uncertainty_key" text,
	"bme_present" boolean,
	"case_confidence" real,
	"total_lesion_volume_mm3" real,
	"lesion_count" integer,
	"metrics" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"series_uid" varchar(128),
	"kind" "sequence_kind" DEFAULT 'unknown' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"description" varchar(128),
	"plane" varchar(16),
	"rows" integer,
	"cols" integer,
	"n_instances" integer,
	"slice_thickness" real,
	"pixel_spacing_x" real,
	"pixel_spacing_y" real,
	"repetition_time" real,
	"echo_time" real,
	"inversion_time" real,
	"fat_suppressed" boolean DEFAULT false NOT NULL,
	"nifti_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series_embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"model_version" varchar(64) NOT NULL,
	"embedding" vector(512) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"study_uid" varchar(128),
	"body_part" varchar(32),
	"manufacturer" varchar(64),
	"model_name" varchar(64),
	"field_strength" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation" ADD CONSTRAINT "annotation_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesion" ADD CONSTRAINT "lesion_prediction_id_prediction_id_fk" FOREIGN KEY ("prediction_id") REFERENCES "public"."prediction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction" ADD CONSTRAINT "prediction_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction" ADD CONSTRAINT "prediction_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_chunk" ADD CONSTRAINT "report_chunk_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_study_id_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_embedding" ADD CONSTRAINT "series_embedding_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study" ADD CONSTRAINT "study_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotation_series_idx" ON "annotation" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "annotation_author_idx" ON "annotation" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "annotation_source_idx" ON "annotation" USING btree ("source");--> statement-breakpoint
CREATE INDEX "job_series_idx" ON "job" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "job_status_idx" ON "job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lesion_prediction_idx" ON "lesion" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX "lesion_bone_idx" ON "lesion" USING btree ("bone_label");--> statement-breakpoint
CREATE INDEX "patient_class_idx" ON "patient" USING btree ("case_class");--> statement-breakpoint
CREATE INDEX "prediction_series_idx" ON "prediction" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "prediction_job_idx" ON "prediction" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "report_chunk_patient_idx" ON "report_chunk" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "report_chunk_hnsw" ON "report_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "series_study_idx" ON "series" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "series_kind_idx" ON "series" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "series_primary_idx" ON "series" USING btree ("study_id") WHERE "series"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "series_embedding_unique" ON "series_embedding" USING btree ("series_id","model_version");--> statement-breakpoint
CREATE INDEX "series_embedding_hnsw" ON "series_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "study_patient_idx" ON "study" USING btree ("patient_id");