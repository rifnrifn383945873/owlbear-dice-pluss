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

// "+1d4", "-2", "1d6+1", "-1d4 + 3" → [{sign, count, sides}|{sign, flat}]
export function parseExpr(text) {
  const src = String(text).replace(/\s+/g, "").toLowerCase();
  if (!src) return null;
  const terms = [];
  const re = /([+-]?)(?:(\d*)d(\d+)|(\d+))/gy;
  let m;
  while (re.lastIndex < src.length) {
    m = re.exec(src);
    if (!m || !m[0]) return null;
    const sign = m[1] === "-" ? -1 : 1;
    if (m[3]) {
      const count = m[2] ? +m[2] : 1, sides = +m[3];
      if (count < 1 || count > 50 || sides < 2 || sides > 1000) return null;
      terms.push({ sign, count, sides });
    } else terms.push({ sign, flat: +m[4] });
  }
  return terms.length ? terms : null;
}

export function formatTerms(terms) {
  return terms.map((t, i) => {
    const sign = t.sign < 0 ? "−" : i ? "+" : "";
    const body = "flat" in t ? t.flat : `${t.count}d${t.sides}`;
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

  const used = [];
  for (const b of setup.bonuses.filter(b => b.on)) {
    const terms = parseExpr(b.expr);
    if (!terms) continue;
    let sum = 0;
    const values = [];
    for (const t of terms) {
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
  const target = setup.target === "" || setup.target == null ? null : Number(setup.target);
  if (target != null && !Number.isNaN(target) && setup.rule !== "none") {
    const ok = setup.rule === "le" ? total <= target : total >= target;
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
    parts, bonuses: used, flat, total, target, rule: setup.rule, verdict, crit,
  };
}

export function describe(r) {
  const bits = [];
  r.parts.forEach((p, i) => {
    const sign = p.sign < 0 ? "−" : i ? "+" : "";
    bits.push(`${i ? ` ${sign} ` : sign}${p.label}[${p.values.join(",")}]`);
  });
  for (const b of r.bonuses) bits.push(` ${b.sum < 0 ? "−" : "+"} ${b.name} ${Math.abs(b.sum)}`);
  if (r.flat) bits.push(` ${r.flat < 0 ? "−" : "+"} ${Math.abs(r.flat)}`);
  return bits.join("").trim();
}

export function verdictText(r) {
  const out = [];
  if (r.crit) out.push(r.crit);
  if (r.verdict) out.push(`${r.verdict} (목표 ${r.target}${r.rule === "le" ? " 이하" : " 이상"})`);
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
