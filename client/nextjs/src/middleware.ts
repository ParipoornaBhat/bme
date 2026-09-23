import { NextResponse, type NextRequest } from "next/server";

/**
 * Every /api route in this app is denied unless a rule below lets it through.
 *
 * These routes serve patient MRI straight off disk. Before this file none of
 * them checked who was asking, so anyone who could reach the server - on the
 * LAN, or through `pnpm tunnel` on a public URL - could list and download every
 * study. Denying by default also covers routes added later.
 *
 * Two ways in:
 *   - a signed-in team member (admin role), for everything;
 *   - a review-session guest, for the few study routes the shared viewer uses,
 *     and only while the host is connected and the guest holds the permission
 *     the host granted them.
 */

const API =
  process.env.EXPO_PUBLIC_SERVER_URL ||
  process.env.NEXT_PUBLIC_SERVER_URL ||
  "http://localhost:4000";

// Served and guarded by the Hono API itself (proxied by next.config rewrites),
// plus sign-in, which has to work before anyone is signed in.
const PASS_THROUGH = [
  /^\/api\/auth\//,
  /^\/api\/users(\/|$)/,
  /^\/api\/roles(\/|$)/,
  /^\/api\/collaborate\/access$/,
];

type GuestPermission = "VIEW" | "ANNOTATE" | "DELETE_ANNOTATION";

// The only routes a guest can reach, and what the host must have granted.
function guestPermissionFor(path: string, method: string): GuestPermission | null {
  if (path === "/api/cases2d" && method === "GET") return "VIEW";
  if (path === "/api/annotation2d/flag") return method === "GET" ? "VIEW" : "ANNOTATE";
  if (/^\/api\/annotation2d\/[^/]+$/.test(path)) {
    if (method === "GET") return "VIEW";
    if (method === "POST") return "ANNOTATE";
    if (method === "DELETE") return "DELETE_ANNOTATION";
  }
  return null;
}

// The shared-link page checks a token is real before connecting. It returns
// session metadata only, never study data.
function isSessionLookup(path: string, method: string) {
  return method === "GET" && /^\/api\/collaborate\/session\/[^/]+$/.test(path);
}

// Short-lived, so a revoked permission or a departed host takes effect within
// seconds while an image-heavy page does not hit the API once per request.
const cache = new Map<string, { ok: boolean; until: number }>();
const TEAM_TTL_MS = 10_000;
const GUEST_TTL_MS = 3_000;

function cached(key: string): boolean | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.until < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.ok;
}

function remember(key: string, ok: boolean, ttl: number) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { ok, until: Date.now() + ttl });
}

async function isTeamMember(req: NextRequest): Promise<boolean> {
  const cookie = req.headers.get("cookie") ?? "";
  if (!cookie.includes("session_token")) return false;

  const key = `team:${cookie}`;
  const hit = cached(key);
  if (hit !== null) return hit;

  let ok = false;
  try {
    const res = await fetch(`${API}/api/users/profile`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (res.ok) {
      const profile = (await res.json()) as { activeRole?: { name?: string } | null };
      // Signed in is not enough: sign-up is open. Team accounts are seeded as
      // admin (server/db/src/seed.ts); a self-registered one is not.
      ok = profile.activeRole?.name === "admin";
    }
  } catch {
    ok = false;
  }
  remember(key, ok, TEAM_TTL_MS);
  return ok;
}

async function guestMay(req: NextRequest, permission: GuestPermission): Promise<boolean> {
  const token = req.nextUrl.searchParams.get("collab") ?? "";
  const participantKey = req.nextUrl.searchParams.get("key") ?? "";
  if (!token || !participantKey) return false;

  const key = `guest:${token}:${participantKey}:${permission}`;
  const hit = cached(key);
  if (hit !== null) return hit;

  let ok = false;
  try {
    const url = `${API}/api/collaborate/access?token=${encodeURIComponent(token)}&key=${encodeURIComponent(participantKey)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const access = (await res.json()) as { permissions?: Record<string, boolean> };
      ok = access.permissions?.[permission] === true;
    }
  } catch {
    ok = false;
  }
  remember(key, ok, GUEST_TTL_MS);
  return ok;
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const method = req.method.toUpperCase();

  if (PASS_THROUGH.some((re) => re.test(path))) return NextResponse.next();
  if (isSessionLookup(path, method)) return NextResponse.next();

  if (await isTeamMember(req)) return NextResponse.next();

  const permission = guestPermissionFor(path, method);
  if (permission && (await guestMay(req, permission))) return NextResponse.next();

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export const config = {
  matcher: "/api/:path*",
};
