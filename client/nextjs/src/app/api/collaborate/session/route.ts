import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const serverUrl =
      process.env.EXPO_PUBLIC_SERVER_URL ||
      process.env.NEXT_PUBLIC_SERVER_URL ||
      "http://localhost:4000";

    const res = await fetch(`${serverUrl}/api/collaborate/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
