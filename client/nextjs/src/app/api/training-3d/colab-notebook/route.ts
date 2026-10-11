import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

function root() {
  return path.resolve(process.cwd(), "..", "..");
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const r = root();
  const colabUrl = process.env.COLAB_NOTEBOOK_URL?.trim() || null;

  if (url.searchParams.get("info") === "true") {
    return NextResponse.json({ colabUrl });
  }

  const notebookPath = path.join(r, "ml", "notebooks", "train_3d_colab.ipynb");
  if (!fs.existsSync(notebookPath)) {
    return NextResponse.json({ error: "Notebook file not found" }, { status: 404 });
  }

  const content = fs.readFileSync(notebookPath, "utf8");
  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ipynb+json",
      "Content-Disposition": 'attachment; filename="train_3d_colab.ipynb"',
      "Cache-Control": "no-store",
    },
  });
}
