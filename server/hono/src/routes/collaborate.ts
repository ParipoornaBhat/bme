import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { createSession, getSession, validatePermission } from "../lib/collab-server.js";

const app = new Hono();

const ID = /^[a-zA-Z0-9_-]+$/;

/**
 * POST /api/collaborate/session
 * Body: { caseId: string, userId?: string, userName?: string }
 * Creates a new secure collaboration session.
 */
app.post("/session", async (c) => {
  try {
    const body = await c.req.json();
    const { caseId, userId = "master_user", userName = "Dr. Master" } = body;

    if (!caseId || !ID.test(caseId)) {
      return c.json({ error: "Invalid case ID format" }, 400);
    }

    const session = createSession(caseId, userId, userName);
    const origin = process.env.CLIENT_URL || "http://localhost:3000";
    const shareUrl = `${origin}/collaborate/${session.token}`;

    return c.json({
      success: true,
      token: session.token,
      shareUrl,
      caseId: session.caseId,
      createdAt: session.createdAt,
    });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to create collaboration session" }, 500);
  }
});

/**
 * GET /api/collaborate/session/:token
 * Returns session public metadata and permissions for the requesting user.
 */
app.get("/session/:token", (c) => {
  const token = c.req.param("token");
  const userId = c.req.query("userId") || "anonymous";

  const session = getSession(token);
  if (!session || !session.active) {
    return c.json({ error: "Session invalid or expired" }, 404);
  }

  const isMaster = userId === session.masterId;
  const participant = session.participants.get(userId);

  return c.json({
    token: session.token,
    caseId: session.caseId,
    active: session.active,
    createdAt: session.createdAt,
    masterId: session.masterId,
    role: isMaster ? "MASTER" : participant?.role || "VIEWER",
    permissions: isMaster
      ? participant?.permissions
      : participant?.permissions || {
          VIEW: true,
          ZOOM_PAN: false,
          SLICE_CONTROL: false,
          WINDOW_LEVEL: false,
          ANNOTATE: false,
          EDIT_ANNOTATION: false,
          DELETE_ANNOTATION: false,
          AI_ANALYSIS: false,
          DOWNLOAD: false,
        },
    viewpoint: session.viewpoint,
    participants: Array.from(session.participants.values()).map((p) => ({
      id: p.id,
      name: p.name,
      initials: p.initials,
      role: p.role,
      connected: p.connected,
      joinedAt: p.joinedAt,
      permissions: p.permissions,
    })),
  });
});

/**
 * GET /api/collaborate/volume/:token
 * Streams the NIfTI volume data safely to authenticated collaboration viewers ONLY.
 * Enforces server-side VIEW permission check.
 */
app.get("/volume/:token", (c) => {
  const token = c.req.param("token");
  const userId = c.req.query("userId") || "anonymous";

  const session = getSession(token);
  if (!session || !session.active) {
    return c.json({ error: "Unauthorized session token" }, 401);
  }

  // Server-side permission check!
  const canView = validatePermission(token, userId, "VIEW");
  if (!canView) {
    return c.json({ error: "Permission denied: VIEW permission required" }, 403);
  }

  const caseId = session.caseId;
  const root = path.resolve(process.cwd(), "..", "..");
  const file = path.join(root, "data", "nifti", caseId, `${caseId}_primary.nii.gz`);

  if (!fs.existsSync(file)) {
    return c.json({ error: `Volume data unavailable for case` }, 404);
  }

  const buf = fs.readFileSync(file);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, no-transform, max-age=1800",
    },
  });
});

export default app;
