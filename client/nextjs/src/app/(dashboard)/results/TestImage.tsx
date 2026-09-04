"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, ImageUp, Loader2, X } from "lucide-react";

/**
 * Upload one 2D slice, run the trained models on it, show what came back.
 *
 * Everything on this panel is model output. If a checkpoint is missing the
 * corresponding block says so and stays empty — a placeholder mask or a
 * decorative heatmap would read as a result, and it would be a fabricated one.
 */

type Fold = { fold: number; prob: number; val_auc: number | null };

type Detection =
  | { available: false; reason: string }
  | {
      available: true;
      label: "YES" | "NO";
      answer: string;
      probability: number;
      threshold: number;
      classes: string[];
      positive_class: string;
      per_fold: Fold[];
      spread: { min: number; max: number; std: number };
      arch: string;
      n_folds: number;
      trained_at: string | null;
      case_level_auc: number | null;
      gradcam: string;
    };

type Segmentation =
  | { available: false; reason: string }
  | {
      available: true;
      lesion_present: boolean;
      bone_pixels: number;
      lesion_pixels: number;
      lesion_fraction_of_bone: number | null;
      lesion_fraction_of_image: number;
      mean_lesion_confidence: number | null;
      channels: string[];
      threshold: number;
      canvas: number;
      n_folds: number;
      trained_at: string | null;
      summary: Record<string, { mean: number; std: number } | null> | null;
      mask: string;
      overlay: string;
      note: string;
    };

type Result = {
  ok: true;
  device: string;
  input: { filename: string; width: number; height: number; mode: string; preview: string };
  preprocessing: { steps: string[]; img_size: number; note: string };
  detection: Detection;
  segmentation: Segmentation;
};

type Status = {
  detection: { available: boolean; arch?: string; folds?: number; trainedAt?: string | null;
               nCases?: number | null; caseLevelAuc?: number | null };
  segmentation: { available: boolean; folds?: number; trainedAt?: string | null;
                  nCases?: number | null; nSlices?: number | null;
                  summary?: Record<string, { mean: number; std: number } | null> | null };
};

const pct = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`;

const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

function Step({ label, detail, last }: { label: string; detail: string; last?: boolean }) {
  return (
    <>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="truncate text-sm font-medium" title={detail}>{detail}</div>
      </div>
      {!last && <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </>
  );
}

function Panel({ title, src, caption }: { title: string; src: string; caption: string }) {
  return (
    <figure className="m-0">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={title} className="w-full rounded-lg border border-border bg-black/5" />
      <figcaption className="mt-1.5 text-[11px] leading-tight text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

function Missing({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
      <AlertTriangle className="mb-2 h-4 w-4 text-amber-500" />
      {reason}
    </div>
  );
}

export default function TestImage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/predict", { cache: "no-store" });
      if (r.ok) setStatus(await r.json());
    } catch { /* the panel degrades to "unknown" */ }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const run = useCallback(async (file: File) => {
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const r = await fetch("/api/predict", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || j.error) setError(j.detail ? `${j.error}\n\n${j.detail}` : (j.error ?? "inference failed"));
      else setResult(j);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      loadStatus();
    }
  }, [loadStatus]);

  const det = result?.detection;
  const seg = result?.segmentation;
  const yes = det?.available && det.label === "YES";

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <ImageUp className="h-3.5 w-3.5" /> Test a slice — upload one 2D image
        </span>
        {result && (
          <button
            onClick={() => { setResult(null); setError(null); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Runs the saved checkpoints. Nothing is trained by this button.
      </p>

      {/* Which models exist right now. Stated before the upload, not after. */}
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {([
          ["Detection", status?.detection, status?.detection.available
            ? `${status.detection.arch}, ${status.detection.folds} folds · trained ${when(status.detection.trainedAt)}`
            : "not trained yet"],
          ["Segmentation", status?.segmentation, status?.segmentation.available
            ? `2D U-Net, ${status.segmentation.folds} folds · ${status.segmentation.nCases} annotated case(s)`
            : "not trained yet"],
        ] as const).map(([label, s, detail]) => (
          <div key={label} className="flex items-start gap-2 rounded-lg border border-border p-2.5">
            {s?.available
              ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
            <div className="min-w-0">
              <div className="text-xs font-semibold">{label}</div>
              <div className="text-[11px] text-muted-foreground">{detail}</div>
            </div>
          </div>
        ))}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault(); setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) run(f);
        }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition ${
          drag ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
        }`}
      >
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) run(f); e.target.value = ""; }}
        />
        {busy ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running the models…
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            Drop a 2D slice here, or click to choose one. PNG or JPEG, up to 25 MB.
          </span>
        )}
      </div>

      {error && (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/10 p-3 text-xs">
          {error}
        </pre>
      )}

      {result && (
        <div className="mt-5 space-y-5">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <Step label="Input" detail={`${result.input.width}×${result.input.height} ${result.input.mode}`} />
            <Step label="Preprocess" detail={`grayscale → ${result.preprocessing.img_size}² → normalise`} />
            <Step
              label="Model"
              detail={det?.available ? `${det.arch}, ${det.n_folds}-fold ensemble` : "none"}
            />
            <Step label="Result" detail={det?.available ? det.answer : "unavailable"} last />
          </div>

          {/* ---------------------------------------------------- detection */}
          {det?.available ? (
            <div className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div
                  className={`rounded-lg px-5 py-3 text-center ${
                    yes
                      ? "bg-rose-500/12 text-rose-700 dark:text-rose-300"
                      : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                  }`}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider opacity-75">
                    Bone marrow edema
                  </div>
                  <div className="text-3xl font-bold leading-tight">{det.label}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>P(BME) = {pct(det.probability)}</span>
                    <span>decision threshold {pct(det.threshold)}</span>
                  </div>
                  <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${yes ? "bg-rose-500" : "bg-emerald-500"}`}
                      style={{ width: `${Math.round(det.probability * 100)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 w-px bg-foreground/50"
                      style={{ left: `${det.threshold * 100}%` }}
                    />
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Mean over {det.n_folds} fold models. Folds ranged{" "}
                    <span className="tabular-nums">{pct(det.spread.min)}–{pct(det.spread.max)}</span>{" "}
                    (sd {pct(det.spread.std)}).
                    {det.spread.std > 0.15 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {" "}The folds disagree substantially on this image — treat the mean with care.
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="p-1.5 text-left">Fold</th>
                      {det.per_fold.map((f) => (
                        <th key={f.fold} className="p-1.5 text-right tabular-nums">{f.fold}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border/50">
                      <td className="p-1.5 text-muted-foreground">P(BME)</td>
                      {det.per_fold.map((f) => (
                        <td key={f.fold} className="p-1.5 text-right tabular-nums">{pct(f.prob)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className="p-1.5 text-muted-foreground">that fold&apos;s val AUC</td>
                      {det.per_fold.map((f) => (
                        <td key={f.fold} className="p-1.5 text-right tabular-nums opacity-70">
                          {pct(f.val_auc)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <Missing reason={det?.reason ?? "No classifier."} />
          )}

          {/* ------------------------------------------------------- images */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Panel
              title="Input"
              src={result.input.preview}
              caption={`${result.input.filename} — as uploaded, ${result.input.width}×${result.input.height}`}
            />
            {det?.available && (
              <Panel
                title="Grad-CAM"
                src={det.gradcam}
                caption="Where the classifier looked. Averaged over the fold models. Region, not outline."
              />
            )}
            {seg?.available && (
              <>
                <Panel
                  title="Segmentation mask"
                  src={seg.mask}
                  caption="Blue = predicted bone/marrow · red = predicted edema."
                />
                <Panel
                  title="Overlay"
                  src={seg.overlay}
                  caption="The same mask over the slice, at the resolution the model saw."
                />
              </>
            )}
          </div>

          {/* ------------------------------------------------- segmentation */}
          {seg?.available ? (
            <div className="rounded-lg border border-border p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Edema segmentation
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Lesion found", seg.lesion_present ? "yes" : "no"],
                  ["Edema pixels", seg.lesion_pixels.toLocaleString()],
                  ["Share of predicted bone", pct(seg.lesion_fraction_of_bone)],
                  ["Mean confidence in lesion", pct(seg.mean_lesion_confidence)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-border p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {k}
                    </div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">{v}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{seg.note}</p>
              {seg.summary?.lesion_dice && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  This model&apos;s cross-validated lesion Dice was{" "}
                  <span className="tabular-nums font-medium text-foreground">
                    {seg.summary.lesion_dice.mean.toFixed(3)} ± {seg.summary.lesion_dice.std.toFixed(3)}
                  </span>{" "}
                  over {seg.n_folds} folds on {status?.segmentation.nCases} annotated case(s). With a
                  training set that small, treat a mask on a new image as a sketch, not a measurement.
                </p>
              )}
              {det?.available && ((det.label === "YES") !== seg.lesion_present) && (
                <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                  <strong>The two models disagree here.</strong> Detection says{" "}
                  {det.label === "YES" ? "BME present" : "no BME"}, segmentation found{" "}
                  {seg.lesion_present ? "lesion pixels" : "none"}. They are trained on different
                  labels — case-level classes against hand-painted masks — so this happens, and
                  neither is automatically the right one.
                </p>
              )}
            </div>
          ) : (
            <Missing reason={seg?.reason ?? "No segmentation model."} />
          )}

          <p className="text-xs text-muted-foreground">
            Ran on {result.device}. Preprocessing: {result.preprocessing.steps.join(" → ")}.{" "}
            {result.preprocessing.note}
          </p>
        </div>
      )}
    </div>
  );
}
