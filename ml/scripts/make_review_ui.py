"""Generate the interactive review page from the 2D results.

    python ml/scripts/make_review_ui.py "D:/Final yr Prj/bme"

Reads data/results2d/{metrics.json,review.json} and writes
data/results2d/review.html — a self-contained page that shows each prediction,
asks whether the model got it right, and updates agreement statistics live.

Rerun after every training run; it always reflects the latest results.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TEMPLATE = """<title>BME Reading Room</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{
  --bg:#f2f4f7; --surface:#ffffff; --surface-2:#e9edf2; --line:#d3dae3;
  --ink:#111820; --muted:#5a6675; --faint:#8b96a5;
  --accent:#0d7d8c; --accent-soft:#d3eef1;
  --yes:#16794f; --yes-soft:#d6efe3;
  --no:#a8321f; --no-soft:#f7ded9;
  --film:#0a0d11;
  --r:10px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0d1116; --surface:#151b22; --surface-2:#1d242d; --line:#2b343f;
    --ink:#e6ecf3; --muted:#94a1b2; --faint:#6b7787;
    --accent:#3fb9c9; --accent-soft:#123038;
    --yes:#4ec38c; --yes-soft:#102c20;
    --no:#e8735d; --no-soft:#331813;
    --film:#05070a;
  }
}
:root[data-theme="dark"]{
  --bg:#0d1116; --surface:#151b22; --surface-2:#1d242d; --line:#2b343f;
  --ink:#e6ecf3; --muted:#94a1b2; --faint:#6b7787;
  --accent:#3fb9c9; --accent-soft:#123038;
  --yes:#4ec38c; --yes-soft:#102c20;
  --no:#e8735d; --no-soft:#331813;
  --film:#05070a;
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  line-height:1.5;-webkit-font-smoothing:antialiased;
}
.mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}

header{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;
  padding-bottom:18px;border-bottom:1px solid var(--line);margin-bottom:24px}
h1{font-size:1.4rem;font-weight:600;margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:.86rem;margin-top:3px}
.eyebrow{font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
  color:var(--accent);margin-bottom:6px}

.banner{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:var(--r);padding:13px 16px;margin-bottom:24px;font-size:.85rem;color:var(--muted)}
.banner strong{color:var(--ink);font-weight:600}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin-bottom:14px}
.metric{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:13px 15px}
.metric .k{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:600}
.metric .v{font-size:1.5rem;font-weight:600;margin-top:5px;letter-spacing:-.02em}
.metric .n{font-size:.72rem;color:var(--faint);margin-top:2px}
.tablabel{font-size:.72rem;color:var(--muted);margin:18px 0 8px;font-weight:500}

.board{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.85fr);gap:20px;margin-top:26px}
@media(max-width:860px){.board{grid-template-columns:1fr}}

.film{background:var(--film);border:1px solid var(--line);border-radius:var(--r);
  padding:18px;display:flex;flex-direction:column;align-items:center;gap:14px}
.film img{width:100%;max-width:400px;image-rendering:auto;border-radius:4px;display:block}
.filmbar{width:100%;display:flex;justify-content:space-between;align-items:center;
  font-size:.74rem;color:#7d8b9c}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px}
.panel + .panel{margin-top:14px}
.panel h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);
  margin:0 0 12px;font-weight:600}

.callrow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px}
.call{font-size:1.28rem;font-weight:600;letter-spacing:-.01em}
.call.bme{color:var(--no)} .call.clear{color:var(--yes)}
.truth{font-size:.8rem;color:var(--muted)}
.bar{height:7px;background:var(--surface-2);border-radius:4px;overflow:hidden;margin-top:10px}
.bar i{display:block;height:100%;background:var(--accent);transition:width .25s}
.conf{font-size:.74rem;color:var(--faint);margin-top:6px}

.btns{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:4px}
button{font-family:inherit;font-size:.88rem;font-weight:600;padding:11px 12px;border-radius:8px;
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink);cursor:pointer;
  transition:transform .08s,background .15s}
button:hover{transform:translateY(-1px)}
button:active{transform:translateY(0)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.yes{background:var(--yes-soft);border-color:var(--yes);color:var(--yes)}
button.no{background:var(--no-soft);border-color:var(--no);color:var(--no)}
button.ghost{background:transparent;color:var(--muted);font-weight:500;font-size:.8rem;padding:8px}
kbd{font-family:"IBM Plex Mono",monospace;font-size:.7rem;background:var(--surface);
  border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--faint)}

.tally{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.tally div{background:var(--surface-2);border-radius:8px;padding:11px 13px}
.tally .k{font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
.tally .v{font-size:1.3rem;font-weight:600;margin-top:3px}
.agree{font-size:2rem;font-weight:600;letter-spacing:-.02em}
.progress{height:5px;background:var(--surface-2);border-radius:3px;overflow:hidden;margin-top:12px}
.progress i{display:block;height:100%;background:var(--accent);transition:width .3s}

table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
th{font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
td.num{text-align:right}
.cm{display:grid;grid-template-columns:auto 1fr 1fr;gap:5px;font-size:.76rem;margin-top:6px}
.cm div{padding:8px;background:var(--surface-2);border-radius:6px;text-align:center}
.cm .hd{background:transparent;color:var(--faint);font-size:.66rem;text-transform:uppercase;
  letter-spacing:.06em;font-weight:600;display:flex;align-items:center;justify-content:center}
.cm .big{font-size:1.1rem;font-weight:600}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);
  font-size:.76rem;color:var(--faint)}
.done{text-align:center;padding:36px 18px;color:var(--muted)}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
  <header>
    <div>
      <div class="eyebrow">2D baseline &middot; ResNet-18</div>
      <h1>BME Reading Room</h1>
      <div class="sub">__NSLICE__ slices from __NCASE__ knee MRI cases &middot; __FOLDS__-fold, split by patient</div>
    </div>
    <button class="ghost" onclick="toggleTheme()">Toggle theme</button>
  </header>

  <div class="banner">
    <strong>What this model does.</strong> It answers &ldquo;does this scan look like it has
    edema?&rdquo; &mdash; it does not locate or measure anything. Labels are per-case and applied
    to every slice, so a BME patient&rsquo;s normal-looking slices are still labelled BME.
    That puts a ceiling on the slice numbers. <strong>Quote the case-level row.</strong>
  </div>

  <div class="tablabel">Case level &mdash; slice probabilities averaged per patient</div>
  <div class="metrics" id="caseM"></div>

  <div class="tablabel">Slice level &mdash; noisy labels, read with the caveat above</div>
  <div class="metrics" id="sliceM"></div>

  <div class="board">
    <div>
      <div class="film">
        <div class="filmbar">
          <span class="mono" id="caseId">&mdash;</span>
          <span class="mono" id="counter">&mdash;</span>
        </div>
        <img id="shot" alt="MRI slice under review">
        <div class="filmbar"><span id="foldTag" class="mono"></span><span>fat-suppressed knee MRI</span></div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>Model call</h2>
        <div class="callrow">
          <span class="call" id="call">&mdash;</span>
          <span class="truth mono" id="truth"></span>
        </div>
        <div class="bar"><i id="probBar" style="width:0%"></i></div>
        <div class="conf" id="probTxt"></div>
        <div class="btns" style="margin-top:14px">
          <button class="yes" onclick="mark(true)">Agree <kbd>A</kbd></button>
          <button class="no" onclick="mark(false)">Disagree <kbd>D</kbd></button>
        </div>
        <button class="ghost" style="width:100%;margin-top:8px" onclick="skip()">Skip <kbd>S</kbd></button>
      </div>

      <div class="panel">
        <h2>Your review</h2>
        <div class="agree mono" id="agreeRate">&ndash;</div>
        <div class="conf" id="agreeSub">no slices reviewed yet</div>
        <div class="progress"><i id="prog" style="width:0%"></i></div>
        <div class="tally" style="margin-top:12px">
          <div><div class="k">Agreed</div><div class="v mono" id="nYes">0</div></div>
          <div><div class="k">Disagreed</div><div class="v mono" id="nNo">0</div></div>
        </div>
        <button class="ghost" style="width:100%;margin-top:10px" onclick="reset()">Reset review</button>
      </div>

      <div class="panel">
        <h2>Confusion &mdash; case level</h2>
        <div class="cm" id="cm"></div>
      </div>
    </div>
  </div>

  <div class="panel" style="margin-top:20px">
    <h2>Per-fold results</h2>
    <div style="overflow-x:auto">
      <table id="foldTable">
        <thead><tr><th>Fold</th><th class="num">Slices</th><th class="num">Accuracy</th>
        <th class="num">Precision</th><th class="num">Recall</th><th class="num">F1</th><th class="num">AUC</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <footer>
    Seed __SEED__ &middot; __MODEL__ &middot; __DEVICE__ &middot; generated from
    <span class="mono">data/results2d/metrics.json</span>. Rerun
    <span class="mono">ml/scripts/make_review_ui.py</span> after training to refresh.
  </footer>
</div>

<script>
const M = __METRICS__;
const R = __REVIEW__;
const KEY = "bme-review-v1";
let seen = {};
try { seen = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch(e){ seen = {}; }
let i = 0;

function toggleTheme(){
  const r = document.documentElement;
  const dark = getComputedStyle(r).getPropertyValue('--bg').trim().startsWith('#0d');
  r.setAttribute('data-theme', dark ? 'light' : 'dark');
}
const pct = v => (v==null||isNaN(v)) ? "&ndash;" : (v*100).toFixed(1)+"%";

function cards(el, m, extra){
  document.getElementById(el).innerHTML = ["accuracy","precision","recall","f1","auc"].map(k=>
    `<div class="metric"><div class="k">${k==="auc"?"ROC AUC":k}</div>
     <div class="v mono">${pct(m[k])}</div><div class="n">${extra||("n = "+m.n)}</div></div>`).join("");
}
cards("caseM", M.case_level, "n = " + M.case_level.n + " cases");
cards("sliceM", M.slice_level);

const cm = M.case_level.confusion;
document.getElementById("cm").innerHTML = `
  <div class="hd"></div><div class="hd">Pred clear</div><div class="hd">Pred BME</div>
  <div class="hd">True clear</div><div class="big mono">${cm[0][0]}</div><div class="big mono">${cm[0][1]}</div>
  <div class="hd">True BME</div><div class="big mono">${cm[1][0]}</div><div class="big mono">${cm[1][1]}</div>`;

document.querySelector("#foldTable tbody").innerHTML = M.per_fold.map((f,k)=>
  `<tr><td class="mono">${k}</td><td class="num mono">${f.n}</td>
   <td class="num mono">${pct(f.accuracy)}</td><td class="num mono">${pct(f.precision)}</td>
   <td class="num mono">${pct(f.recall)}</td><td class="num mono">${pct(f.f1)}</td>
   <td class="num mono">${pct(f.auc)}</td></tr>`).join("");

function render(){
  if(i >= R.length){
    document.querySelector(".board").innerHTML =
      '<div class="panel done"><strong>Review complete.</strong><br>'+
      'You went through all '+R.length+' sampled slices. Agreement is shown above.</div>';
    return;
  }
  const r = R[i];
  document.getElementById("shot").src = r.thumb;
  document.getElementById("caseId").textContent = r.case_id;
  document.getElementById("counter").textContent = (i+1)+" / "+R.length;
  document.getElementById("foldTag").textContent = "fold "+r.fold;
  const isBme = r.pred === 1;
  const call = document.getElementById("call");
  call.textContent = isBme ? "BME present" : "No BME";
  call.className = "call " + (isBme ? "bme" : "clear");
  document.getElementById("truth").textContent = "labelled " + (r.true === 1 ? "BME" : "clear");
  const p = isBme ? r.prob : 1 - r.prob;
  document.getElementById("probBar").style.width = (p*100).toFixed(0)+"%";
  document.getElementById("probTxt").textContent = "model confidence " + (p*100).toFixed(1) + "%";
  stats();
}

function stats(){
  const v = Object.values(seen);
  const y = v.filter(x=>x===true).length, n = v.filter(x=>x===false).length;
  document.getElementById("nYes").textContent = y;
  document.getElementById("nNo").textContent = n;
  const el = document.getElementById("agreeRate"), sub = document.getElementById("agreeSub");
  if(y+n === 0){ el.innerHTML = "&ndash;"; sub.textContent = "no slices reviewed yet"; }
  else { el.textContent = ((y/(y+n))*100).toFixed(1)+"%";
         sub.textContent = "you agreed with the model on "+y+" of "+(y+n)+" reviewed"; }
  document.getElementById("prog").style.width = ((y+n)/R.length*100).toFixed(1)+"%";
}

function mark(ok){
  if(i >= R.length) return;
  seen[i] = ok;
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch(e){}
  i++; render();
}
function skip(){ if(i < R.length){ i++; render(); } }
function reset(){
  seen = {}; i = 0;
  try { localStorage.removeItem(KEY); } catch(e){}
  location.reload();
}
document.addEventListener("keydown", e=>{
  const k = e.key.toLowerCase();
  if(k === "a") mark(true);
  else if(k === "d") mark(false);
  else if(k === "s") skip();
});
i = Object.keys(seen).length;
render();
</script>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    args = ap.parse_args()

    res = Path(args.base) / "data" / "results2d"
    mp, rp = res / "metrics.json", res / "review.json"
    if not mp.exists():
        sys.exit(f"no {mp} — run ml/scripts/train_2d.py first")

    metrics = json.loads(mp.read_text(encoding="utf-8"))
    review = json.loads(rp.read_text(encoding="utf-8")) if rp.exists() else []

    html = (TEMPLATE
            .replace("__METRICS__", json.dumps(metrics))
            .replace("__REVIEW__", json.dumps(review))
            .replace("__NSLICE__", str(metrics["n_slices"]))
            .replace("__NCASE__", str(metrics["n_cases"]))
            .replace("__FOLDS__", str(metrics["folds"]))
            .replace("__SEED__", str(metrics["seed"]))
            .replace("__MODEL__", metrics["model"])
            .replace("__DEVICE__", metrics["device"]))

    out = res / "review.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out}  ({len(review)} slices to review)")
    print(f"  case-level  acc={metrics['case_level']['accuracy']:.3f} "
          f"f1={metrics['case_level']['f1']:.3f} auc={metrics['case_level']['auc']:.3f}")


if __name__ == "__main__":
    main()
