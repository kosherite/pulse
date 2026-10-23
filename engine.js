/* Pulse engine for the browser (Bluefy on iPhone).
 *
 * A JavaScript port of pulse.py: the WHOOP 5.0 protocol (after NOOP), per-minute storage in IndexedDB,
 * NOOP-style sleep detection and staging, and the scores. The page talks to it through Pulse.api(path),
 * which answers the same requests the Mac server did, so the interface is shared.
 * Protocol details come from NOOP (github.com/ryanbr/noop, PolyForm Noncommercial 1.0.0 - personal use).
 */
(function (root) {
"use strict";

/* ------------------------------------------------------------------ protocol */
const SVC = "fd4b0001-cce1-4033-93ce-002d5875f58a";
const CMD = "fd4b0002-cce1-4033-93ce-002d5875f58a";
const NOTIFY = ["fd4b0003-cce1-4033-93ce-002d5875f58a", "fd4b0004-cce1-4033-93ce-002d5875f58a",
  "fd4b0005-cce1-4033-93ce-002d5875f58a", "fd4b0007-cce1-4033-93ce-002d5875f58a"];
const HELLO = hex("aa0108000001e67123019101363e5c8d");
const C = { REALTIME_HR: 3, SET_CLOCK: 10, GET_CLOCK: 11, HISTORY: 22, HISTORY_ACK: 23, R10_R11: 63, PACK_INFO: 151 };
const T = { RESPONSE: 36, HISTORY: 47, EVENT: 48, META: 49 };
const M = { START: 1, END: 2, DONE: 3 };
const E = { PACK_INFO: 109, CHARGE_ON: 7, CHARGE_OFF: 8, PACK_ON: 21, PACK_OFF: 22 };
const VALID_FROM = 1704067200;                       // readings dated before 2024 are a reset strap clock

function hex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }
function crc16(d) { let c = 0xFFFF; for (const b of d) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xA001 : c >>> 1; } return c; }
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = 0xFFFFFFFF; for (const b of d) c = CRC_T[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const u16 = (f, o) => f[o] | f[o + 1] << 8;
const u32 = (f, o) => (f[o] | f[o + 1] << 8 | f[o + 2] << 16 | f[o + 3] << 24) >>> 0;
const le32 = v => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];

function command(cmd, seq, payload = [0], kind = 35) {
  let inner = [kind, seq & 0xFF, cmd & 0xFF, ...payload];
  while (inner.length % 4) inner.push(0);
  const n = inner.length + 4, head = [0xAA, 0x01, n & 0xFF, n >> 8, 0x00, 0x01];
  const h = crc16(head), c = crc32(inner);
  return new Uint8Array([...head, h & 0xFF, h >> 8, ...inner, ...le32(c)]);
}
function frameOk(f) {
  if (f.length < 13 || f[0] !== 0xAA) return false;
  const total = u16(f, 2) + 8;
  return total === f.length && crc16(f.subarray(0, 6)) === u16(f, 6) && crc32(f.subarray(8, total - 4)) === u32(f, total - 4);
}
class Reassembler {
  constructor() { this.buf = new Uint8Array(0); }
  feed(data) {
    const b = new Uint8Array(this.buf.length + data.length); b.set(this.buf); b.set(data, this.buf.length); this.buf = b;
    const out = [];
    for (;;) {
      const i = this.buf.indexOf(0xAA);
      if (i < 0) { this.buf = new Uint8Array(0); return out; }
      if (i) this.buf = this.buf.slice(i);
      if (this.buf.length < 4) return out;
      const total = u16(this.buf, 2) + 8;
      if (total < 13 || total > 4096) { this.buf = this.buf.slice(1); continue; }
      if (this.buf.length < total) return out;
      out.push(this.buf.slice(0, total)); this.buf = this.buf.slice(total);
    }
  }
}
function f32(f, o) { return new DataView(f.buffer, f.byteOffset + o, 4).getFloat32(0, true); }
function decodeRecord(f) {
  if (f.length < 84 || f[8] !== T.HISTORY || f[9] !== 18) return null;
  const t = u32(f, 15), hr = f[22], rr = [];
  for (let i = 0; i < Math.min(f[23], 4); i++) { const v = u16(f, 24 + 2 * i); if (v) rr.push(v); }
  const temp = u16(f, 73) / 100, motion = f32(f, 41), sb = f[81];
  const g = [f32(f, 45), f32(f, 49), f32(f, 53)], gm = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
  return { t, hr: hr >= 30 && hr <= 220 ? hr : null, rr, temp: temp >= 5 && temp <= 45 ? temp : null, steps: u16(f, 57),
    act: [0, 1, 2].includes(f[63]) ? f[63] : null, motion: Number.isFinite(motion) && motion >= 0 && motion <= 8 ? motion : null,
    sleep: (sb >> 4) & 3, wrist: sb & 3, grav: g.every(Number.isFinite) && gm >= 0.5 && gm <= 1.5 ? g : null };
}
function decodeMeta(f) {
  if (f.length < 11 || f[8] !== T.META) return [null, null];
  const kind = f[10];
  return [kind, kind === M.END && f.length >= 29 && frameOk(f) ? Array.from(f.subarray(21, 29)) : null];
}
function decodePack(f, base) {
  if (f.length < base + 25) return null;
  if (f[base] !== 1) return { present: false };
  let s = ""; for (let i = base + 7; i < base + 23 && f[i]; i++) s += String.fromCharCode(f[i]);
  const soc = u16(f, base + 23) / 10;
  return { present: true, serial: s || null, soc: soc >= 0 && soc <= 100 ? soc : null };
}
const ack = (end, seq) => command(C.HISTORY_ACK, seq, [1, ...end]);
const setClock = (now, seq) => command(C.SET_CLOCK, seq, [...le32(Math.floor(now)), 0, 0, 0, 0, 0]);
function parseHR(d) {
  const f = d[0]; let bpm, i;
  if (f & 1) { bpm = u16(d, 1); i = 3; } else { bpm = d[1]; i = 2; }
  if (f & 8) i += 2;
  const rr = [];
  while (f & 0x10 && i + 1 < d.length) { rr.push(Math.round(u16(d, i) / 1024 * 1000)); i += 2; }
  return [bpm, rr];
}

/* ------------------------------------------------------------------ small maths */
const sum = a => { let s = 0; for (const x of a) s += x; return s; };
const median = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pstdev = v => { const m = sum(v) / v.length; return Math.sqrt(sum(v.map(x => (x - m) ** 2)) / v.length); };
const round = (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k; };
const clamp01 = x => Math.max(0, Math.min(1, x));
const now = () => Date.now() / 1000;
function localDay(t) { const d = new Date(t * 1000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function dayStart(day) { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d).getTime() / 1000; }
function addDays(day, n) { const [y, m, d] = day.split("-").map(Number); return localDay(new Date(y, m - 1, d + n, 12).getTime() / 1000); }

/* ------------------------------------------------------------------ minute rows */
// sec tuple: [t, hr, rr(array|null), temp, steps, act, motion, sleep, wrist, src, gx, gy, gz]
const MIN_COLS = ["t", "hr", "hr_min", "hr_max", "n", "rmssd", "rr_n", "temp", "steps", "walk", "run", "motion",
  "asleep", "still", "wake", "strap", "hr_sd", "still_n", "mv_n", "jerk_med", "jerk_max", "resp"];
const STILL_G = 0.01;
function secTuple(r) {
  const g = r.grav || [null, null, null];
  return [r.t, r.hr, r.rr && r.rr.length ? r.rr : null, r.temp, r.steps, r.act, r.motion, r.sleep, r.wrist, 1, g[0], g[1], g[2]];
}
function minuteRow(m, rows) {
  let prev = null; const hrs = [], rrs = [], temps = [], motions = [], beats = [], grav = [];
  let steps = 0, walk = 0, run = 0, asleep = 0, still = 0, wake = 0, strap = 0;
  for (const [t, hr, rr, temp, st, act, motion, sleep, , src, gx, gy, gz] of rows) {
    if (t < m) { prev = st; if (gx != null) grav.push([t, gx, gy, gz]); continue; }
    if (hr) hrs.push(hr);
    if (rr) for (const x of rr) { rrs.push(x); beats.push([t, x]); }
    if (src === 1) {
      strap++;
      if (temp && temp >= 28 && temp <= 40) temps.push(temp);
      if (motion != null) motions.push(motion);
      if (gx != null) grav.push([t, gx, gy, gz]);
      if (st != null) {
        if (prev != null) { const d = st >= prev ? st - prev : (prev > 60000 ? st + 65536 - prev : 0); if (d > 0 && d <= 5) steps += d; }
        prev = st;
      }
      walk += act === 1; run += act === 2; asleep += sleep === 2; still += sleep === 1; wake += sleep === 0 || sleep === 3;
    }
  }
  if (!hrs.length && !strap) return null;
  const ok = rrs.filter(x => x >= 300 && x <= 2000), diffs = [];
  for (let i = 1; i < ok.length; i++) if (Math.abs(ok[i] - ok[i - 1]) < 250) diffs.push((ok[i] - ok[i - 1]) ** 2);
  const rmssd = diffs.length >= 15 ? Math.sqrt(sum(diffs) / diffs.length) : null;
  let jerks = [];
  for (let i = 1; i < grav.length; i++) {
    const a = grav[i - 1], b = grav[i], dt = b[0] - a[0];
    if (dt > 0 && dt <= 2) jerks.push(Math.sqrt((a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 + (a[3] - b[3]) ** 2));
  }
  if (jerks.length < 20) jerks = motions;
  return [m, hrs.length ? sum(hrs) / hrs.length : null, hrs.length ? Math.min(...hrs) : null, hrs.length ? Math.max(...hrs) : null,
    hrs.length, rmssd, ok.length, temps.length ? sum(temps) / temps.length : null, steps, walk, run,
    motions.length ? sum(motions) / motions.length : null, asleep, still, wake, strap,
    hrs.length >= 2 ? pstdev(hrs) : null, jerks.length ? jerks.filter(j => j < STILL_G).length : null,
    jerks.length || null, median(jerks), jerks.length ? Math.max(...jerks) : null, respRegularity(beats)];
}
const DFT = new Map();
function respRegularity(beats) {
  beats = beats.map(([t, v]) => [t, Math.min(Math.max(v, 300), 2000)]);
  if (beats.length < 12) return null;
  const t0 = beats[0][0], tn = beats[beats.length - 1][0], n = Math.ceil((tn - t0) / 0.25 - 1e-9);
  if (tn <= t0 || n < 16) return null;
  const y = new Float64Array(n); let seg = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + 0.25 * i;
    while (seg < beats.length - 2 && beats[seg + 1][0] < t) seg++;
    const [ta, va] = beats[seg], [tb, vb] = beats[seg + 1];
    y[i] = tb <= ta ? va : va + Math.min(Math.max((t - ta) / (tb - ta), 0), 1) * (vb - va);
  }
  const mean = sum(y) / n; for (let i = 0; i < n; i++) y[i] -= mean;
  const kLo = Math.ceil(0.15 * 0.25 * n), kHi = Math.floor(0.40 * 0.25 * n);
  if (kHi < kLo) return null;
  if (!DFT.has(n)) {
    const tab = [];
    for (let k = kLo; k <= kHi; k++) {
      const c = new Float64Array(n), s = new Float64Array(n);
      for (let j = 0; j < n; j++) { c[j] = Math.cos(-2 * Math.PI * k * j / n); s[j] = Math.sin(-2 * Math.PI * k * j / n); }
      tab.push([c, s]);
    }
    DFT.set(n, tab);
  }
  const p = DFT.get(n).map(([c, s]) => { let re = 0, im = 0; for (let j = 0; j < n; j++) { re += y[j] * c[j]; im += y[j] * s[j]; } return re * re + im * im; });
  const tot = sum(p);
  return tot ? Math.max(...p) / tot : null;
}
const rowObj = r => { const o = {}; MIN_COLS.forEach((k, i) => { o[k] = r[i] === undefined ? null : r[i]; }); return o; };

/* ------------------------------------------------------------------ sleep (after NOOP SleepStager + V2) */
const STILL_WIN = 15, STILL_FRAC = 0.70, MAX_GAP = 20, MERGE_MIN = 15, MIN_SLEEP = 60;
const HR_BAND = 1.05, QUIET_BAND = 1.30, BRIDGE_ACTIVE = 30, BRIDGE_ACTIVE_INBAND = 60, CHAIN_GAP = 90;
const STAGES = ["deep", "rem", "light", "wake"];
const PRIOR = { light: Math.log(0.50), deep: Math.log(0.15), rem: Math.log(0.22), wake: Math.log(0.10) };
const T30 = { deep: { deep: .86, rem: .007, light: .126, wake: .007 }, rem: { deep: .005, rem: .88, light: .10, wake: .015 },
  light: { deep: .06, rem: .06, light: .85, wake: .03 }, wake: { deep: 0, rem: 0, light: .10, wake: .90 } };
const TRANS = {};
for (const a of STAGES) { TRANS[a] = {}; for (const b of STAGES) TRANS[a][b] = Math.log(Math.max(sum(STAGES.map(k => T30[a][k] * T30[k][b])), 1e-9)); }

function stillShare(r) {
  if (r.mv_n && r.mv_n >= 20) return r.still_n / r.mv_n;
  if (r.motion != null) return r.motion < 0.015 ? 1 : 0;
  return null;
}
function runsOf(ts, flags) {
  const out = [];
  ts.forEach((t, i) => {
    const last = out[out.length - 1];
    if (last && last[0] === flags[i] && t - ts[i - 1] <= MAX_GAP * 60) last[2] = t + 60; else out.push([flags[i], t, t + 60]);
  });
  return out;
}
function mergeRuns(runs, minutes = MERGE_MIN) {
  const pend = runs.map(r => [...r]), out = []; let i = 0;
  while (i < pend.length) {
    const cur = pend[i];
    if (cur[2] - cur[1] >= minutes * 60) { out.push(cur); i++; continue; }
    const hasPrev = out.length > 0, hasNext = i + 1 < pend.length;
    if (hasPrev && hasNext && out[out.length - 1][0] === pend[i + 1][0]) { out[out.length - 1][2] = pend[i + 1][2]; i += 2; }
    else if (hasNext) { pend[i + 1][1] = cur[1]; i++; }
    else if (hasPrev) { out[out.length - 1][2] = cur[2]; i++; }
    else i++;
  }
  return out;
}
function findSessions(rows) {
  const hrs = rows.filter(r => r.hr).map(r => r.hr);
  if (hrs.length < 60) return [[], null, null, new Map()];
  const base = median(hrs), ts = rows.map(r => r.t), share = rows.map(stillShare);
  let method, flags;
  if (share.filter(v => v != null).length >= 0.5 * rows.length) {
    method = "motion"; flags = [];
    for (let i = 0; i < rows.length; i++) {
      const w = share.slice(Math.max(0, i - (STILL_WIN >> 1)), i + (STILL_WIN >> 1) + 1).filter(v => v != null);
      flags.push(w.length > 0 && sum(w) / w.length >= STILL_FRAC);
    }
  } else {
    method = "heart rate";
    const p10 = [...hrs].sort((a, b) => a - b)[Math.floor((hrs.length - 1) * 0.10)];
    flags = rows.map(r => !!r.hr && r.hr <= p10 * 1.05);
  }
  flags = flags.map((f, i) => f || (rows[i].strap >= 30 && rows[i].asleep >= 30));
  const runs = mergeRuns(runsOf(ts, flags)), byT = new Map(rows.map(r => [r.t, r]));
  const span = (a, z) => { const o = []; for (let t = a; t < z; t += 60) if (byT.has(t)) o.push(byT.get(t)); return o; };
  const hrMed = (a, z) => median(span(a, z).filter(r => r.hr).map(r => r.hr));
  let i = 1;
  while (i + 1 < runs.length) {
    const a = runs[i - 1], mid = runs[i], b = runs[i + 1];
    if (a[0] && !mid[0] && b[0]) {
      const m = hrMed(mid[1], mid[2]), inBand = m != null && m <= base * HR_BAND, cap = inBand ? BRIDGE_ACTIVE_INBAND : BRIDGE_ACTIVE;
      if (mid[2] - mid[1] <= cap * 60 && inBand) { runs.splice(i - 1, 3, [true, a[1], b[2]]); continue; }
    }
    i++;
  }
  const kept = [];
  for (const [st, a, z] of runs) {
    if (!st || z - a <= MIN_SLEEP * 60) continue;
    const seg = span(a, z), m = hrMed(a, z), sh = seg.map(stillShare).filter(v => v != null);
    const quiet = sh.length > 0 && sum(sh) / sh.length >= 0.90, strap = seg.filter(r => r.strap >= 30);
    const bandOk = strap.length >= 30 && strap.filter(r => r.asleep >= 30).length / strap.length >= 0.6;
    if (bandOk || m == null || m <= base * (quiet ? QUIET_BAND : HR_BAND)) kept.push([a, z]);
  }
  const chains = [];
  for (const [a, z] of kept) {
    const last = chains[chains.length - 1];
    if (last && a - last[last.length - 1][1] <= CHAIN_GAP * 60) last.push([a, z]); else chains.push([[a, z]]);
  }
  if (!chains.length) return [[], method, base, new Map()];
  let best = chains[0], bestLen = -1;
  for (const c of chains) { const l = sum(c.map(([a, z]) => z - a)); if (l > bestLen) { best = c; bestLen = l; } }
  return [best, method, base, new Map(ts.map((t, i) => [t, flags[i]]))];
}
function pooledSd(rs) {
  rs = rs.filter(r => r.hr && r.n);
  const n = sum(rs.map(r => r.n));
  if (n < 2) return null;
  const m = sum(rs.map(r => r.hr * r.n)) / n;
  return Math.sqrt(sum(rs.map(r => r.n * ((r.hr_sd || 0) ** 2 + (r.hr - m) ** 2))) / n);
}
function viterbi(em) {
  let v = { ...em[0] }; const back = [];
  for (const e of em.slice(1)) {
    const nv = {}, bp = {};
    for (const s of STAGES) {
      let p = STAGES[0];
      for (const q of STAGES) if (v[q] + TRANS[q][s] > v[p] + TRANS[p][s]) p = q;
      nv[s] = v[p] + TRANS[p][s] + e[s]; bp[s] = p;
    }
    v = nv; back.push(bp);
  }
  let last = STAGES[0]; for (const s of STAGES) if (v[s] > v[last]) last = s;
  const path = [last];
  for (let i = back.length - 1; i >= 0; i--) { last = back[i][last]; path.push(last); }
  return path.reverse();
}
function stageMinutes(seg, start, end) {
  if (!seg.length) return [];
  const spanS = Math.max(60, end - start), byT = new Map(seg.map(r => [r.t, r])), grid = [];
  for (let t = start; t < end; t += 60) grid.push(t);
  const meds = seg.filter(r => r.jerk_med != null).map(r => r.jerk_med), jscale = meds.length ? median(meds) : null;
  const near = (t, lo, hi) => { const o = []; for (let x = t + lo; x < t + hi; x += 60) if (byT.has(x)) o.push(byT.get(x)); return o; };
  const feats = grid.map(t => {
    const r = byT.get(t), sh = r ? stillShare(r) : null;
    return { t, hr: r ? r.hr : null, var: pooledSd(near(t, -120, 180)), flat: pooledSd(near(t, -300, 360)),
      move: sh == null ? null : 1 - sh, jmax: r ? r.jerk_max : null, resp: r ? r.resp : null,
      clock: (t + 30 - start) / spanS, mins: (t + 30 - start) / 60 };
  });
  const zf = key => {
    const v = feats.map(f => f[key]).filter(x => x != null);
    if (!v.length) return () => 0;
    const m = sum(v) / v.length, sd = Math.sqrt(sum(v.map(x => (x - m) ** 2)) / v.length) || 1;
    return x => x == null ? 0 : (x - m) / sd;
  };
  const zhr = zf("hr"), zhv = zf("var"), zmv = zf("move"), zrg = zf("resp");
  const flat = feats.map(f => f.flat).filter(x => x != null).sort((a, b) => a - b);
  const fpct = x => {
    if (x == null || !flat.length) return 0.5;
    let lo = 0, hi = flat.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (flat[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo / flat.length;
  };
  const em = feats.map(f => {
    const a = zhr(f.hr), b = zhv(f.var), c = zmv(f.move), gate = 5 * Math.max(0, fpct(f.flat) - 0.25);
    let cardiac = 0.8 * b + 0.4 * a;
    const quiet = (f.move || 0) <= 0 && (jscale == null || f.jmax == null || f.jmax <= jscale * 55);
    if (quiet) cardiac = Math.min(0, cardiac);
    const e = { deep: -1.1 * b - 0.5 * c - gate + PRIOR.deep + 1.2 * Math.max(0, 1 - f.clock / 0.55),
      rem: 0.6 * b - 0.6 * c + 0.4 * a + PRIOR.rem + f.clock, light: PRIOR.light, wake: c + cardiac + PRIOR.wake };
    if (jscale && f.jmax != null && f.jmax > jscale * 55) e.wake += 2;
    if (f.resp != null) { const z = zrg(f.resp); e.deep += 0.6 * z; e.rem -= 0.6 * z; }
    return e;
  });
  const first = viterbi(em); let run = 0, origin = 0;
  for (let i = 0; i < first.length; i++) { run = first[i] === "wake" ? 0 : run + 1; if (run >= 5) { origin = feats[i - 4].mins; break; } }
  feats.forEach((f, i) => { em[i].rem -= 3 * Math.min(1, Math.max(0, 1 - (f.mins - origin) / 60)); });
  const labels = viterbi(em);
  let i = 0;
  while (i < labels.length) {
    let j = i; while (j < labels.length && labels[j] === labels[i]) j++;
    if (j - i < 3 && (i > 0 || j < labels.length)) { const fill = i > 0 ? labels[i - 1] : labels[j]; for (let k = i; k < j; k++) labels[k] = fill; }
    i = j;
  }
  return grid.map((t, k) => [t, labels[k]]);
}
function lowestAvg(vals, width = 5) {
  let best = null;
  for (let i = 0; i + width <= vals.length; i++) { const a = sum(vals.slice(i, i + width)) / width; if (best == null || a < best) best = a; }
  return best;
}
function decimate(S, n = 240) {
  if (S.length <= n) return S;
  const t0 = S[0][0], t1 = S[S.length - 1][0], w = Math.max(1, (t1 - t0) / n), slots = new Map();
  for (const [t, v] of S) { const k = Math.min(n - 1, Math.floor((t - t0) / w)); if (!slots.has(k)) slots.set(k, []); slots.get(k).push([t, v]); }
  return [...slots.keys()].sort((a, b) => a - b).map(k => { const c = slots.get(k); return [Math.round(sum(c.map(x => x[0])) / c.length), round(sum(c.map(x => x[1])) / c.length, 1)]; });
}
function nightFor(rows, day) {
  // rows: minute objects between 6 pm the day before and 2 pm on `day`, sorted by t
  if (rows.length < 60) return null;
  const [runs, method, , sleepy] = findSessions(rows);
  if (!runs.length) return null;
  let a = runs[0][0], z = runs[runs.length - 1][1];
  let seg = rows.filter(r => r.t >= a && r.t < z);
  const ok = r => sleepy.get(r.t) || (stillShare(r) || 0) >= STILL_FRAC;
  for (let i = 0; i + 2 < seg.length; i++) if (ok(seg[i]) && ok(seg[i + 1]) && ok(seg[i + 2])) { a = seg[i].t; break; }
  for (let i = seg.length - 1; i >= 0; i--) if (ok(seg[i])) { z = seg[i].t + 60; break; }
  seg = rows.filter(r => r.t >= a && r.t < z);
  const inside = t => runs.some(([x, y]) => x <= t && t < y);
  const labels = stageMinutes(seg, a, z).map(([t, s]) => [t, inside(t) ? s : "wake"]);
  const total = labels.length, count = { deep: 0, rem: 0, light: 0, wake: 0 };
  for (const [, s] of labels) count[s]++;
  const asleep = total - count.wake;
  if (asleep < MIN_SLEEP) return null;
  const stages = [];
  for (const [t, s] of labels) { const l = stages[stages.length - 1]; if (l && l[2] === s) l[1] = t + 60; else stages.push([t, t + 60, s]); }
  const state = new Map(labels), hrSpan = seg.filter(r => r.hr).map(r => r.hr);
  const rhr = hrSpan.length >= 5 ? lowestAvg(hrSpan) : null;
  const hrv = seg.filter(r => r.rmssd && (state.get(r.t) || "wake") !== "wake").map(r => r.rmssd);
  const temps = seg.filter(r => r.temp).map(r => r.temp);
  return { day, start: a, end: z, asleep, awake: count.wake, light: count.light, deep: count.deep, rem: count.rem,
    efficiency: Math.round(100 * asleep / Math.max(1, total)), method, rhr: rhr ? Math.round(rhr) : null,
    hrv: hrv.length >= 10 ? Math.round(median(hrv)) : null, temp: temps.length >= 30 ? round(median(temps), 2) : null, stages };
}

/* ------------------------------------------------------------------ scores (after NOOP) */
function baseline(vals, floor) {
  const v = vals.filter(x => x != null).slice(-30);
  if (v.length < 4) return null;
  const m = median(v);
  return [m, Math.max(floor, sum(v.map(x => Math.abs(x - m))) / v.length), v.length];
}
const zscore = (x, b) => (x - b[0]) / (1.253 * b[1]);
function sleepNeed(history, age) {
  const floor = age && age < 18 ? 9 : 8;
  const xs = history.slice(-30).filter(n => n.asleep).map(n => n.asleep / 60).sort((a, b) => a - b);
  if (xs.length < 7) return floor;
  const pos = 0.75 * (xs.length - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, xs.length - 1);
  return Math.min(Math.max(xs[lo] + (pos - lo) * (xs[hi] - xs[lo]), floor), 9.5);
}
function consistency(n, history) {
  const prev = history.slice(-7);
  if (prev.length < 3) return null;
  const clock = t => { const d = new Date(t * 1000); return (d.getHours() * 60 + d.getMinutes() + 720) % 1440; };
  const d1 = Math.abs(clock(n.start) - median(prev.map(x => clock(x.start))));
  const d2 = Math.abs(clock(n.end) - median(prev.map(x => clock(x.end))));
  return clamp01(1 - (d1 + d2) / 2 / 90);
}
function restScore(n, needH, cons) {
  const tst = n.asleep * 60;
  if (tst <= 0) return null;
  const deepF = 0.5 + 0.5 * clamp01((n.deep * 60 / tst) / 0.13), restor = clamp01(((n.deep + n.rem) * 60 / tst) / 0.50) * deepF;
  return Math.round(100 * (0.5 * clamp01(tst / (needH * 3600)) + 0.2 * clamp01(n.efficiency / 100) + 0.2 * restor + 0.1 * clamp01(cons == null ? 0.5 : cons)));
}
function charge(n, history) {
  const hb = baseline(history.map(x => x.hrv), 5);
  if (!n.hrv || !hb) return null;
  const terms = [[zscore(n.hrv, hb), 0.55]], rb = baseline(history.map(x => x.rhr), 2);
  if (n.rhr && rb) {
    const rz = (rb[0] - n.rhr) / (1.253 * rb[1]), hz = terms[0][0];
    if (-hz >= 0.5 && rz >= 0.5) terms[0] = [hz * (1 - 0.5 * clamp01((Math.min(-hz, rz) - 0.5) / 1)), 0.55];
    terms.push([rz, 0.20]);
  }
  if (n.rest != null) terms.push([(n.rest / 100 - 0.85) / 0.12, 0.15]);
  if (n.temp_dev != null) terms.push([-Math.abs(n.temp_dev), 0.05]);
  const z = sum(terms.map(([a, w]) => a * w)) / sum(terms.map(([, w]) => w));
  return Math.round(Math.max(0, Math.min(100, 100 / (1 + Math.exp(-1.6 * (z + 0.20))))));
}
function sleepDebt(history, needH) {
  let debt = 0; const need = needH * 60;
  for (const n of history.slice(-14)) if (n.asleep > 0) { const d = 0.55 * Math.max(0, need + debt - n.asleep); debt = d < 10 ? 0 : d; }
  return Math.round(debt);
}
function illness(n, history) {
  if (history.length < 14) return { level: "learning", score: null, signals: [], nights: history.length };
  const out = []; let score = 0;
  for (const [key, label, floor, sign] of [["rhr", "resting heart rate up", 2, 1], ["temp", "skin temperature up", 0.3, 1], ["hrv", "heart rate variability down", 5, -1]]) {
    const b = baseline(history.map(x => x[key]), floor);
    if (!b || n[key] == null) continue;
    const over = sign * zscore(n[key], b) - 2;
    if (over > 0) { out.push(label); score += Math.min(40, 22 * over); }
  }
  score = Math.min(100, score);
  return { level: out.length < 2 || score < 25 ? "normal" : score < 50 ? "mild" : "raised", score: Math.round(score), signals: out, nights: history.length };
}
function daySummary(rows, day, age, rhr) {
  if (!rows.length) return null;
  const hrs = rows.filter(r => r.hr).map(r => r.hr), rest = rhr || 60, hmax = 220 - age;
  let trimp = 0;
  for (const h of hrs) { const p = 100 * (h - rest) / Math.max(1, hmax - rest); trimp += p >= 90 ? 5 : p >= 80 ? 4 : p >= 70 ? 3 : p >= 60 ? 2 : p >= 50 ? 1 : 0; }
  const effort = hrs.length >= 10 ? 100 * Math.log(trimp + 1) / Math.log(7201) : 0;
  return { day, steps: sum(rows.map(r => r.steps || 0)), active: Math.round(sum(rows.map(r => (r.walk || 0) + (r.run || 0))) / 60),
    effort: Math.round(effort), strain: round(effort * 0.21, 1), avg: hrs.length ? Math.round(sum(hrs) / hrs.length) : null, worn: hrs.length };
}

/* ------------------------------------------------------------------ storage (IndexedDB) */
// stores: days  {day, rows: {t: minuteRowArray}}  - every minute, kept forever
//         secs  {m, rows: [secTuple]}              - per-second detail for 48 h (to build minute rows)
//         kv    {k, v}                             - settings, theme, sync log, pending clock-reset readings
const SEC_KEEP = 48 * 3600;
class Store {
  constructor(name = "pulse") { this.name = name; this.days = new Map(); this.keys = new Set(); this.dirtyDays = new Set(); this.kv = new Map(); this.version = 0; this.mem = !root.indexedDB; }
  async open() {
    if (this.mem) return;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("days", { keyPath: "day" }); d.createObjectStore("secs", { keyPath: "m" }); d.createObjectStore("kv", { keyPath: "k" }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    for (const x of await this._all("kv")) this.kv.set(x.k, x.v);
    // only the day list is read at start; a day's minutes load when something needs them
    for (const k of await new Promise((res, rej) => { const r = this._tx("days").getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })) this.keys.add(k);
    const today = localDay(now());
    for (let i = 0; i < 4; i++) await this.load(addDays(today, -i));
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* best effort */ }
  }
  _tx(store, mode = "readonly") { return this.db.transaction(store, mode).objectStore(store); }
  _all(store) { return new Promise((res, rej) => { const r = this._tx(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  _put(store, val) { if (this.mem) return Promise.resolve(); return new Promise((res, rej) => { const r = this._tx(store, "readwrite").put(val); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  _get(store, key) { if (this.mem) return Promise.resolve(undefined); return new Promise((res, rej) => { const r = this._tx(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  _del(store, range) { if (this.mem) return Promise.resolve(); return new Promise((res, rej) => { const r = this._tx(store, "readwrite").delete(range); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async load(day) {
    if (this.days.has(day) || !this.keys.has(day) || this.mem) return;
    const x = await this._get("days", day);
    if (x && !this.days.has(day)) this.days.set(day, new Map(Object.entries(x.rows).map(([t, r]) => [+t, r])));
  }
  async loadSpan(t0, t1) { for (let d = localDay(t0); d <= localDay(t1 - 1); d = addDays(d, 1)) await this.load(d); }
  // keep memory small: drop loaded days that are not recent and not waiting to be saved
  evict(keep = 4) {
    const cut = addDays(localDay(now()), -keep);
    for (const d of [...this.days.keys()]) if (d < cut && !this.dirtyDays.has(d)) this.days.delete(d);
  }
  get(k, d = null) { return this.kv.has(k) ? this.kv.get(k) : d; }
  async put(k, v) { this.kv.set(k, v); await this._put("kv", { k, v }); }
  minutes(t0, t1) {
    const out = [];
    for (let day = localDay(t0); day <= localDay(t1 - 1); day = addDays(day, 1)) {
      const d = this.days.get(day); if (!d) continue;
      for (const [t, r] of d) if (t >= t0 && t < t1) out.push(r);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
  setMinute(row) {
    const day = localDay(row[0]);
    if (!this.days.has(day)) this.days.set(day, new Map());
    this.days.get(day).set(row[0], row); this.dirtyDays.add(day); this.keys.add(day);
  }
  async saveDays() {
    for (const day of this.dirtyDays) {
      const rows = {}; for (const [t, r] of this.days.get(day)) rows[t] = r;
      await this._put("days", { day, rows });
    }
    if (this.dirtyDays.size) this.version++;
    const changed = [...this.dirtyDays]; this.dirtyDays.clear();
    return changed;
  }
  // per-second rows for one minute (strap rows replace live rows for the same second)
  async addSecs(tuples, mem) {
    const by = new Map();
    for (const s of tuples) { const m = s[0] - s[0] % 60; if (!by.has(m)) by.set(m, []); by.get(m).push(s); }
    for (const [m, list] of by) {
      const cur = mem.get(m) || (await this._get("secs", m) || { rows: [] }).rows;
      const byT = new Map(cur.map(s => [s[0], s]));
      for (const s of list) { const old = byT.get(s[0]); if (!old || s[9] >= old[9]) byT.set(s[0], s); }
      const rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
      mem.set(m, rows); await this._put("secs", { m, rows });
    }
    return [...by.keys()];
  }
  async secsFor(m, mem) { return mem.get(m) || (await this._get("secs", m) || { rows: [] }).rows; }
  async pruneSecs() { if (!this.mem && root.IDBKeyRange) await this._del("secs", IDBKeyRange.upperBound(now() - SEC_KEEP)); }
  dayKeys() { return [...this.keys].sort(); }
}

/* ------------------------------------------------------------------ analysis over the store */
class Analysis {
  constructor(store) { this.s = store; this.ver = -1; this.cache = null; this.saved = null; }
  // results for settled days (older than two days) are kept in storage, so their minutes never need loading again
  settled() { if (!this.saved) this.saved = Object.assign({}, this.s.get("analysis_v1", {})); return this.saved; }
  invalidate(days) { const c = this.settled(); for (const d of days) { if (c[d] || c[addDays(d, 1)]) this.dirty = true; delete c[d]; delete c[addDays(d, 1)]; } if (days.length) this.ver = -1; }
  all(conf) {                                        // one computation at a time; callers share it
    if (this.running) return this.running;
    this.running = this._all(conf).finally(() => { this.running = null; });
    return this.running;
  }
  async _all(conf) {
    if (this.cache && this.ver === this.s.version && this.cacheDay === localDay(now())) return this.cache;
    const today = localDay(now()), have = this.s.dayKeys(), saved = this.settled();
    const todo = [...new Set([...have, ...have.map(d => addDays(d, 1))])].sort();
    const nights = [], days = []; let wrote = false;
    for (const day of todo) {
      if (day > today || (conf.since && day < conf.since)) continue;
      const recent = (dayStart(today) - dayStart(day)) / 86400 <= 2;
      let raw, sum_;
      if (!recent && saved[day]) ({ n: raw, s: sum_ } = saved[day]);
      else {
        const t0 = dayStart(day) - 6 * 3600, t1 = dayStart(day) + 86400;
        await this.s.loadSpan(t0, t1);
        raw = nightFor(this.s.minutes(t0, dayStart(day) + 14 * 3600).map(rowObj), day);
        sum_ = undefined;
      }
      const n = raw && { ...raw };
      if (n) {
        const prev = nights.filter(x => x.temp).slice(-30);
        n.temp_dev = n.temp && prev.length >= 3 ? round(n.temp - median(prev.map(x => x.temp)), 2) : null;
        const need = sleepNeed(nights, conf.age);
        n.need = Math.round(need * 60); n.rest = restScore(n, need, consistency(n, nights)); n.debt = sleepDebt([...nights, n], need);
        n.recovery = charge(n, nights); n.baseline_n = nights.filter(x => x.hrv).length; n.illness = illness(n, nights);
        nights.push(n);
      }
      const rhr = nights.length && nights[nights.length - 1].day === day ? nights[nights.length - 1].rhr : null;
      if (sum_ === undefined) sum_ = daySummary(this.s.minutes(dayStart(day), dayStart(day) + 86400).map(rowObj), day, conf.age, rhr);
      if (sum_) days.push(sum_);
      if (!recent && !saved[day]) { saved[day] = { n: raw, s: sum_ }; wrote = true; }
    }
    if (wrote || this.dirty) { this.dirty = false; await this.s.put("analysis_v1", saved); }
    this.s.evict();
    this.cache = { nights, days }; this.ver = this.s.version; this.cacheDay = today;
    return this.cache;
  }
}

/* ------------------------------------------------------------------ the strap link (Web Bluetooth) */
class Pulse {
  constructor() {
    this.store = new Store(); this.an = new Analysis(this.store); this.secMem = new Map();
    this.st = { bpm: null, last: 0, battery: null, link: "disconnected", sync: "waiting", sync_pct: null, sync_note: "",
      sync_seen: 0, sync_ok: 0, clock_off: null, clock_read_at: 0, pack: null, charging: null, synced_once: false, want_sync: false };
    this.live = [];                                  // [t, bpm] for the last hour, for the short charts
    this.seq = 10; this.reasm = new Map(); this.recs = []; this.queue = []; this.activity = 0; this.first = null; this.stats = null;
    this.pendingBad = [];                            // readings with a reset clock, waiting for an anchor
    this.dirtyMinutes = new Set(); this.timer = null; this.link = null;
  }
  conf() { return Object.assign({ age: 30, since: "", sync_every: 15, target: "" }, this.store.get("conf", {})); }
  async init() {
    await this.store.open();
    this.pendingBad = this.store.get("pending_bad", []);
    if (!this.store.get("first_seen")) await this.store.put("first_seen", now());
    await this.store.put("visits", (this.store.get("visits") || 0) + 1);
    try { this.persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { this.persisted = null; }
    setInterval(() => this.flush(), 10000);
  }
  fresh() { return this.st.bpm != null && now() - this.st.last < 5; }

  /* --- connecting --- */
  async connect(demo) {
    if (demo) { this.link = new FakeLink(this); }
    else {
      if (!navigator.bluetooth) throw new Error("This browser has no Bluetooth. Open Pulse in Bluefy.");
      const c = this.conf();
      // show every nearby device: the strap advertises under its own name (for example "BAS WHOOP")
      const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SVC, "heart_rate", "battery_service"] });
      await this.store.put("conf", Object.assign(c, { target: dev.name || c.target }));
      this.link = new BleLink(dev, () => this.onDisconnect());
      await this.link.open();
    }
    this.st.link = "connected";
    await this.session();
  }
  // Reconnect without a tap: Bluefy (3.2+) remembers devices this site was allowed to use.
  async autoConnect() {
    if (this.link || !root.navigator || !navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
    const target = this.conf().target, devs = await navigator.bluetooth.getDevices();
    const dev = devs.find(d => target && d.name === target) || devs.find(d => /whoop/i.test(d.name || "")) || null;
    if (!dev) return false;
    this.link = new BleLink(dev, () => this.onDisconnect());
    this.st.link = "connecting";
    for (let i = 0; i < 3; i++) {
      try { await this.link.open(); this.st.link = "connected"; await this.session(); return true; }
      catch (e) { await sleep(2000); }
    }
    this.st.link = "disconnected"; this.scheduleReconnect(5000);
    return false;
  }
  onDisconnect() {
    this.st.link = "disconnected"; this.st.bpm = null; this.reasm.clear();
    if (this.st.sync === "syncing") { this.logStats("disconnected"); this.stats = null; this.st.sync = "stalled"; }
    clearInterval(this.timer);
    this.scheduleReconnect();
  }
  // the browser remembers the strap after the first tap, so later reconnects need no tap
  scheduleReconnect(delay = 3000) {
    clearTimeout(this.retry);
    if (!this.link || !this.link.reopen) return;
    this.retry = setTimeout(async () => {
      if (this.st.link === "connected" || this.st.link === "connecting") return;
      try { this.st.link = "connecting"; await this.link.reopen(); this.st.link = "connected"; await this.session(); }
      catch (e) { this.st.link = "disconnected"; this.scheduleReconnect(Math.min(60000, delay * 2)); }
    }, delay);
  }
  async reconnect() { clearTimeout(this.retry); this.scheduleReconnect(10); }
  // called when Pulse comes back on screen: iOS pauses pages in the background, so reconnect or catch up now
  async wake() {
    if (!this.link) return this.autoConnect();
    if (this.st.link === "disconnected") return this.reconnect();
    if (this.st.link !== "connected") return;
    if (now() - (this.rx || 0) > 20) { this.link.drop(); return; }
    if (this.st.sync === "syncing" && now() - this.activity > 10) { this.startSync().catch(() => {}); return; }
    if (this.st.sync !== "syncing") this.st.want_sync = true;
  }
  async write(data, response = true) { await this.link.write(data, response); }

  async session() {
    this.sessionAt = now(); this.rx = now();
    try { await this.link.notify("heart_rate", "heart_rate_measurement", d => this.onHR(d)); } catch (e) { /* live heart rate not offered */ }
    for (const u of NOTIFY) await this.link.notify(SVC, u, d => this.onFrame(u, d)).catch(() => {});
    await this.write(HELLO);
    await sleep(800);
    await this.write(setClock(now(), 3));
    await sleep(500);
    await this.write(command(C.GET_CLOCK, 4));
    await this.write(command(C.REALTIME_HR, 5), false);
    await this.write(command(C.R10_R11, 6), false);
    await sleep(1000);
    this.readBattery();
    this.startSync().catch(e => { this.st.sync = "error"; this.st.sync_note = String(e.message || e).slice(0, 80); });
    let kicks = 0, stalledAt = 0, tick = 0;
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (this.st.link !== "connected") return;
      tick++;
      if (tick % 60 === 0) this.readBattery();
      const idle = now() - this.activity;
      if (this.st.sync === "syncing" && idle > 20) {
        if (kicks < 3) { kicks++; this.startSync().catch(() => {}); }
        else { this.logStats("stalled"); this.stats = null; Object.assign(this.st, { sync: "stalled", sync_pct: null }); stalledAt = now(); }
      }
      // a link that says "connected" but has delivered nothing for 2 minutes (common after iOS pauses the page) is dead: rebuild it
      if (now() - (this.rx || 0) > 120 && now() - this.sessionAt > 120) { this.logStats("silent link"); this.stats = null; this.link.drop(); return; }
      const due = (this.st.sync === "synced" && now() - (this.store.get("last_sync") || 0) > this.conf().sync_every * 60) ||
        (this.st.sync === "stalled" && now() - stalledAt > 60);
      if (["synced", "stalled"].includes(this.st.sync) && (this.st.want_sync || due)) { this.st.want_sync = false; kicks = 0; this.startSync().catch(() => {}); }
    }, 1000);
  }
  async readBattery() { try { const v = await this.link.read("battery_service", "battery_level"); this.st.battery = v[0]; } catch (e) { /* not offered */ } }

  onHR(d) {
    const [bpm, rr] = parseHR(d);
    if (bpm < 30 || bpm > 220) return;
    const t = Math.floor(now());
    this.st.bpm = bpm; this.st.last = now(); this.rx = now();
    this.live.push([t, bpm]); while (this.live.length && this.live[0][0] < t - 3700) this.live.shift();
    this.liveSecs = this.liveSecs || [];
    this.liveSecs.push([t, bpm, rr.length ? rr : null, null, null, null, null, null, null, 0, null, null, null]);
  }

  /* --- history sync: ask -> chunks -> save -> confirm --- */
  async ensureClock() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const asked = now();
      this.seq = (this.seq + 1) & 0xFF; await this.write(command(C.GET_CLOCK, this.seq));
      for (let i = 0; i < 20 && this.st.clock_read_at < asked; i++) await sleep(100);
      if (this.st.clock_read_at >= asked && Math.abs(this.st.clock_off) <= 60) return true;
      const seen = this.store.get("clock_resets_seen", []).slice(-49);
      seen.push({ at: now(), off: this.st.clock_read_at < asked ? null : Math.round(this.st.clock_off) });
      await this.store.put("clock_resets_seen", seen);
      this.seq = (this.seq + 1) & 0xFF; await this.write(setClock(now(), this.seq));
      await sleep(1000 + 1000 * attempt);
    }
    return false;
  }
  async startSync() {
    try { this.seq = (this.seq + 1) & 0xFF; await this.write(command(C.PACK_INFO, this.seq, [1])); } catch (e) { /* optional */ }
    if (!await this.ensureClock()) this.st.sync_note = "The strap did not confirm its clock. Readings will be re-dated when it does.";
    if (this.stats && this.stats.frames) this.logStats("restarted");
    this.stats = { started: now(), frames: 0, ok: 0, undecoded: 0, bad_time: 0, crc_bad: 0, versions: {}, metas: {}, t_min: null, t_max: null };
    this.st.sync_seen = this.st.sync_ok = 0; this.first = null;
    Object.assign(this.st, { sync: "syncing", sync_pct: 0 }); this.activity = now();
    this.seq = (this.seq + 1) & 0xFF; await this.write(command(C.HISTORY, this.seq));
  }
  logStats(outcome) {
    if (!this.stats) return;
    Object.assign(this.stats, { outcome, seconds: Math.round(now() - this.stats.started) });
    const log = this.store.get("sync_log", []).slice(-19); log.push(this.stats); this.store.put("sync_log", log);
  }
  onFrame(key, data) {
    this.rx = now();
    if (!this.reasm.has(key)) this.reasm.set(key, new Reassembler());
    for (const f of this.reasm.get(key).feed(data)) {
      if (f.length < 11) continue;
      if (f[8] === T.HISTORY) {
        this.activity = now(); const st = this.stats || (this.stats = { started: now(), frames: 0, ok: 0, undecoded: 0, bad_time: 0, crc_bad: 0, versions: {}, metas: {}, t_min: null, t_max: null });
        if (!frameOk(f)) { st.crc_bad++; continue; }
        st.frames++; st.versions["v" + f[9]] = (st.versions["v" + f[9]] || 0) + 1; this.st.sync_seen = st.frames;
        const r = decodeRecord(f);
        if (!r) { st.undecoded++; continue; }
        if (r.t < VALID_FROM || r.t > now() + 600) { st.bad_time++; this.recs.push({ bad: true, r }); continue; }
        st.ok++; this.st.sync_ok = st.ok; st.t_min = Math.min(st.t_min || r.t, r.t); st.t_max = Math.max(st.t_max || r.t, r.t);
        this.recs.push({ r });
        this.first = this.first || r.t;
        this.st.sync_pct = Math.min(99, Math.round(100 * (r.t - this.first) / Math.max(1, now() - this.first)));
      } else if (f[8] === T.META) {
        const [kind, end] = decodeMeta(f); this.activity = now();
        if (this.stats) this.stats.metas[kind] = (this.stats.metas[kind] || 0) + 1;
        if (kind === M.END && end) {
          const k = end.join(","); if (k === this.lastEnd && now() - this.lastEndAt < 2) continue;
          this.lastEnd = k; this.lastEndAt = now();
          this.enqueue(end, false);
        } else if (kind === M.DONE) this.enqueue(null, true);
      } else if (f[8] === T.EVENT && frameOk(f)) {
        const ev = f[10];
        if (ev === E.PACK_INFO) { const p = decodePack(f, 20); if (p) this.st.pack = p.present ? Object.assign(p, { at: now() }) : null; }
        else if (ev === E.CHARGE_ON || ev === E.CHARGE_OFF) this.st.charging = ev === E.CHARGE_ON;
        else if (ev === E.PACK_OFF) { this.st.pack = null; this.st.charging = false; }
      } else if (f[8] === T.RESPONSE && f[10] === C.PACK_INFO && f.length > 14 && frameOk(f) && f[12] === 1) {
        const p = decodePack(f, 14); if (p) this.st.pack = p.present ? Object.assign(p, { at: now() }) : null;
      } else if (f[8] === T.RESPONSE && f[10] === C.GET_CLOCK && f.length >= 17 && frameOk(f)) {
        const clock = u32(f, 13);
        if (clock > 1e9) { this.st.clock_off = clock - now(); this.st.clock_read_at = now(); this.store.put("clock_off", Math.round(this.st.clock_off)); }
      }
    }
  }
  enqueue(end, done) {
    const recs = this.recs; this.recs = [];
    this.queue.push([end, recs, done]);
    if (!this.committing) this.commit();
  }
  async commit() {
    this.committing = true;
    try {
      while (this.queue.length) {
        const [end, recs, done] = this.queue.shift();
        try { await this.save(recs); }                                   // save first...
        catch (e) { Object.assign(this.st, { sync: "error", sync_note: "Could not save: " + e }); continue; }   // ...never confirm unsaved data
        if (end) { this.seq = (this.seq + 1) & 0xFF; await this.write(ack(end, this.seq)); }      // ...then let the strap free it
        if (done) {
          this.logStats("done"); this.stats = null;
          await this.flush();
          Object.assign(this.st, { sync: "synced", sync_pct: null, synced_once: true });
          if (!this.repairNote) this.st.sync_note = "";
          this.repairNote = null;
          await this.store.put("last_sync", now());
        }
      }
    } finally { this.committing = false; }
  }
  // Readings stamped by a reset strap clock (1 Jan 2023) are kept and re-dated: the strap records once a
  // second without gaps, so the first correctly dated reading after a run of them anchors the whole run.
  async save(items) {
    const good = [];
    for (const { bad, r } of items) {
      if (bad) {
        const last = this.pendingBad[this.pendingBad.length - 1];
        if (last && (r.t < last.t || r.t - last.t > 600)) this.pendingBad = [];       // a new run
        this.pendingBad.push(r); continue;
      }
      if (this.pendingBad.length) {
        const off = r.t - this.pendingBad[this.pendingBad.length - 1].t - 1;
        const fixed = this.pendingBad.map(x => Object.assign({}, x, { t: x.t + off })).filter(x => x.t >= VALID_FROM && x.t <= now() + 600);
        good.push(...fixed);
        const fixes = this.store.get("clock_fixes", []); fixes.push({ from: fixed.length ? fixed[0].t : null, to: fixed.length ? fixed[fixed.length - 1].t : null, readings: fixed.length, offset: off, fixed_at: now() });
        await this.store.put("clock_fixes", fixes.slice(-20));
        this.repairNote = true;
        this.st.sync_note = "The strap's clock had reset; Pulse re-dated " + (fixed.length / 3600).toFixed(1) + " hours of readings.";
        this.pendingBad = [];
      }
      good.push(r);
    }
    await this.store.put("pending_bad", this.pendingBad);
    if (good.length) {
      const ms = await this.store.addSecs(good.map(secTuple), this.secMem);
      for (const m of ms) this.dirtyMinutes.add(m);
      const newest = Math.max(...good.map(r => r.t));
      if (newest > (this.store.get("strap_newest") || 0)) await this.store.put("strap_newest", newest);
      await this.store.put("records", (this.store.get("records") || 0) + good.length);
    }
  }
  async flush() {
    if (this.flushing) return; this.flushing = true;
    try {
      if (this.liveSecs && this.liveSecs.length) { const l = this.liveSecs; this.liveSecs = []; for (const m of await this.store.addSecs(l, this.secMem)) this.dirtyMinutes.add(m); }
      const todo = [...this.dirtyMinutes].sort((a, b) => a - b); this.dirtyMinutes.clear();
      for (const m of todo) {
        const rows = [...(await this.store.secsFor(m - 60, this.secMem)).filter(s => s[0] === m - 1), ...await this.store.secsFor(m, this.secMem)];
        const row = minuteRow(m, rows); if (row) { await this.store.load(localDay(m)); this.store.setMinute(row); }
      }
      const changed = await this.store.saveDays();
      this.an.invalidate(changed);
      for (const m of [...this.secMem.keys()]) if (m < now() - 7200) this.secMem.delete(m);
      if (todo.length) await this.store.pruneSecs();
    } finally { this.flushing = false; }
  }

  /* --- backups and the one-time import from the Mac --- */
  async exportBackup() {
    const days = {};
    for (const d of this.store.dayKeys()) {
      await this.store.load(d);
      const o = {}; for (const [t, r] of this.store.days.get(d) || []) o[t] = r; days[d] = o;
      this.store.evict();
    }
    const kv = {}; for (const [k, v] of this.store.kv) kv[k] = v;
    return JSON.stringify({ pulse: 1, cols: MIN_COLS, days, kv, exported: now() });
  }
  async importBackup(text) {
    const j = JSON.parse(text);
    if (!j.cols || !j.days) throw new Error("This is not a Pulse backup.");
    const map = MIN_COLS.map(c => j.cols.indexOf(c));
    let n = 0;
    for (const day of Object.keys(j.days)) for (const r of Object.values(j.days[day])) {
      const row = map.map(i => i < 0 ? null : r[i]);
      await this.store.load(localDay(row[0]));
      const have = this.store.days.get(localDay(row[0]));
      if (have && have.has(row[0]) && (have.get(row[0])[15] || 0) >= (row[15] || 0)) continue;     // keep richer local rows
      this.store.setMinute(row); n++;
    }
    for (const k of ["theme", "conf"]) if (j.kv && j.kv[k] && !this.store.get(k)) await this.store.put(k, j.kv[k]);
    const changed = await this.store.saveDays(); this.an.invalidate(changed); this.store.evict();
    return n;
  }

  /* --- Apple Health, through the Shortcuts app ---
   * Web pages cannot write to Health, but a Shortcut can. Pulse hands the Shortcut a small JSON
   * (heart rate as 10-minute averages, resting heart rate and HRV once per night) on the clipboard. */
  async healthPayload(resend) {
    const last = resend ? {} : this.store.get("health_last", {}), t = now(), from = Math.max(last.hr || 0, t - 7 * 86400);
    await this.store.loadSpan(from, t);
    const rows = this.store.minutes(from, t).filter(r => r[1] && r[0] + 60 <= t - 60);
    const hr = [], slots = new Map();
    for (const r of rows) { const k = r[0] - r[0] % 600; if (!slots.has(k)) slots.set(k, []); slots.get(k).push(r[1]); }
    for (const [k, v] of [...slots].sort((a, b) => a[0] - b[0])) if (k + 600 <= t - 60 && k + 600 > (last.hr || 0)) hr.push({ d: isoLocal(k + 300), v: Math.round(sum(v) / v.length) });
    const nights = (await this.an.all(this.conf())).nights.filter(n => n.day > (last.night || "") && n.day >= localDay(t - 7 * 86400) && n.day < localDay(t + 86400));
    const rhr = nights.filter(n => n.rhr).map(n => ({ d: isoLocal(n.end), v: n.rhr }));
    const hrv = nights.filter(n => n.hrv).map(n => ({ d: isoLocal(n.end), v: n.hrv }));
    const mark = { hr: slots.size ? Math.max(...[...slots.keys()].filter(k => k + 600 <= t - 60), last.hr || 0) + 600 : last.hr || 0,
      night: nights.length ? nights[nights.length - 1].day : last.night || "" };
    // only settled nights count as sent: last night may still change while today's data arrives
    if (nights.length && nights[nights.length - 1].day === localDay(t) && t - nights[nights.length - 1].end < 3 * 3600) mark.night = last.night || "";
    return { payload: { pulse: 1, hr, rhr, hrv }, mark, counts: { hr: hr.length, rhr: rhr.length, hrv: hrv.length } };
  }
  async healthSent(mark) { await this.store.put("health_last", Object.assign({}, mark, { at: now() })); }

  /* --- the page's requests (same answers the Mac server gave) --- */
  async api(path, body) {
    const u = new URL(path, "https://pulse.local"), q = Object.fromEntries(u.searchParams), p = u.pathname, c = this.conf();
    if (p === "/api/now") return this.apiNow(c, await this.an.all(c));
    if (p === "/api/hr") return this.apiHr(q.range || "600");
    if (p === "/api/nights") return [...(await this.an.all(c)).nights].reverse().slice(0, 60);
    if (p === "/api/trend") {
      const src = { recovery: ["nights", "recovery"], hrv: ["nights", "hrv"], rhr: ["nights", "rhr"], sleep: ["nights", "asleep"], rest: ["nights", "rest"], temp: ["nights", "temp"], steps: ["days", "steps"], strain: ["days", "strain"] }[q.metric] || ["nights", "recovery"];
      const cut = localDay(now() - (+q.days || 30) * 86400);
      return (await this.an.all(c))[src[0]].filter(x => x.day > cut && x[src[1]] != null).map(x => [dayStart(x.day) + 43200, x[src[1]]]);
    }
    if (p === "/api/settings") {
      if (body && body.sync_every) { if (![5, 15, 30, 60].includes(+body.sync_every)) throw new Error("Pick 5, 15, 30 or 60 minutes."); await this.store.put("conf", Object.assign(c, { sync_every: +body.sync_every })); }
      return Object.assign({}, this.conf(), { version: VERSION, days: this.store.keys.size, records: this.store.get("records", 0), web: true }, this.strapStatus());
    }
    if (p === "/api/sync") { this.st.want_sync = true; return { ok: true }; }
    if (p === "/api/theme") {
      if (body) await this.store.put("theme", body);
      return Object.assign({ palette: "sage", finish: "lift", hidden: ["goldman", "charcoal"], colors: {}, radius: 24, gap: 16, text: 100, labels: {} }, this.store.get("theme", {}));
    }
    throw new Error("not found: " + p);
  }
  strapStatus() {
    const pack = this.st.pack && now() - this.st.pack.at < 900 ? this.st.pack : null;
    return { strap_newest: this.store.get("strap_newest"), clock_off: this.st.clock_off != null ? this.st.clock_off : this.store.get("clock_off"), not_saving: false, pack, charging: this.st.charging };
  }
  apiNow(c, a) {
    const st = this.st, today = localDay(now());
    const night = [...a.nights].reverse().find(n => n.day === today), last = night || a.nights[a.nights.length - 1] || null;
    const day = a.days.find(d => d.day === today) || null;
    const prev = a.nights.filter(n => last && n.day < last.day).slice(-30);
    const base = k => { const v = prev.map(n => n[k]).filter(Boolean); return v.length >= 3 ? Math.round(median(v)) : null; };
    const zone = b => [0.5, 0.6, 0.7, 0.85].filter(x => b / (220 - c.age) >= x).length;
    let nightOut = null;
    if (last) { nightOut = {}; for (const k of ["day", "start", "end", "asleep", "efficiency", "rhr", "hrv", "temp", "temp_dev", "recovery", "baseline_n", "method", "deep", "rem", "light", "awake", "rest", "debt", "need", "illness"]) nightOut[k] = last[k]; }
    return Object.assign({ live: this.fresh(), bpm: this.fresh() ? st.bpm : null, zone: this.fresh() ? zone(st.bpm) : null, link: st.link,
      battery: st.battery, target: c.target, sync: st.sync, sync_pct: st.sync_pct, sync_seen: st.sync_seen, sync_ok: st.sync_ok, sync_note: st.sync_note,
      last_sync: this.store.get("last_sync"), night: nightOut, night_today: !!night, base: { rhr: base("rhr"), hrv: base("hrv") }, day, now: now() }, this.strapStatus());
  }
  async apiHr(rng) {
    const t = now();
    if (rng === "day") {
      const t0 = dayStart(localDay(t));
      await this.store.load(localDay(t));
      const pts = this.store.minutes(t0, t + 60).filter(r => r[1]).map(r => [r[0], round(r[1], 1)]);
      return { from: t0, to: t, gap: 600, points: decimate(pts, 288) };
    }
    const t0 = t - +rng;
    // stored strap seconds + live readings (live wins), then minute rows where neither has data,
    // so the short charts survive a reload instead of starting at the moment the page opened
    const by = new Map();
    for (let m = t0 - t0 % 60; m <= t; m += 60)
      for (const s of await this.store.secsFor(m, this.secMem)) if (s[1] && s[0] >= t0) by.set(s[0], s[1]);
    for (const [tt, b] of this.live) if (tt >= t0 && b) by.set(tt, b);
    const covered = new Set([...by.keys()].map(x => x - x % 60));
    await this.store.load(localDay(t0)); await this.store.load(localDay(t));
    for (const r of this.store.minutes(t0 - t0 % 60, t + 60)) if (r[1] && !covered.has(r[0]) && r[0] + 30 >= t0) by.set(r[0] + 30, round(r[1], 1));
    const merged = [...by.entries()].sort((a, b) => a[0] - b[0]);
    let pts = decimate(merged, { 60: 60, 600: 120, 3600: 240 }[rng] || 120);
    if (rng !== "60") pts = pts.map(([tt], i) => { const w = pts.slice(Math.max(0, i - 1), i + 2); return [tt, round(sum(w.map(x => x[1])) / w.length, 1)]; });
    return { from: t0, to: t, gap: rng === "60" ? 30 : 90, points: pts };
  }
}
const VERSION = "web-2026.10.23-1";
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isoLocal(t) {
  const d = new Date(t * 1000), p = n => String(n).padStart(2, "0"), off = -d.getTimezoneOffset();
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
    (off >= 0 ? "+" : "-") + p(Math.floor(Math.abs(off) / 60)) + ":" + p(Math.abs(off) % 60);
}

/* ------------------------------------------------------------------ Bluetooth wrapper */
class BleLink {
  constructor(dev, onLost) { this.dev = dev; this.onLost = onLost; this.chars = new Map(); this.cbs = new Map(); this.hooked = new WeakSet(); this.chain = Promise.resolve(); dev.addEventListener("gattserverdisconnected", () => onLost()); }
  // Web Bluetooth allows one GATT operation at a time; queue them all
  op(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }
  async open() { this.chars.clear(); this.gatt = await this.dev.gatt.connect(); }
  async reopen() { await this.open(); }
  drop() { try { if (this.dev.gatt.connected) this.dev.gatt.disconnect(); else this.onLost(); } catch (e) { this.onLost(); } }
  async char(svc, ch) {
    const k = svc + "/" + ch;
    if (!this.chars.has(k)) { const sv = await this.gatt.getPrimaryService(svc); this.chars.set(k, await sv.getCharacteristic(ch)); }
    return this.chars.get(k);
  }
  notify(svc, ch, cb) {
    return this.op(async () => {
      const c = await this.char(svc, ch), k = svc + "/" + ch;
      this.cbs.set(k, cb);
      // a second listener on the same object would deliver every packet twice and corrupt the history stream
      if (!this.hooked.has(c)) { this.hooked.add(c); c.addEventListener("characteristicvaluechanged", e => { const v = e.target.value, f = this.cbs.get(k); if (f) f(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()); }); }
      await c.startNotifications();
    });
  }
  write(data, response = true) {
    return this.op(async () => {
      const c = await this.char(SVC, CMD);
      if (response && c.writeValueWithResponse) return c.writeValueWithResponse(data);
      if (!response && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(data);
      return c.writeValue(data);
    });
  }
  read(svc, ch) { return this.op(async () => { const v = await (await this.char(svc, ch)).readValue(); return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice(); }); }
}

/* ------------------------------------------------------------------ simulated strap (?demo) */
class FakeLink {
  constructor(p) { this.p = p; this.cbs = new Map(); this.start = Math.floor(now()) - 72 * 3600; this.cursor = this.start; }
  async notify(svc, ch, cb) { this.cbs.set(ch, cb); if (ch === "heart_rate_measurement") setInterval(() => cb(new Uint8Array([0, Math.round(this.body(now()).hr)])), 1000); }
  async read() { return new Uint8Array([88]); }
  drop() {}
  body(t) {
    const d = new Date(t * 1000), h = d.getHours() + d.getMinutes() / 60, asleep = h >= 23.17 || h < 6.92, walking = (h >= 8 && h < 8.4) || (h >= 17.5 && h < 18.2);
    const rnd = mulberry(Math.floor(t / 7));
    const hr = asleep ? 54 + 4 * Math.sin(h * 1.7) + rnd() * 4 - 2 : walking ? 104 + rnd() * 12 - 6 : 70 + 6 * Math.sin(h / 3) + rnd() * 8 - 4;
    return { hr, asleep: asleep && rnd() > 0.04, walking, temp: (asleep ? 34.1 : 32) + rnd() * 0.4 - 0.2 };
  }
  record(t, steps) {
    const b = this.body(t), f = new Uint8Array(92); f[0] = 0xAA; f[1] = 1; f[8] = T.HISTORY; f[9] = 18;
    f.set(le32(t), 15); f[22] = Math.round(b.hr); const rr = Math.round(60000 / b.hr); f[23] = 2;
    f[24] = rr & 255; f[25] = rr >> 8; f[26] = (rr + 9) & 255; f[27] = (rr + 9) >> 8;
    f[57] = steps & 255; f[58] = steps >> 8 & 255; f[63] = b.walking ? 1 : 0;
    const tp = Math.round(b.temp * 100); f[73] = tp & 255; f[74] = tp >> 8;
    f[81] = b.asleep ? (2 << 4 | 1) : 1;
    const jit = b.asleep ? 0.002 : b.walking ? 0.12 : 0.03, dv = new DataView(f.buffer), rnd = mulberry(t);
    dv.setFloat32(41, Math.abs((rnd() - 0.5) * jit * 3), true);
    const posture = b.asleep ? Math.floor(t / 2400) % 3 : Math.floor(t / 60) % 7, gx = 0.1 * posture + (rnd() - 0.5) * 2 * jit, gy = 0.2 + (rnd() - 0.5) * 2 * jit;
    dv.setFloat32(45, gx, true); dv.setFloat32(49, gy, true); dv.setFloat32(53, Math.sqrt(Math.max(0, 1 - gx * gx - gy * gy)), true);
    return seal(f);
  }
  async write(data) {
    const cmd = data.length > 10 ? data[10] : null, cb = this.cbs.get(NOTIFY[0]);
    if (cmd === C.GET_CLOCK) cb(command(C.GET_CLOCK, data[9], [data[9], 1, ...le32(Math.floor(now()))], T.RESPONSE));
    if (cmd === C.HISTORY || cmd === C.HISTORY_ACK) setTimeout(() => this.chunk(), 5);
  }
  chunk() {
    const cb = this.cbs.get(NOTIFY[0]), end = Math.min(this.cursor + 1800, Math.floor(now()));
    if (this.cursor >= Math.floor(now()) - 1) { cb(meta(M.DONE)); return; }
    for (let t = this.cursor; t < end; t++) cb(this.record(t, Math.floor((t - this.start) / 2)));
    this.cursor = end; cb(meta(M.END, end));
  }
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function seal(f) { const n = f.length - 8; f[2] = n & 255; f[3] = n >> 8; f[4] = 0; f[5] = 1; const h = crc16(f.subarray(0, 6)); f[6] = h & 255; f[7] = h >> 8; f.set(le32(crc32(f.subarray(8, f.length - 4))), f.length - 4); return f; }
function meta(kind, end) { const f = new Uint8Array(36); f[0] = 0xAA; f[1] = 1; f[8] = T.META; f[10] = kind; if (end) f.set(le32(end), 21); return seal(f); }

const api = { Pulse, VERSION, command, frameOk, Reassembler, decodeRecord, decodeMeta, decodePack, crc16, crc32, minuteRow, secTuple, rowObj,
  respRegularity, findSessions, stageMinutes, nightFor, restScore, charge, sleepDebt, sleepNeed, consistency, illness, daySummary, decimate, median, MIN_COLS, localDay, dayStart };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PulseEngine = api;
})(typeof self !== "undefined" ? self : globalThis);
