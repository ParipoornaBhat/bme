"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { ConfirmationModal } from "../training/advanced/components/ConfirmationModal";

type Plan = { missing: string[]; estimateBytes: number; inDatabase: number };

const mb = (b: number) => `${Math.max(1, Math.round(b / (1024 * 1024)))} MB`;

/**
 * Shown on this PC when the team database lists scans this PC does not have yet
 * (new cases added by a teammate and uploaded to Drive). Checked on load and after
 * every cloud sync. Nothing downloads until the user confirms.
 */
export function NewScansBanner({ onDone }: { onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/data-pull", { cache: "no-store" });
      if (!res.ok) return;
      setPlan((await res.json()) as Plan);
    } catch {
      /* offline: say nothing */
    }
  }, []);

  useEffect(() => {
    void check();
    const again = () => void check();
    window.addEventListener("bme:check-new-scans", again);
    return () => window.removeEventListener("bme:check-new-scans", again);
  }, [check]);

  const download = async () => {
    if (!plan) return;
    setAsking(false);
    setBusy(true);
    const id = toast.loading(`Downloading ${plan.missing.length} scan(s) from Drive...`);
    try {
      const res = await fetch("/api/data-pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || "Download failed");
      const failed = (r.failed || []) as { id: string; why: string }[];
      // Their annotations can be written now that the scans are here.
      await fetch("/api/annotation-sync", { method: "POST" }).catch(() => null);
      if (failed.length) {
        toast.warning(`Downloaded ${r.downloaded.length}, ${failed.length} not downloaded (${failed[0].id}: ${failed[0].why}).`, { id });
      } else {
        toast.success(`Downloaded ${r.downloaded.length} scan(s) and synced their annotations.`, { id });
      }
      onDone();
      await check();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed", { id });
    } finally {
      setBusy(false);
    }
  };

  if (!plan || plan.missing.length === 0) return null;
  const shown = plan.missing.slice(0, 12).join(", ") + (plan.missing.length > 12 ? `, and ${plan.missing.length - 12} more` : "");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300">
      <span>
        <strong>{plan.missing.length} new scan(s)</strong> from the team are on Drive and not on this PC yet (about {mb(plan.estimateBytes)}).
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => setAsking(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-sky-500/90 cursor-pointer disabled:opacity-50"
      >
        <Download className="h-3 w-3" />
        {busy ? "Downloading..." : "Download"}
      </button>
      <ConfirmationModal
        open={asking}
        title={`Download ${plan.missing.length} new scan(s)?`}
        description={`About ${mb(plan.estimateBytes)} from the team's Drive folder.`}
        warnings={[
          `Cases: ${shown}.`,
          "They go to data/nifti and are added to the case list. Existing scans and annotations are not changed.",
          "Their annotations are synced right after.",
        ]}
        actionLabel="Download"
        onConfirm={download}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}
