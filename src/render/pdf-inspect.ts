// A tiny, dependency-free look into a PDF file (P5 device checks, D23): page count, page sizes, font names and
// whether font programs are embedded. PURE. It reads the uncompressed object dictionaries that the iOS
// (Core Graphics) and Android (Skia) print engines write; a PDF that hides its page tree in compressed object
// streams reports `objectStreams: true` and its page count from the /Count of the page tree only.
// The independent re-parse of the pulled files (pdf.js in Node, V1_LOG P5) is the referee; this is the on-device probe.

export type PdfInfo = {
  bytes: number;
  version: string;
  /** Leaf page objects (/Type /Page). */
  pages: number;
  /** Largest /Count of a page tree node (the root's). */
  treeCount: number;
  /** [width, height] in points per leaf page (its MediaBox or the inherited one, rounded to 0.1). */
  mediaBoxes: [number, number][];
  /** Distinct /BaseFont names without the subset prefix ("ABCDEF+Inter-Regular" → "Inter-Regular"). */
  fonts: string[];
  /** Number of embedded font programs (/FontFile, /FontFile2, /FontFile3). */
  embeddedFonts: number;
  objectStreams: boolean;
};

function latin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x2000; // small enough for any engine's argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function inspectPdf(bytes: Uint8Array): PdfInfo {
  const s = latin1(bytes);
  const version = /^%PDF-(\d\.\d)/.exec(s)?.[1] ?? '';
  const pages = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  let treeCount = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    treeCount = Math.max(treeCount, Number(m[1] ?? m[2]));
  }
  // Page sizes from the leaf page objects; a page without its own box inherits the page tree's.
  const boxOf = (text: string): [number, number] | null => {
    const m = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
    return m ? [round1(Number(m[3]) - Number(m[1])), round1(Number(m[4]) - Number(m[2]))] : null;
  };
  let treeBox: [number, number] | null = null;
  const leaves: string[] = [];
  for (const m of s.matchAll(/\d+\s+\d+\s+obj\b([\s\S]*?)(?:\bstream\b|\bendobj\b)/g)) {
    const body = m[1];
    if (/\/Type\s*\/Pages\b/.test(body)) treeBox ??= boxOf(body);
    else if (/\/Type\s*\/Page(?![a-zA-Z])/.test(body)) leaves.push(body);
  }
  const mediaBoxes = leaves.map((body) => boxOf(body) ?? treeBox).filter((b): b is [number, number] => b !== null);
  const fonts = new Set<string>();
  for (const m of s.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)) fonts.add(m[1].replace(/^[A-Z]{6}\+/, ''));
  const embeddedFonts = (s.match(/\/FontFile[23]?(?![a-zA-Z])/g) ?? []).length;
  return {
    bytes: bytes.length,
    version,
    pages,
    treeCount,
    mediaBoxes,
    fonts: [...fonts].sort(),
    embeddedFonts,
    objectStreams: /\/Type\s*\/ObjStm\b/.test(s),
  };
}

/**
 * The bytes of a PDF with the parts that legitimately change between two renders of the same HTML removed:
 * creation/modification dates, the document /ID and the random font-subset prefixes. Two renders are
 * "byte-stable" when these normalised strings are equal.
 */
export function stablePdfText(bytes: Uint8Array): string {
  return latin1(bytes)
    .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '/$1()')
    .replace(/\/ID\s*\[\s*<[0-9A-Fa-f]*>\s*<[0-9A-Fa-f]*>\s*\]/g, '/ID[]')
    .replace(/\/([A-Z]{6})\+/g, '/XXXXXX+');
}
