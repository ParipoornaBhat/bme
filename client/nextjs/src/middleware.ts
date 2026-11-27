import { NextResponse, type NextRequest } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import {
  verifyReviewCookie,
  signReviewCookie,
  REVIEW_SESSION_MAX_AGE_SEC,
} from "~/lib/review-cookie";

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
// 3D routes name a case; `caseId` is set for those, and a guest may only
// reach the case their session is about.
function guestPermissionFor(
  path: string,
  method: string,
): { permission: GuestPermission; caseId?: string } | null {
  if (path === "/api/cases2d" && method === "GET") return { permission: "VIEW" };
  if (path === "/api/annotation2d/flag") return { permission: method === "GET" ? "VIEW" : "ANNOTATE" };
  if (/^\/api\/annotation2d\/[^/]+$/.test(path)) {
    if (method === "GET") return { permission: "VIEW" };
    if (method === "POST") return { permission: "ANNOTATE" };
    if (method === "DELETE") return { permission: "DELETE_ANNOTATION" };
  }
  const volume = /^\/api\/volume\/([^/]+)$/.exec(path);
  if (volume && method === "GET") return { permission: "VIEW", caseId: volume[1] };
  const labels = /^\/api\/annotation\/([^/]+)\/labels$/.exec(path);
  if (labels && method === "GET") return { permission: "VIEW", caseId: labels[1] };
  const flag = /^\/api\/annotation\/([^/]+)\/flag$/.exec(path);
  if (flag) return { permission: method === "GET" ? "VIEW" : "ANNOTATE", caseId: flag[1] };
  const mask = /^\/api\/annotation\/([^/]+)$/.exec(path);
  if (mask) {
    if (method === "POST") return { permission: "ANNOTATE", caseId: mask[1] };
    if (method === "DELETE") return { permission: "DELETE_ANNOTATION", caseId: mask[1] };
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

async function guestMay(req: NextRequest, permission: GuestPermission, caseId?: string): Promise<boolean> {
  const token = req.nextUrl.searchParams.get("collab") ?? "";
  const participantKey = req.nextUrl.searchParams.get("key") ?? "";
  if (!token || !participantKey) return false;

  const key = `guest:${token}:${participantKey}:${permission}:${caseId ?? ""}`;
  const hit = cached(key);
  if (hit !== null) return hit;

  let ok = false;
  try {
    const url = `${API}/api/collaborate/access?token=${encodeURIComponent(token)}&key=${encodeURIComponent(participantKey)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const access = (await res.json()) as {
        permissions?: Record<string, boolean>;
        caseId?: string;
        mode?: string;
      };
      ok = access.permissions?.[permission] === true;
      // A 3D review covers one case; its link opens nothing else.
      if (caseId !== undefined) ok = ok && access.mode === "3d" && access.caseId === caseId;
    }
  } catch {
    ok = false;
  }
  remember(key, ok, GUEST_TTL_MS);
  return ok;
}

const REVIEW_CASE_ID = /^(BME|NBME)-\d{3}$/;

function isReviewContractRoute(path: string, method: string): boolean {
  if (path === "/login") return true;
  if (path === "/annotate" || path.startsWith("/annotate/")) return true;
  if (path.startsWith("/api/review/")) return true;
  if (path === "/api/cases" && method === "GET") return true;

  const volMatch = /^\/api\/volume\/([^/]+)$/.exec(path);
  if (volMatch && method === "GET" && REVIEW_CASE_ID.test(volMatch[1])) return true;

  const labelsMatch = /^\/api\/annotation\/([^/]+)\/labels$/.exec(path);
  if (labelsMatch && method === "GET" && REVIEW_CASE_ID.test(labelsMatch[1])) return true;

  const annMatch = /^\/api\/annotation\/([^/]+)$/.exec(path);
  if (annMatch && (method === "GET" || method === "POST") && REVIEW_CASE_ID.test(annMatch[1])) return true;

  return false;
}

async function reviewMiddleware(req: NextRequest, path: string, method: string) {
  // Static assets are always allowed
  if (
    path.startsWith("/_next/") ||
    path === "/favicon.ico" ||
    path === "/robots.txt" ||
    path === "/manifest.json" ||
    /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot)$/i.test(path)
  ) {
    return NextResponse.next();
  }

  // Allow unauthenticated access to /login and /api/review/login
  if (path === "/login" || path === "/api/review/login") {
    return NextResponse.next();
  }

  // Check bme_review cookie authentication
  const cookie = req.cookies.get("bme_review")?.value;
  const session = await verifyReviewCookie(cookie);

  if (!session) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  let renewedCookie: string | null = null;
  const secret = process.env.REVIEW_SESSION_SECRET;
  if (
    secret &&
    session.expiresMs - Date.now() < REVIEW_SESSION_MAX_AGE_SEC * 1000 - 24 * 60 * 60 * 1000
  ) {
    renewedCookie = await signReviewCookie(
      session.username,
      Date.now() + REVIEW_SESSION_MAX_AGE_SEC * 1000,
      secret,
    );
  }

  function withRenewedCookie<T extends NextResponse>(res: T): T {
    if (renewedCookie) {
      res.cookies.set({
        name: "bme_review",
        value: renewedCookie,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: REVIEW_SESSION_MAX_AGE_SEC,
      });
    }
    return res;
  }

  // Redirect root to /annotate when authenticated
  if (path === "/") {
    const annotateUrl = new URL("/annotate", req.url);
    return withRenewedCookie(NextResponse.redirect(annotateUrl));
  }

  // In review mode, allow only the contract paths; everything else 404s
  if (!isReviewContractRoute(path, method)) {
    if (path.startsWith("/api/")) {
      return withRenewedCookie(NextResponse.json({ error: "Not Found" }, { status: 404 }));
    }
    return withRenewedCookie(new NextResponse("Not Found", { status: 404 }));
  }

  return withRenewedCookie(NextResponse.next());
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const method = req.method.toUpperCase();

  if (isReviewMode()) {
    return reviewMiddleware(req, path, method);
  }

  if (!path.startsWith("/api")) {
    return NextResponse.next();
  }

  if (PASS_THROUGH.some((re) => re.test(path))) return NextResponse.next();
  if (isSessionLookup(path, method)) return NextResponse.next();

  const isAnnotationSyncRoute = /^\/api\/annotation-sync(\/|$)/.test(path);
  const hasCollabToken = Boolean(
    req.nextUrl.searchParams.get("collab") || req.nextUrl.searchParams.get("key"),
  );

  // Collaborator/guest tokens cannot call annotation sync under any circumstances
  if (isAnnotationSyncRoute && hasCollabToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hostname = req.nextUrl.hostname || "";
  const host = req.headers.get("host") || "";
  const isTrainingRoute = /^\/api\/training-3d(\/|$)/.test(path);
  if (
    !isTrainingRoute &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      host.includes("localhost") ||
      host.includes("127.0.0.1"))
  ) {
    return NextResponse.next();
  }

  if (await isTeamMember(req)) return NextResponse.next();

  const guest = guestPermissionFor(path, method);
  if (guest && (await guestMay(req, guest.permission, guest.caseId))) return NextResponse.next();

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
