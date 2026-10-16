// Drawn signatures (V1.5 P1, L140-a). PURE. A finger drawing is a list of strokes (points in pad coordinates); it is
// stored as a small JSON text { v: 1, w, h, d } where `d` is an SVG path of straight segments, cropped to the ink with
// a margin, simplified (Ramer-Douglas-Peucker, 0.6 pt) and rounded to 0.1. The same `d` draws the signature in the app
// (react-native-svg) and in the PDF (inline <svg>). Stored text is validated with a strict grammar before it is ever
// put into HTML, so a damaged or hostile backup cannot inject markup.
export type Point = { x: number; y: number };
export type Stroke = Point[];
export type Signature = { v: 1; w: number; h: number; d: string };

export const MAX_SIGNATURE_CHARS = 40_000;
/** More points than this (after dropping points closer than 0.5 pt to the previous one) is refused, not truncated. */
export const MAX_SIGNATURE_POINTS = 4_000;
const MARGIN = 4;
const EPSILON = 0.6;
const NUM = '-?\\d{1,5}(?:\\.\\d)?';
const PATH = new RegExp(`^(?:M${NUM} ${NUM}(?: L${NUM} ${NUM})*)(?: M${NUM} ${NUM}(?: L${NUM} ${NUM})*)*$`);

function perpendicular(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/** Ramer-Douglas-Peucker (iterative, so a long stroke cannot overflow the stack). */
export function simplify(points: readonly Point[], epsilon = EPSILON): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    let index = -1;
    let max = 0;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(points[i], points[first], points[last]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index >= 0 && max > epsilon) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => {
  const v = r1(n);
  return Object.is(v, -0) ? '0' : String(v);
};

/** Strokes → stored signature, or null when there is no ink (nothing drawn, or only non-finite points). */
export function signatureFromStrokes(strokes: readonly Stroke[]): Signature | null {
  const clean = strokes
    .map((s) => {
      const out: Point[] = [];
      for (const p of s) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const last = out[out.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) out.push(p);
      }
      return out;
    })
    .filter((s) => s.length > 0);
  if (clean.length === 0) return null;
  if (clean.reduce((n, s) => n + s.length, 0) > MAX_SIGNATURE_POINTS) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of clean) for (const p of s) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const ox = minX - MARGIN;
  const oy = minY - MARGIN;
  const w = Math.max(1, Math.ceil(maxX - minX + 2 * MARGIN));
  const h = Math.max(1, Math.ceil(maxY - minY + 2 * MARGIN));
  const parts: string[] = [];
  for (const s of clean) {
    const pts = simplify(s.map((p) => ({ x: p.x - ox, y: p.y - oy })));
    const head = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
    // A single tap is a dot: a zero-length segment, which round caps draw as a dot.
    const tail = pts.length === 1 ? [` L${fmt(pts[0].x)} ${fmt(pts[0].y)}`] : pts.slice(1).map((p) => ` L${fmt(p.x)} ${fmt(p.y)}`);
    parts.push(head + tail.join(''));
  }
  const d = parts.join(' ');
  if (d.length > MAX_SIGNATURE_CHARS || w > 99_999 || h > 99_999) return null;
  return { v: 1, w, h, d };
}

export function serializeSignature(sig: Signature): string {
  return JSON.stringify(sig);
}

/** A stored signature text → the signature, or null when it is empty, damaged or not exactly our grammar. */
export function parseSignature(text: string | null | undefined): Signature | null {
  if (!text || text.length > MAX_SIGNATURE_CHARS + 100) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { v, w, h, d } = raw as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'd,h,v,w') return null;
  if (v !== 1 || !Number.isInteger(w) || !Number.isInteger(h) || (w as number) < 1 || (h as number) < 1 || (w as number) > 99_999 || (h as number) > 99_999) return null;
  if (typeof d !== 'string' || d.length > MAX_SIGNATURE_CHARS || !PATH.test(d)) return null;
  return { v: 1, w: w as number, h: h as number, d };
}

/** Inline SVG for HTML (PDF). `height` in mm; the width follows the aspect ratio. Only validated input reaches here. */
export function signatureSvg(sig: Signature, heightMm: number, color = '#1a1a1a'): string {
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#1a1a1a';
  const stroke = Math.max(1.5, Math.min(sig.w, sig.h) / 40).toFixed(1);
  return `<svg class="signature" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sig.w} ${sig.h}" style="height:${heightMm}mm;width:auto;max-width:70mm" preserveAspectRatio="xMinYMid meet"><path d="${sig.d}" fill="none" stroke="${safeColor}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
