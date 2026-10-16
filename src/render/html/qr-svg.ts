// GiroCode drawing (D26): the EPC payload from src/engine/epc-qr.ts → QR (qrcode-generator 2.0.4, error
// correction level M) → one SVG path. PURE (the library has no dependencies and touches no platform API).
import qrcodeFactory from 'qrcode-generator';

/** UTF-8 bytes of a string, as a string of code units 0–255 (the library's default encoder keeps the low byte of each unit). */
export function utf8BinaryString(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out += String.fromCharCode(cp);
    else if (cp < 0x800) out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

/** The module matrix (true = dark) of a payload in byte mode, UTF-8 (EPC charset 1), level M, smallest version. */
export function qrMatrix(payload: string): boolean[][] {
  const qr = qrcodeFactory(0, 'M');
  qr.addData(utf8BinaryString(payload), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** SVG path data: one `M x y h w v1 h-w z` per horizontal run of dark modules (small, deterministic). */
export function matrixPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return parts.join('');
}

/** Quiet zone of the QR standard: 4 modules. */
export const QUIET_ZONE = 4;

/**
 * Inline SVG of the GiroCode, `sizePx` square including the quiet zone (the template uses ≥ 2 cm ≈ 57 px).
 */
export function qrSvg(payload: string, sizePx: number): string {
  const matrix = qrMatrix(payload);
  const n = matrix.length;
  const total = n + 2 * QUIET_ZONE;
  return (
    `<svg class="girocode" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="${-QUIET_ZONE} ${-QUIET_ZONE} ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="GiroCode">` +
    `<rect x="${-QUIET_ZONE}" y="${-QUIET_ZONE}" width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${matrixPath(matrix)}" fill="#000"/></svg>`
  );
}
