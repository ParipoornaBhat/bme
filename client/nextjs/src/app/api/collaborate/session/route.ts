import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const serverUrl =
      process.env.EXPO_PUBLIC_SERVER_URL ||
      process.env.NEXT_PUBLIC_SERVER_URL ||
      "http://localhost:4000";

    // Forward the caller's session cookie: the API only lets a signed-in team
    // member open a review, and it can only tell who is asking from this.
    const res = await fetch(`${serverUrl}/api/collaborate/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: req.headers.get("cookie") ?? "",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to connect to collaboration API server" },
      { status: 500 }
    );
  }
}
