// Page geometry (D23, RESEARCH §2.4). PURE. All templates are laid out in px at 72 ppi (1 px = 1 pt):
// A4 595 × 842, Letter 612 × 792 — the numbers expo-print takes as width/height. Positions are given in
// millimetres and converted here, so the DIN 5008 constants stay readable.

export type Paper = 'A4' | 'LETTER';

export const PAPER_PX: Record<Paper, { w: number; h: number }> = {
  A4: { w: 595, h: 842 },
  LETTER: { w: 612, h: 792 },
};

export const PX_PER_MM = 72 / 25.4;

/** Millimetres → px at 72 ppi, two decimals. */
export function mm(value: number): number {
  return Math.round(value * PX_PER_MM * 100) / 100;
}

/**
 * DIN 5008 Form B (window envelope, RESEARCH §2.4; the standard itself is paywalled, the measurements come
 * from secondary sources — an owner print test is the check): address field 20 mm from the left, 45 mm from
 * the top, 85 × 45 mm, the first 5 mm hold the one-line sender; fold marks 105 mm and 210 mm, punch mark
 * 148.5 mm; the info block starts 125 mm from the left; the subject line sits at 98.5 mm.
 */
export const DIN5008_B = {
  addressLeftMm: 20,
  addressTopMm: 45,
  addressWidthMm: 85,
  addressHeightMm: 45,
  senderLineMm: 5,
  foldMarksMm: [105, 210],
  punchMarkMm: 148.5,
  infoLeftMm: 125,
  subjectTopMm: 98.5,
} as const;

/** Left and right page margins (mm): content is 170 mm wide on A4, aligned with the address field. */
export const MARGIN_MM = { left: 20, right: 20 } as const;

export type Geometry = {
  paper: Paper;
  w: number;
  h: number;
  marginLeft: number;
  marginRight: number;
  contentWidth: number;
};

export function geometryFor(paper: Paper): Geometry {
  const { w, h } = PAPER_PX[paper] ?? PAPER_PX.A4;
  const marginLeft = mm(MARGIN_MM.left);
  const marginRight = mm(MARGIN_MM.right);
  return { paper: paper in PAPER_PX ? paper : 'A4', w, h, marginLeft, marginRight, contentWidth: w - marginLeft - marginRight };
}

/**
 * Fold and punch mark positions in px from the top. A4 uses the DIN values; Letter (folded in thirds for a
 * US window envelope) puts them at 1/3, 2/3 and the middle of the page height.
 */
export function foldMarks(geo: Geometry): { fold: number[]; punch: number } {
  if (geo.paper === 'A4') return { fold: DIN5008_B.foldMarksMm.map(mm), punch: mm(DIN5008_B.punchMarkMm) };
  return { fold: [Math.round(geo.h / 3), Math.round((2 * geo.h) / 3)], punch: Math.round(geo.h / 2) };
}
