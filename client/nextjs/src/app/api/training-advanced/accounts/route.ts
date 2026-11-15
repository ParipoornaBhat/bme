import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { fetchAccounts } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const data = await fetchAccounts();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load accounts" }, { status: 500 });
  }
}
