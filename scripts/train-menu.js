import { runNode } from "./lib/accounts.js";
import { describeDevice, detectDevice } from "./lib/device.js";
import { trainOnKaggle } from "./lib/kaggle-flow.js";
import { METHODS, MORE_H200, PLATFORM } from "./lib/methods.js";
import { choose, info, next, title, warn } from "./lib/ui.js";

/**
 * pnpm train                    pick a method, then where it trains
 * pnpm train <n|id> [--as <who>] skip the first menu, e.g. pnpm train 3 --as reegan
 *
 * H200 methods continue by themselves when started again (4 h job limit);
 * Kaggle methods continue after the 12 h limit; this PC continues after Ctrl+C.
 */

function h200(m, as) {
  title(`College H200: ${m.label}`, PLATFORM.h200.limit);
  info("Next it asks which account, checks the network route, sends only changed files,");
  info("and shows what is already done before it submits one job.");
  const code = runNode("h200-menu.js", [...m.h200, ...(as ? ["--as", as] : [])]);
  if (code === 0) next("pnpm runs:status   where every run is", "pnpm runs:log      follow this job's log live");
  process.exit(code);
}

async function where(m, as) {
  const d = detectDevice();
  const home = m.where === "h200"
    ? { label: PLATFORM.h200.name, about: PLATFORM.h200.limit, run: () => h200(m, as) }
    : { label: PLATFORM.kaggle.name, about: PLATFORM.kaggle.limit, run: () => trainOnKaggle(m, as) };
  let local;
  if (!m.local) {
    local = { label: PLATFORM.local.name, disabled: m.needsMib ? "needs about 9 GB of GPU memory" : "not set up for this method" };
    if (m.needsMib && d.kind === "cuda" && d.mib >= m.needsMib) local.disabled = "fits this GPU, but only the H200 path is set up";
  } else {
    local = {
      label: `${PLATFORM.local.name}: ${describeDevice(d)}`,
      about: d.kind === "cpu" ? "no usable GPU here, so it would be very slow; it asks first" : `${PLATFORM.local.limit}; smaller laptop setup`,
      run: () => process.exit(runNode("train-local.js", [m.id])),
    };
  }
  const pick = await choose(`Where should "${m.n}. ${m.label}" train?`, [home, local], { prompt: "Where" });
  if (pick) await pick.run();
}

async function more(as) {
  const pick = await choose("More H200 runs", MORE_H200.map((x) => ({ ...x })), { prompt: "Which" });
  if (pick) h200(pick, as);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const asIdx = argv.indexOf("--as");
const as = asIdx >= 0 ? argv[asIdx + 1] || "" : "";
if (asIdx >= 0) argv.splice(asIdx, 2);

if (argv[0]) {
  const m = METHODS.find((x) => x.id === argv[0] || String(x.n) === argv[0]);
  if (!m) {
    warn(`No method ${argv[0]}. Methods: ${METHODS.map((x) => `${x.n} ${x.id}`).join(", ")}`);
    process.exit(1);
  }
  await where(m, as);
} else {
  title("Train", "Same seed and patient-level folds everywhere. Compare runs within one platform.");
  const items = [
    ...METHODS.map((m) => ({
      group: m.where === "h200" ? `College H200 (${PLATFORM.h200.limit})` : `Kaggle (${PLATFORM.kaggle.limit})`,
      label: `${m.label}`,
      about: m.tests,
      run: () => where(m, as),
    })),
    { group: "Other", label: "More H200 runs", about: "augmentation low, the no-augmentation control, the 2D U-Net", run: () => more(as) },
    { label: "Train on this PC", about: "the app's quick 2D/3D models, or a method in a laptop setup", run: () => process.exit(runNode("train-local.js")) },
    { label: "The fixed 80/20 split", about: "show which scans train and which validate (method 5); make it once", run: () => process.exit(runNode("split.js")) },
  ];
  const pick = await choose("", items, { prompt: "Which method" });
  if (pick) await pick.run();
}
