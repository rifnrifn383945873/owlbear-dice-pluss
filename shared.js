// Shared by the popover (index.html) and the background page (background.html).

export const CHANNEL = "local.dice-plus/roll";
export const SIDES = [4, 6, 8, 10, 12, 20, 100];
const HISTORY_MAX = 30;

// Loads the Owlbear Rodeo SDK and waits until the room is ready.
// Resolves null when the page is opened outside Owlbear (plain browser test).
export async function loadOBR() {
  try {
    const { default: OBR } = await import("https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm");
    if (!OBR.isAvailable) return null;
    await new Promise(resolve => (OBR.isReady ? resolve() : OBR.onReady(resolve)));
    return OBR;
  } catch (e) {
    return null;
  }
}

// ---- dice

function randInt(max) {
  // Unbiased integer in 1..max
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return (buf[0] % max) + 1;
}

// D&D-style ability modifier: 10 → 0, 16 → +3, 7 → −2.
// With round, halves go away from zero instead: 15 → +3, 9 → −1, 7 → −2.
export const statMod = (v, round = false) => {
  const half = (v - 10) / 2;
  return round ? Math.sign(half) * Math.round(Math.abs(half)) : Math.floor(half);
};
// Value a stat adds to a roll for the chosen mode
export const statAdd = (v, mode) =>
  mode === "raw" ? v : mode === "minus10" ? v - 10 : statMod(v, mode === "modRound");

// "+1d4", "-2", "1d6+1", "-1d4 + 3", "+@힘" → [{sign, count, sides}|{sign, flat}|{sign, stat}]
export function parseExpr(text) {
  const src = String(text).replace(/\s+/g, "").toLowerCase();
  if (!src) return null;
  const terms = [];
  const re = /([+-]?)(?:(\d*)d(\d+)|(\d+)|@([^+\-@]+))/gy;
  let m;
  while (re.lastIndex < src.length) {
    m = re.exec(src);
    if (!m || !m[0]) return null;
    const sign = m[1] === "-" ? -1 : 1;
    if (m[3]) {
      const count = m[2] ? +m[2] : 1, sides = +m[3];
      if (count < 1 || count > 50 || sides < 2 || sides > 1000) return null;
      terms.push({ sign, count, sides });
    } else if (m[5]) terms.push({ sign, stat: m[5] });
    else terms.push({ sign, flat: +m[4] });
  }
  return terms.length ? terms : null;
}

export function formatTerms(terms) {
  return terms.map((t, i) => {
    const sign = t.sign < 0 ? "−" : i ? "+" : "";
    const body = "stat" in t ? "@" + t.stat : "flat" in t ? (t.label ? `${t.label}(${t.flat})` : t.flat) : `${t.count}d${t.sides}`;
    return (i ? ` ${sign} ` : sign) + body;
  }).join("");
}

// setup: { pool: {sides: {plus, minus}}, mode: "normal"|"adv"|"dis", flat, bonuses: [{name, expr, on}], target, rule }
// Returns a roll record ready to share.
export function roll(setup) {
  const parts = [];   // {label, sign, values, kept, sides}
  let total = 0;
  let natural = null; // kept value of the advantage/plain d20 when there is exactly one
  const plusD20 = setup.pool[20]?.plus || 0;

  // Added dice first, then subtracted dice, so the breakdown reads like the formula
  for (const sign of [1, -1]) {
    for (const sides of SIDES) {
      const { plus = 0, minus = 0 } = setup.pool[sides] || {};
      const count = sign > 0 ? plus : minus;
      if (!count) continue;
      const values = [];
      let sum = 0;
      for (let i = 0; i < count; i++) {
        if (sides === 20 && sign > 0 && setup.mode !== "normal") {
          const a = randInt(20), b = randInt(20);
          const kept = setup.mode === "adv" ? Math.max(a, b) : Math.min(a, b);
          values.push(`${kept}(${a},${b})`);
          sum += kept;
          if (plusD20 === 1) natural = kept;
        } else {
          const v = randInt(sides);
          values.push(String(v));
          sum += v;
          if (sides === 20 && sign > 0 && plusD20 === 1) natural = v;
        }
      }
      total += sign * sum;
      parts.push({ label: `${count}d${sides}`, sign, values, sum });
    }
  }

  // Stats are read at roll time, so changing a stat mid-game applies to the next roll
  const stats = statMap(setup.stats);
  let stat = null;
  let target = setup.target === "" || setup.target == null ? null : Number(setup.target);
  let rule = setup.rule;
  const picked = setup.useStat ? setup.useStat.toLowerCase() : "";
  if (picked && picked in stats) {
    const value = stats[picked];
    const name = setup.stats.find(s => s.name.toLowerCase() === picked).name;
    if (setup.statMode === "target") { target = value; rule = "le"; stat = { name, value, add: 0, mode: "target" }; }
    else {
      const add = statAdd(value, setup.statMode);
      total += add;
      stat = { name, value, add, mode: setup.statMode };
    }
  }

  const used = [];
  for (const b of setup.bonuses.filter(b => b.on)) {
    const terms = parseExpr(b.expr);
    if (!terms) continue;
    let sum = 0;
    const values = [];
    for (const t of terms) {
      if ("stat" in t) { const v = stats[t.stat] ?? 0; sum += t.sign * v; values.push(`${t.sign < 0 ? "−" : "+"}${t.stat}(${v})`); continue; }
      if ("flat" in t) { sum += t.sign * t.flat; values.push((t.sign < 0 ? "−" : "+") + t.flat); continue; }
      const rolled = Array.from({ length: t.count }, () => randInt(t.sides));
      const s = rolled.reduce((a, v) => a + v, 0);
      sum += t.sign * s;
      values.push(`${t.sign < 0 ? "−" : "+"}${t.count}d${t.sides}[${rolled.join(",")}]`);
    }
    total += sum;
    used.push({ name: b.name, sum, detail: values.join(" ") });
  }

  const flat = Number(setup.flat) || 0;
  total += flat;

  let verdict = null;
  if (target != null && !Number.isNaN(target) && rule !== "none") {
    const ok = rule === "le" ? total <= target : total >= target;
    verdict = ok ? "성공" : "실패";
  }
  let crit = null;
  if (natural === 20) crit = "대성공";
  else if (natural === 1) crit = "대실패";

  return {
    id: Date.now().toString(36) + randInt(1e6).toString(36),
    at: Date.now(),
    label: (setup.label || "").slice(0, 40),
    mode: setup.mode,
    parts, stat, bonuses: used, flat, total, target, rule, verdict, crit,
  };
}

// [{name, value}] → {lowercased name: number}
export function statMap(list) {
  return Object.fromEntries((list || []).map(s => [String(s.name).toLowerCase(), Number(s.value) || 0]));
}

export function describe(r) {
  const bits = [];
  r.parts.forEach((p, i) => {
    const sign = p.sign < 0 ? "−" : i ? "+" : "";
    bits.push(`${i ? ` ${sign} ` : sign}${p.label}[${p.values.join(",")}]`);
  });
  if (r.stat && r.stat.mode !== "target") bits.push(` ${r.stat.add < 0 ? "−" : "+"} ${r.stat.name}${r.stat.mode !== "raw" ? `(${r.stat.value})` : ""} ${Math.abs(r.stat.add)}`);
  for (const b of r.bonuses) bits.push(` ${b.sum < 0 ? "−" : "+"} ${b.name} ${Math.abs(b.sum)}`);
  if (r.flat) bits.push(` ${r.flat < 0 ? "−" : "+"} ${Math.abs(r.flat)}`);
  return bits.join("").trim();
}

export function verdictText(r) {
  const out = [];
  if (r.crit) out.push(r.crit);
  const by = r.stat?.mode === "target" ? `${r.stat.name} ` : "";
  if (r.verdict) out.push(`${r.verdict} (목표 ${by}${r.target}${r.rule === "le" ? " 이하" : " 이상"})`);
  return out.join(" · ");
}

// ---- history (shared by both pages through localStorage, same origin)

export const historyKey = roomId => `dicePlus:history:${roomId || "local"}`;

export function readHistory(roomId) {
  try {
    const v = JSON.parse(localStorage.getItem(historyKey(roomId)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

export function pushHistory(roomId, record) {
  const list = readHistory(roomId).filter(r => r.id !== record.id);
  list.unshift(record);
  try { localStorage.setItem(historyKey(roomId), JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) {}
  return list.slice(0, HISTORY_MAX);
}
