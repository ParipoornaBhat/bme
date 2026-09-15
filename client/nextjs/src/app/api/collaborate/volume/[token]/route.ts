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
      `${serverUrl}/api/collaborate/volume/${token}?userId=${encodeURIComponent(userId)}`,
      { cache: "no-store" }
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Volume stream failed" }));
      return NextResponse.json(data, { status: res.status });
    }

    const buf = await res.arrayBuffer();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "private, max-age=1800",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to stream volume from collaboration backend" },
      { status: 500 }
    );
  }
}
