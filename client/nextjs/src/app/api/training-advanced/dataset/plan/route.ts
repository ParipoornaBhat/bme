import { NextRequest, NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { planDatasetSync } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { targetId } = body;
    if (!targetId) {
      return NextResponse.json({ error: "Missing targetId" }, { status: 400 });
    }

    const res = await planDatasetSync(targetId);
    return NextResponse.json(res);
  } catch (err: any) {
    const rawMsg = err.message || "Failed to check sync plan";
    const msg = rawMsg.includes("Permission denied (publickey)")
      ? "Jump host login refused: check H200_JUMP in .env (e.g. pc1 or pc-server-1) or SSH key."
      : rawMsg;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
