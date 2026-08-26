/**
 * BME domain schema.
 *
 * Everything here is deliberately pseudonymous. No patient name, MRN, date of
 * birth, institution, or accession number is ever stored — the ID-to-name
 * mapping lives in `data/deid_map.csv` on a local machine and never reaches a
 * database. See CLAUDE.md §1.
 *
 * Shape follows the pipeline in docs/PRD.md:
 *   patient -> study -> series -> { annotation, job -> prediction -> lesion }
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { user } from "./auth.js";

// ---------------------------------------------------------------- enums

export const caseClassEnum = pgEnum("case_class", ["bme", "non_bme", "unknown"]);

/** Physics-derived sequence kind. See ml/scripts/inventory.py. */
export const sequenceKindEnum = pgEnum("sequence_kind", [
  "edema", // fat-suppressed PD/T2, or STIR/TIRM — the primary channel
  "t1",
  "t2",
  "pd",
  "other",
  "unknown",
]);

export const annotationSourceEnum = pgEnum("annotation_source", [
  "human", // drawn in 3D Slicer or the web editor
  "model", // raw model output
  "model_corrected", // model output a human edited — the interesting one
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

// ---------------------------------------------------------------- patient

export const patient = pgTable(
  "patient",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Pseudonymous ID, e.g. BME-001 / NBME-042. The only identifier we hold. */
    caseId: varchar("case_id", { length: 32 }).notNull().unique(),
    caseClass: caseClassEnum("case_class").notNull().default("unknown"),
    /** Original archive name is PHI — store a hash so re-imports can be matched. */
    sourceHash: varchar("source_hash", { length: 64 }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (t) => [index("patient_class_idx").on(t.caseClass)],
);

// ---------------------------------------------------------------- study

export const study = pgTable(
  "study",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    /** Re-mapped UID from de-identification, not the original. */
    studyUid: varchar("study_uid", { length: 128 }),
    bodyPart: varchar("body_part", { length: 32 }),
    manufacturer: varchar("manufacturer", { length: 64 }),
    modelName: varchar("model_name", { length: 64 }),
    fieldStrength: real("field_strength"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("study_patient_idx").on(t.patientId)],
);

// ---------------------------------------------------------------- series

export const series = pgTable(
  "series",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => study.id, { onDelete: "cascade" }),
    seriesUid: varchar("series_uid", { length: 128 }),
    kind: sequenceKindEnum("kind").notNull().default("unknown"),
    /**
     * The series to annotate and run the model on. Exactly one per study.
     * Without this a 16-series case gives an annotator no idea where to start.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    description: varchar("description", { length: 128 }),
    plane: varchar("plane", { length: 16 }), // axial | coronal | sagittal
    rows: integer("rows"),
    cols: integer("cols"),
    nInstances: integer("n_instances"),
    sliceThickness: real("slice_thickness"),
    pixelSpacingX: real("pixel_spacing_x"),
    pixelSpacingY: real("pixel_spacing_y"),
    repetitionTime: real("repetition_time"),
    echoTime: real("echo_time"),
    inversionTime: real("inversion_time"),
    fatSuppressed: boolean("fat_suppressed").notNull().default(false),
    /** Object-store key for the converted NIfTI. Pixels never live in Postgres. */
    niftiKey: text("nifti_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("series_study_idx").on(t.studyId),
    index("series_kind_idx").on(t.kind),
    // Partial unique: at most one primary series per study.
    uniqueIndex("series_primary_idx").on(t.studyId).where(sql`${t.isPrimary}`),
  ],
);

// ---------------------------------------------------------------- annotation

export const annotation = pgTable(
  "annotation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    source: annotationSourceEnum("source").notNull().default("human"),
    /**
     * Versioned, never overwritten — `parentId` chains an edit to what it came
     * from. This is what lets you measure how much a human changed the model's
     * output, which is a real result and free once versioning exists.
     */
    version: integer("version").notNull().default(1),
    parentId: uuid("parent_id"),
    /** dicom_seg | seg_nrrd | nifti — see PRD §7.6. */
    format: varchar("format", { length: 16 }).notNull().default("dicom_seg"),
    storageKey: text("storage_key").notNull(),
    /** { "1": "bone_marrow", "2": "bme", "3": "uncertain" } — keyed by name, never order. */
    labelSchema: jsonb("label_schema"),
    minutesSpent: integer("minutes_spent"),
    /** Annotator self-rating 1-5. Lets you check if the model fails where humans hesitated. */
    confidence: integer("confidence"),
    isGoldStandard: boolean("is_gold_standard").notNull().default(false),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("annotation_series_idx").on(t.seriesId),
    index("annotation_author_idx").on(t.authorId),
    index("annotation_source_idx").on(t.source),
  ],
);

// ---------------------------------------------------------------- job

export const job = pgTable(
  "job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    status: jobStatusEnum("status").notNull().default("queued"),
    /** preprocess | bone | bme | quantify — which cascade stage is running. */
    stage: varchar("stage", { length: 32 }),
    progress: real("progress").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("job_series_idx").on(t.seriesId),
    index("job_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------- prediction

export const prediction = pgTable(
  "prediction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    modelName: varchar("model_name", { length: 64 }).notNull(),
    modelVersion: varchar("model_version", { length: 32 }).notNull(),
    /** Tuned on validation, not fixed at 0.5. Stored so a result is reproducible. */
    threshold: real("threshold"),
    minComponentMm3: real("min_component_mm3"),
    boneMaskKey: text("bone_mask_key"),
    lesionMaskKey: text("lesion_mask_key"),
    meshKey: text("mesh_key"),
    uncertaintyKey: text("uncertainty_key"),
    /** Case-level call, derived from lesion volume — see PRD §4.6. */
    bmePresent: boolean("bme_present"),
    caseConfidence: real("case_confidence"),
    totalLesionVolumeMm3: real("total_lesion_volume_mm3"),
    lesionCount: integer("lesion_count"),
    metrics: jsonb("metrics"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("prediction_series_idx").on(t.seriesId),
    index("prediction_job_idx").on(t.jobId),
  ],
);

// ---------------------------------------------------------------- lesion

export const lesion = pgTable(
  "lesion",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    predictionId: uuid("prediction_id")
      .notNull()
      .references(() => prediction.id, { onDelete: "cascade" }),
    /** femur | tibia | patella — from the Stage B mask. Part of the explanation. */
    boneLabel: varchar("bone_label", { length: 32 }),
    volumeMm3: real("volume_mm3").notNull(),
    maxDiameterMm: real("max_diameter_mm"),
    percentOfBone: real("percent_of_bone"),
    centroidX: real("centroid_x"),
    centroidY: real("centroid_y"),
    centroidZ: real("centroid_z"),
    /** Signal intensity relative to muscle — how a radiologist justifies the call. */
    meanSiRatio: real("mean_si_ratio"),
    maxSiRatio: real("max_si_ratio"),
    confidence: real("confidence"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("lesion_prediction_idx").on(t.predictionId),
    index("lesion_bone_idx").on(t.boneLabel),
  ],
);

// ---------------------------------------------------------------- vectors
// Requires the pgvector extension (the dev container image ships it).
//
// Not on the critical path for detection — segmentation and quantification work
// without any of this. These exist for two genuinely useful secondary features:
//
//   seriesEmbedding : "show me cases that look like this one". Content-based
//                     retrieval from the Stage C encoder bottleneck, pooled.
//                     Useful in the UI and as a dataset-QC tool — near-duplicate
//                     cases across folds are a leak, and this finds them.
//   reportChunk     : semantic search over radiology reports, if the .docx files
//                     found in 5 archives turn out to be reports and can be
//                     obtained properly. Also a weak-label source.
//
// Dimensions are fixed at table-creation time; changing one needs a migration.

export const seriesEmbedding = pgTable(
  "series_embedding",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    /** Which encoder produced it — embeddings from different models are not comparable. */
    modelVersion: varchar("model_version", { length: 64 }).notNull(),
    embedding: vector("embedding", { dimensions: 512 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("series_embedding_unique").on(t.seriesId, t.modelVersion),
    index("series_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const reportChunk = pgTable(
  "report_chunk",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    /** Must be de-identified before it lands here. Reports name patients. */
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("report_chunk_patient_idx").on(t.patientId),
    index("report_chunk_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ---------------------------------------------------------------- relations

export const patientRelations = relations(patient, ({ many }) => ({
  studies: many(study),
  reportChunks: many(reportChunk),
}));

export const studyRelations = relations(study, ({ one, many }) => ({
  patient: one(patient, { fields: [study.patientId], references: [patient.id] }),
  series: many(series),
}));

export const seriesRelations = relations(series, ({ one, many }) => ({
  study: one(study, { fields: [series.studyId], references: [study.id] }),
  annotations: many(annotation),
  jobs: many(job),
  predictions: many(prediction),
  embeddings: many(seriesEmbedding),
}));

export const annotationRelations = relations(annotation, ({ one }) => ({
  series: one(series, { fields: [annotation.seriesId], references: [series.id] }),
  author: one(user, { fields: [annotation.authorId], references: [user.id] }),
}));

export const jobRelations = relations(job, ({ one, many }) => ({
  series: one(series, { fields: [job.seriesId], references: [series.id] }),
  predictions: many(prediction),
}));

export const predictionRelations = relations(prediction, ({ one, many }) => ({
  job: one(job, { fields: [prediction.jobId], references: [job.id] }),
  series: one(series, { fields: [prediction.seriesId], references: [series.id] }),
  lesions: many(lesion),
}));

export const lesionRelations = relations(lesion, ({ one }) => ({
  prediction: one(prediction, { fields: [lesion.predictionId], references: [prediction.id] }),
}));
