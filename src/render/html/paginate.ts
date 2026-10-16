// Own pagination (D23, V1_PLAN "Rendering"): every page is a fixed-size box; this file decides which table
// rows and closing blocks go on which page, from a conservative height estimate (character-width table for
// Inter + 10 %, shared.ts). PURE. The templates render exactly this plan: a header row on every page that
// has rows, "Übertrag / Carried forward" rows at the top and bottom where the table continues, closing
// blocks (totals, notes, payment) that never split, and "Seite n von m" in the footer.
import { mm } from './din5008';
import {
  footerColumns,
  pageLine,
  infoRows,
  lineCells,
  paymentBlock,
  printedGroups,
  showVatSummary,
  subjectOf,
  totalsRows,
  wrapLineCount,
  shipToLine,
  type Ctx,
} from './shared';

export type BlockId = 'totals' | 'legal' | 'notes' | 'closing' | 'signature' | 'acceptance';

/** Fixed sizes of the V1.5 P1 additions (CSS uses the same numbers, so the estimate is exact). */
export const THUMB_H = mm(14);
export const THUMB_MAX_W = mm(24);
export const SIGNATURE_H = mm(15);

export type Measure = {
  capacityFirst: number;
  capacityNext: number;
  introH: number;
  tableHeadH: number;
  carryH: number;
  rowHeights: number[];
  blocks: { id: BlockId; h: number }[];
};

export type PagePlan = {
  index: number;
  intro: boolean;
  /** Indices of the lines on this page. */
  rows: number[];
  /** The table continues from the previous page (first row on this page is "carried forward"). */
  carryIn: boolean;
  /** The table continues on the next page. */
  carryOut: boolean;
  blocks: BlockId[];
  usedPx: number;
  capacityPx: number;
};

/** Distributes rows and blocks over pages. Always makes progress: an item taller than an empty page is placed anyway (the page clips it, so Issue refuses such a document: `tooTall`, D56). */
export function paginateItems(m: Measure): PagePlan[] {
  const pages: PagePlan[] = [];
  const open = (): PagePlan => {
    const page: PagePlan = {
      index: pages.length,
      intro: false,
      rows: [],
      carryIn: false,
      carryOut: false,
      blocks: [],
      usedPx: 0,
      capacityPx: pages.length === 0 ? m.capacityFirst : m.capacityNext,
    };
    pages.push(page);
    return page;
  };
  let page = open();
  const empty = (p: PagePlan) => p.usedPx === 0;

  if (m.introH > 0) {
    page.intro = true;
    page.usedPx += m.introH;
  }

  const n = m.rowHeights.length;
  for (let i = 0; i < n; i++) {
    for (;;) {
      const startsTable = page.rows.length === 0;
      const carryIn = i > 0;
      const base = startsTable ? m.tableHeadH + (carryIn ? m.carryH : 0) : 0;
      const need = m.rowHeights[i] + (i < n - 1 ? m.carryH : 0);
      if (page.usedPx + base + need <= page.capacityPx || (empty(page) && startsTable)) {
        if (startsTable) {
          page.usedPx += base;
          page.carryIn = carryIn;
        }
        page.rows.push(i);
        page.usedPx += m.rowHeights[i];
        break;
      }
      if (page.rows.length > 0) page.carryOut = true;
      page = open();
    }
  }
  // A page that ends with rows while the table goes on needs its "carried forward" row (reserved above for every
  // row except the last, so the last row of the table never reserves one).
  for (const p of pages) if (p.rows.length > 0 && p.rows[p.rows.length - 1] < n - 1) p.carryOut = true;
  for (const p of pages) if (p.carryOut) p.usedPx += m.carryH;

  for (const block of m.blocks) {
    if (page.usedPx + block.h > page.capacityPx && !empty(page)) page = open();
    page.blocks.push(block.id);
    page.usedPx += block.h;
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// Layout numbers shared by pagination and rendering
// ---------------------------------------------------------------------------------------------

export type Layout = {
  cols: { pos: number; desc: number; qty: number; price: number; vat: number; amount: number };
  cellPadX: number;
  infoLeft: number;
  infoWidth: number;
  infoLabelWidth: number;
  infoRowHeights: number[];
  addressTop: number;
  addressHeight: number;
  subjectTop: number;
  subjectH: number;
  bodyTopFirst: number;
  bodyTopNext: number;
  footerH: number;
  footerBottom: number;
  footerGap: number;
  reserve: number;
  tableHeadH: number;
  carryH: number;
  totalsWidth: number;
  totalsLabelWidth: number;
  /** Width of the payment column left of the totals. */
  payWidth: number;
  qrSize: number;
};

const TITLE_PX = 15;
const TITLE_LH = 20;
const CELL_PAD_X = 3;

export function computeLayout(ctx: Ctx): Layout {
  const { geo, spec, model } = ctx;
  const cw = geo.contentWidth;
  const pos = 28;
  const qty = 62;
  const price = 58;
  const vat = ctx.showVat ? 36 : 0;
  const amount = 64;
  const desc = cw - pos - qty - price - vat - amount;

  const infoLeft = mm(spec.infoLeftMm);
  const infoWidth = geo.w - infoLeft - geo.marginRight;
  const infoLabelWidth = Math.round(infoWidth * 0.42);
  const infoValueWidth = infoWidth - infoLabelWidth - 4;
  const infoRowHeights = infoRows(ctx).map(
    (r) => Math.max(wrapLineCount(r.label, infoLabelWidth, spec.smallPx), wrapLineCount(r.value, infoValueWidth, spec.smallPx, true)) * spec.lhSmall + 2
  );
  const infoH = infoRowHeights.reduce((a, b) => a + b, 0);

  const addressTop = mm(spec.addressTopMm);
  const addressHeight = mm(spec.addressHeightMm);
  const subjectTop = mm(spec.subjectTopMm);
  const subjectH = wrapLineCount(subjectOf(ctx), cw, TITLE_PX, true) * TITLE_LH + 6;
  const bodyTopFirst = Math.round(Math.max(subjectTop + subjectH, mm(spec.infoTopMm) + infoH, addressTop + addressHeight) + 6);
  const bodyTopNext = mm(spec.laterBodyTopMm);

  const cols = footerColumns(ctx);
  const footerGap = 12;
  const colWidth = cols.length ? (cw - (cols.length - 1) * footerGap) / cols.length : cw;
  const colLines = cols.reduce((max, col) => Math.max(max, col.reduce((sum, line) => sum + wrapLineCount(line, colWidth, spec.smallPx), 0)), 0);
  const bizFooter = model.business.footer.trim();
  const bizFooterLines = bizFooter ? wrapLineCount(bizFooter, cw, spec.smallPx) : 0;
  const pageLines = wrapLineCount(pageLine(ctx, 99, 99), cw, spec.smallPx); // 1, or more with the e-invoice note (D88)
  const footerH = colLines * spec.lhSmall + (bizFooterLines ? bizFooterLines * spec.lhSmall + 3 : 0) + pageLines * spec.lhSmall + 8;
  const footerBottom = mm(8);
  const reserve = Math.ceil(footerH + footerBottom + 10);

  const totalsWidth = Math.round(cw * 0.58);
  return {
    cols: { pos, desc, qty, price, vat, amount },
    cellPadX: CELL_PAD_X,
    infoLeft,
    infoWidth,
    infoLabelWidth,
    infoRowHeights,
    addressTop,
    addressHeight,
    subjectTop,
    subjectH,
    bodyTopFirst,
    bodyTopNext,
    footerH,
    footerBottom,
    footerGap,
    reserve,
    tableHeadH: spec.lhSmall + 8,
    carryH: spec.lhSmall + 2 * spec.cellPadV,
    totalsWidth,
    totalsLabelWidth: totalsWidth - 84,
    payWidth: cw - totalsWidth - 14,
    qrSize: 66,
  };
}

/** "Accepted by Eva Klein on 14.10.2026" above the client's signature on a signed quote copy. */
export function acceptanceCaption(ctx: Pick<Ctx, 'acceptance' | 'tr'>): string {
  const a = ctx.acceptance;
  return a ? ctx.tr('render.accepted', { name: a.signer.trim() || '—', date: a.signedAt }) : '';
}

/** Estimated height of one line-item row. */
export function rowHeight(ctx: Ctx, layout: Layout, index: number): number {
  const { spec } = ctx;
  const cells = lineCells(ctx, ctx.model.lines[index]);
  const w = (col: number) => col - 2 * layout.cellPadX;
  let desc = wrapLineCount(cells.name || ' ', w(layout.cols.desc), spec.fontPx, true) * spec.lh;
  if (cells.description) desc += wrapLineCount(cells.description, w(layout.cols.desc), spec.smallPx) * spec.lhSmall;
  if (cells.discount) desc += wrapLineCount(cells.discount, w(layout.cols.desc), spec.smallPx) * spec.lhSmall;
  const image = ctx.model.lines[index].imageFile;
  if (image && ctx.images[image]) desc += THUMB_H + 3;
  const others = Math.max(
    wrapLineCount(cells.qty, w(layout.cols.qty), spec.fontPx),
    wrapLineCount(cells.price, w(layout.cols.price), spec.fontPx),
    wrapLineCount(cells.amount, w(layout.cols.amount), spec.fontPx),
    ctx.showVat ? wrapLineCount(cells.vat, w(layout.cols.vat), spec.fontPx) : 1
  );
  return Math.ceil(Math.max(desc, others * spec.lh) + 2 * spec.cellPadV + 1);
}

function textBlockH(text: string, width: number, fontPx: number, lh: number, pad: number): number {
  return text.trim() ? wrapLineCount(text, width, fontPx) * lh + pad : 0;
}

export function measure(ctx: Ctx, layout: Layout): Measure {
  const { spec, model, geo } = ctx;
  const cw = geo.contentWidth;
  const rows = model.lines.map((_, i) => rowHeight(ctx, layout, i));

  const totals = totalsRows(ctx);
  const rowH = spec.lh + 2;
  let totalsH = totals.reduce((sum, r) => sum + Math.max(wrapLineCount(r.label, layout.totalsLabelWidth, spec.fontPx), 1) * rowH + (r.kind === 'strong' ? 3 : 0), 0) + 4;
  if (showVatSummary(ctx)) totalsH += (printedGroups(ctx).length + 3) * (spec.lhSmall + 2) + 12;

  // The payment column (text, bank details, GiroCode) sits left of the totals; the block is as tall as the taller side.
  const pay = paymentBlock(ctx);
  let payH = 0;
  if (pay) {
    const w = layout.payWidth;
    if (pay.headline) payH += wrapLineCount(pay.headline, w, spec.fontPx, true) * spec.lh;
    if (pay.deposit) payH += wrapLineCount(pay.deposit, w, spec.fontPx) * spec.lh;
    if (pay.paymentText) payH += wrapLineCount(pay.paymentText, w, spec.fontPx) * spec.lh;
    const bankW = pay.qr ? w - layout.qrSize - 8 : w;
    const bankH = pay.bankLines.reduce((sum, r) => sum + wrapLineCount(`${r.label}: ${r.value}`, bankW, spec.smallPx, true) * spec.lhSmall, 0);
    payH += Math.max(bankH, pay.qr ? layout.qrSize + 2 * (spec.lhSmall - 1) : 0) + 6;
  }
  const blocks: Measure['blocks'] = [{ id: 'totals', h: Math.ceil(Math.max(totalsH, payH) + 10) }];
  const legalH = textBlockH(model.texts.legalNote, cw, spec.smallPx, spec.lhSmall, 12);
  if (legalH) blocks.push({ id: 'legal', h: Math.ceil(legalH) });
  const notesH = textBlockH(model.texts.notes, cw, spec.fontPx, spec.lh, 10);
  if (notesH) blocks.push({ id: 'notes', h: Math.ceil(notesH) });
  const closingH = textBlockH(model.texts.footer, cw, spec.fontPx, spec.lh, 10);
  if (closingH) blocks.push({ id: 'closing', h: Math.ceil(closingH) });
  if (ctx.signature) blocks.push({ id: 'signature', h: Math.ceil(10 + SIGNATURE_H + spec.lhSmall + 2) });
  if (ctx.acceptance) {
    const caption = wrapLineCount(acceptanceCaption(ctx), cw, spec.smallPx) * spec.lhSmall;
    blocks.push({ id: 'acceptance', h: Math.ceil(10 + caption + SIGNATURE_H + 2) });
  }

  const ship = shipToLine(ctx);
  const introH = textBlockH(model.texts.intro, cw, spec.fontPx, spec.lh, 10) + (ship ? wrapLineCount(ship, cw, spec.smallPx) * spec.lhSmall + 6 : 0);
  return {
    capacityFirst: ctx.geo.h - layout.bodyTopFirst - layout.reserve,
    capacityNext: ctx.geo.h - layout.bodyTopNext - layout.reserve,
    introH: Math.ceil(introH),
    tableHeadH: layout.tableHeadH,
    carryH: layout.carryH,
    rowHeights: rows,
    blocks,
  };
}

/** Items taller than an empty page: the page box would clip them (review #9). */
export type TooTall = { intro: boolean; rows: number[]; blocks: BlockId[] };

export function tooTallItems(m: Measure): TooTall {
  const n = m.rowHeights.length;
  return {
    intro: m.introH > m.capacityFirst,
    // a row alone on a later page: header, "carried forward" in (not for the first row) and out (not for the last)
    rows: m.rowHeights.flatMap((h, i) => (h + m.tableHeadH + (i > 0 ? m.carryH : 0) + (i < n - 1 ? m.carryH : 0) > m.capacityNext ? [i] : [])),
    blocks: m.blocks.filter((b) => b.h > m.capacityNext).map((b) => b.id),
  };
}

/** What `paginate` would have to clip for this document (the check refuses to issue it, D56). */
export function tooTall(ctx: Ctx, layout: Layout = computeLayout(ctx)): TooTall {
  return tooTallItems(measure(ctx, layout));
}

export function paginate(ctx: Ctx, layout: Layout = computeLayout(ctx)): PagePlan[] {
  return paginateItems(measure(ctx, layout));
}
