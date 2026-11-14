import { NextRequest, NextResponse } from "next/server";
import { getReviewUser } from "~/lib/review-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getReviewUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  });
}
