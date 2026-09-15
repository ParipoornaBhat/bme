import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const userId = req.nextUrl.searchParams.get("userId") || "anonymous";
    const serverUrl =
      process.env.EXPO_PUBLIC_SERVER_URL ||
      process.env.NEXT_PUBLIC_SERVER_URL ||
      "http://localhost:4000";

    const res = await fetch(
      `${serverUrl}/api/collaborate/session/${token}?userId=${encodeURIComponent(userId)}`,
      { cache: "no-store" }
    );

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to connect to collaboration API server" },
      { status: 500 }
    );
  }
}
