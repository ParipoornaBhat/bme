import { ask } from "./accounts.js";

/**
 * One look for every menu. Colours only on a real terminal that allows them
 * (NO_COLOR or a pipe turns them off), so logs and Windows cmd stay readable.
 */

const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: paint("1"),
  dim: paint("2"),
  green: paint("32"),
  yellow: paint("33"),
  red: paint("31"),
  cyan: paint("36"),
};

const WIDTH = 72;

export function title(text, sub = "") {
  console.log("");
  console.log(c.bold(c.cyan(`== ${text} `.padEnd(WIDTH, "="))));
  if (sub) console.log(c.dim(sub));
}

export function section(text) {
  console.log("");
  console.log(c.bold(text));
}

export const info = (s) => console.log(`  ${s}`);
export const ok = (s) => console.log(`  ${c.green("OK")}    ${s}`);
export const warn = (s) => console.log(`  ${c.yellow("NOTE")}  ${s}`);
export const bad = (s) => console.log(`  ${c.red("STOP")}  ${s}`);

/** The commands to run next, always at the end of a step. */
export function next(...cmds) {
  const list = cmds.flat().filter(Boolean);
  if (!list.length) return;
  console.log("");
  console.log(c.bold("Next"));
  for (const cmd of list) console.log(`  ${cmd}`);
}

/** Stop with a reason and what to do about it. */
export function stop(reason, ...fix) {
  console.log("");
  bad(reason);
  for (const f of fix.flat().filter(Boolean)) console.log(`        ${f}`);
  process.exit(1);
}

/**
 * Numbered menu. items: [{label, about, group?, disabled?}] -> the chosen item, or null.
 * A group heading prints when it changes. Enter or 0 = back / nothing.
 */
export async function choose(heading, items, { prompt = "Choose", allowBack = true } = {}) {
  if (heading) section(heading);
  let group = null;
  items.forEach((it, i) => {
    if (it.group && it.group !== group) {
      group = it.group;
      console.log("");
      console.log(`  ${c.dim(group)}`);
    }
    const num = String(i + 1).padStart(2);
    const label = it.disabled ? c.dim(`${it.label}  (${it.disabled})`) : it.label;
    console.log(`  ${c.bold(num)}. ${label}`);
    if (it.about) console.log(`      ${c.dim(it.about)}`);
  });
  console.log("");
  const back = allowBack ? ", Enter = back" : "";
  for (;;) {
    const raw = await ask(`${prompt} [1-${items.length}${back}]: `);
    if (!raw || raw === "0") {
      if (allowBack) return null;
      continue;
    }
    const it = items[Number(raw) - 1];
    if (!it) {
      console.log(`  Type a number from 1 to ${items.length}.`);
      continue;
    }
    if (it.disabled) {
      console.log(`  Not available: ${it.disabled}.`);
      continue;
    }
    return it;
  }
}

export function table(rows, headers) {
  const all = [headers, ...rows].map((r) => r.map((x) => String(x ?? "")));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => "  " + r.map((x, i) => x.padEnd(widths[i])).join("   ").trimEnd();
  console.log(c.bold(line(all[0])));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("   "));
  all.slice(1).forEach((r) => console.log(line(r)));
}
