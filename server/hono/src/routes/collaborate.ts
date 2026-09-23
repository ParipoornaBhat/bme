import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { checkCollabAccess, createSession, getSession } from "../lib/collab-server.js";
import { getAuthContext } from "../lib/permissions.js";

/**
 * A team member is someone signed in who holds the admin role. Being signed in
 * alone is not enough: sign-up is open, so anyone can make an account. Every
 * team account is seeded as admin (server/db/src/seed.ts), and a self-registered
 * account is not.
 */
async function isTeamMember(c: any): Promise<boolean> {
  try {
    const ctx = await getAuthContext(c);
    return ctx?.activeRole?.name === "admin";
  } catch {
    return false;
  }
}

const app = new Hono();

const ID = /^[a-zA-Z0-9_-]+$/;

/**
 * POST /api/collaborate/session
 * Body: { caseId: string, userId?: string, userName?: string }
 * Creates a new secure collaboration session and returns session token.
 */
app.post("/session", async (c) => {
  // Opening a review exposes a study to whoever holds the link, so only the
  // team may do it.
  if (!(await isTeamMember(c))) {
    return c.json({ error: "Only a signed-in team member can start a review session" }, 401);
  }
  try {
    const body = await c.req.json();
    const { caseId, userId = "master_user", userName = "Dr. Master" } = body;

    if (!caseId || !ID.test(caseId)) {
      return c.json({ error: "Invalid case ID format" }, 400);
    }

    const session = createSession(caseId, userId, userName);

    return c.json({
      success: true,
      token: session.token,
      // Returned once, to the creator. It is what makes their socket the host.
      hostKey: session.hostKey,
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
/**
 * GET /api/collaborate/access?token=...&key=...
 * Used by the web app's data routes to decide whether a guest request may read
 * or write study data. Says only yes or no and with which permissions.
 */
app.get("/access", (c) => {
  const token = c.req.query("token") || "";
  const key = c.req.query("key") || "";
  if (!token || !key) return c.json({ error: "Missing token or key" }, 401);
  const access = checkCollabAccess(token, key);
  if (!access.ok) return c.json({ error: access.error }, access.status);
  return c.json({ role: access.role, permissions: access.permissions });
});

app.get("/volume/:token", async (c) => {
  const token = c.req.param("token");

  const session = getSession(token);
  if (!session || !session.active) {
    return c.json({ error: "Unauthorized session token" }, 401);
  }

  // Authorised by a participant key or a team sign-in, never by a userId query
  // parameter: the host's id is returned by the public session lookup, so
  // passing it as ?userId= used to be enough to download the whole volume.
  if (!(await isTeamMember(c))) {
    const access = checkCollabAccess(token, c.req.query("key") || "");
    if (!access.ok) return c.json({ error: access.error }, access.status);
    if (!access.permissions.VIEW) {
      return c.json({ error: "Permission denied: VIEW permission required" }, 403);
    }
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
