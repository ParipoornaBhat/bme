import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@bme/db";
import {
  reviewAccount,
  verifyPassword,
  signReviewCookie,
  isLoginRateLimited,
  recordLoginFailure,
  clearLoginFailures,
} from "~/lib/review-auth";

export const dynamic = "force-dynamic";

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip") || "127.0.0.1";
}

export async function POST(req: NextRequest) {
  const secret = process.env.REVIEW_SESSION_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Server misconfigured: REVIEW_SESSION_SECRET missing" },
      { status: 500 },
    );
  }

  const ip = getClientIp(req);
  if (isLoginRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many failed login attempts. Please try again later." },
      { status: 429 },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Wrong username or password" },
      { status: 401 },
    );
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    recordLoginFailure(ip);
    return NextResponse.json(
      { error: "Wrong username or password" },
      { status: 401 },
    );
  }

  try {
    const [user] = await db
      .select()
      .from(reviewAccount)
      .where(sql`lower(${reviewAccount.username}) = lower(${username})`)
      .limit(1);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      recordLoginFailure(ip);
      return NextResponse.json(
        { error: "Wrong username or password" },
        { status: 401 },
      );
    }

    clearLoginFailures(ip);

    const maxAgeSec = 12 * 60 * 60; // 12 hours
    const expiresMs = Date.now() + maxAgeSec * 1000;
    const cookieVal = await signReviewCookie(user.username, expiresMs, secret);

    const res = NextResponse.json({
      ok: true,
      user: {
        username: user.username,
        displayName: user.displayName,
      },
    });

    res.cookies.set({
      name: "bme_review",
      value: cookieVal,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: maxAgeSec,
    });

    return res;
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 },
    );
  }
}
