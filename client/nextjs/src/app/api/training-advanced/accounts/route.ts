import { NextResponse } from "next/server";
import { isReviewMode } from "~/lib/app-mode";
import { fetchAccounts, fetchAccountsQuick } from "~/lib/training-advanced/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (isReviewMode()) {
    return NextResponse.json({ error: "Not found in review mode" }, { status: 404 });
  }

  try {
    const quick = new URL(req.url).searchParams.get("quick") === "1" || new URL(req.url).searchParams.get("quick") === "true";
    const data = quick ? await fetchAccountsQuick() : await fetchAccounts();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load accounts" }, { status: 500 });
  }
}
