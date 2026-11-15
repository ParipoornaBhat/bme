import { db, annotationEvent } from "@bme/db";

export type AnnotationEventAction =
  | "save"
  | "push"
  | "pull"
  | "review-submit"
  | "team-submit"
  | "supersede"
  | "review-apply"
  | "review-dismiss"
  | "retire-local"
  | "delete"
  | "restore"
  | "set-main"
  | "owner-set";

export interface NewAnnotationEvent {
  caseId: string;
  annotator?: string | null;
  actor?: string | null;
  action: AnnotationEventAction | string;
  sha256?: string | null;
  details?: unknown;
  at?: Date;
}

/**
 * Batch insert events into annotation_event.
 * Swallows errors so logging never breaks a save, sync, or mutation.
 */
export async function logEvents(rows: NewAnnotationEvent[]): Promise<void> {
  if (!rows || rows.length === 0) return;
  try {
    const formatted = rows.map((r) => ({
      caseId: r.caseId,
      annotator: r.annotator ?? null,
      actor: r.actor ?? null,
      action: r.action,
      sha256: r.sha256 ?? null,
      details: r.details !== undefined ? r.details : null,
      at: r.at ?? new Date(),
    }));
    await db.insert(annotationEvent).values(formatted);
  } catch (err) {
    // Swallow errors so logging never breaks a save or sync
    console.error("Failed to log annotation events:", err);
  }
}

export async function logEvent(row: NewAnnotationEvent): Promise<void> {
  return logEvents([row]);
}
