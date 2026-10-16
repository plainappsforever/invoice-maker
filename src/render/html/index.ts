// renderHtml(model, { paper, template }) → one full HTML document with inline CSS, the embedded Inter font, the
// logo as data URI and the GiroCode as inline SVG (D23, V1_PLAN "Rendering"). PURE and deterministic: the same
// model + options give the same string (no clock, no random ids). expo-print (P5) turns it into a PDF; the
// in-app preview shows the same string (D24).
import { formatAmount } from '@/engine/money';
import { RENDERER_VERSION, type RenderModel } from '@/render/model';
import { parseSignature, signatureSvg } from '@/engine/signature';
import { translate } from '@/i18n';

import { classic } from './classic';
import { compact } from './compact';
import { foldMarks, geometryFor, mm } from './din5008';
import { FONT_FACE_CSS, FONT_FAMILY } from '../fonts.generated';
import { acceptanceCaption, computeLayout, paginate, SIGNATURE_H, THUMB_H, THUMB_MAX_W, type BlockId, type Layout, type PagePlan } from './paginate';
import { qrSvg } from './qr-svg';
import { modern } from './modern';
import {
  addressLines,
  esc,
  escMultiline,
  fmtMoney,
  infoRows,
  lineCells,
  paymentBlock,
  safeAccent,
  safeLogo,
  safeImages,
  shipToLine,
  printedAttachments,
  senderFit,
  printedGroups,
  showVatSummary,
  subjectOf,
  TEMPLATE_IDS,
  totalsRows,
  vatGroupLabel,
  footerColumns,
  pageLine,
  type Ctx,
  type RenderOptions,
  type TemplateId,
} from './shared';
import type { TemplateDef } from './template';

export type { RenderOptions, RenderPayment, TemplateId } from './shared';
export { TEMPLATE_IDS } from './shared';
export { paginate, computeLayout, tooTall } from './paginate';
export type { PagePlan, TooTall } from './paginate';
export { buildCtx };

const TEMPLATES: Record<TemplateId, TemplateDef> = { classic, modern, compact };

function buildCtx(model: RenderModel, options: RenderOptions = {}): Ctx {
  const lang = model.language === 'en' ? 'en' : 'de';
  const paper = options.paper ?? model.layout.paper;
  const id = options.template ?? (model.layout.template as TemplateId);
  const template = TEMPLATES[(TEMPLATE_IDS as readonly string[]).includes(id) ? id : 'classic'];
  const payments = options.payments ?? [];
  const paid = payments.reduce((sum, p) => sum + p.amountCents, 0);
  return {
    model,
    lang,
    geo: geometryFor(paper),
    spec: template.spec,
    accent: safeAccent(model.layout.accent),
    logo: safeLogo(options.logoDataUri),
    images: safeImages(options.images),
    signature: parseSignature(model.business.signature),
    acceptance: acceptanceOf(model, options),
    payments,
    paid: model.type === 'invoice' ? paid : 0,
    balance: model.type === 'invoice' ? model.totals.gross - paid : model.totals.gross,
    // §19 hides VAT — unless the document carries VAT anyway: the PDF never hides tax inside its total (D51).
    // A payment receipt shows no VAT breakdown (D79); receipts issued before v1.1 with VAT keep showing it.
    showVat: model.type === 'receipt' && model.receiptKind === 'payment'
      ? model.totals.tax !== 0
      : model.business.vatMode !== 'small_business' || model.totals.tax !== 0,
    tr: (key, params) => translate(lang, key, params),
  };
}

function acceptanceOf(model: RenderModel, options: RenderOptions): Ctx['acceptance'] {
  const a = options.acceptance;
  const signature = a ? parseSignature(a.signature) : null;
  return a && signature && model.type === 'quote' ? { signer: a.signer, signedAt: a.signedAt, signature } : null;
}

/** Which template renders a document (unknown names fall back to Classic). */
export function templateFor(model: RenderModel, options: RenderOptions = {}): TemplateDef {
  const ctx = buildCtx(model, options);
  return TEMPLATES[ctx.spec.id];
}

// ---------------------------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------------------------

function baseCss(ctx: Ctx, layout: Layout): string {
  const { spec, geo } = ctx;
  return `
@page{margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{font-family:${FONT_FAMILY};font-size:${spec.fontPx}px;line-height:${spec.lh}px;color:#1a1a1a;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;word-break:break-word}
.page{position:relative;width:${geo.w}px;height:${geo.h}px;overflow:hidden;background:#fff;break-after:page;page-break-after:always}
.page:last-child{break-after:auto;page-break-after:auto}
.abs{position:absolute}
.mark{position:absolute;left:${mm(5)}px;width:${mm(5)}px;border-top:0.5px solid #777;height:0}
.mark.punch{width:${mm(8)}px}
.addr{left:${mm(20)}px;width:${mm(85)}px}
.sender{font-size:${spec.smallPx - 0.5}px;line-height:${mm(5)}px;height:${mm(5)}px;border-bottom:0.5px solid #999;white-space:nowrap;overflow:hidden;color:#444}
.to{padding-top:5px;font-size:${spec.fontPx + 1}px;line-height:${spec.lh + 1}px}
.info{display:block}
.ir{display:flex;gap:4px;font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;padding:1px 0}
.il{flex:0 0 ${layout.infoLabelWidth}px;color:#555}
.iv{flex:1 1 auto;font-weight:600}
h1.subject{margin:0;font-size:15px;line-height:20px;font-weight:600}
.body{position:absolute}
.intro{padding-bottom:10px}
table.lines{width:100%;table-layout:fixed;border-collapse:collapse;font-size:${spec.fontPx}px}
table.lines th{font-size:${spec.smallPx + 0.5}px;line-height:${spec.lhSmall}px;font-weight:600;text-align:left;padding:3px ${layout.cellPadX}px;vertical-align:bottom}
table.lines td{padding:${spec.cellPadV}px ${layout.cellPadX}px;vertical-align:top}
table.lines .num{text-align:right;white-space:nowrap}
table.lines th.num{text-align:right}
table.lines .nm{font-weight:600}
table.lines .sub{font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#555;font-weight:400}
table.lines tr.carry td{font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#555;font-style:italic}
.blk{padding-top:8px}
table.tot{margin-left:auto;border-collapse:collapse}
.tot-col table.vat{margin-top:6px}
table.tot td{padding:1px 0;line-height:${spec.lh + 2}px;vertical-align:top}
table.tot td.v{text-align:right;white-space:nowrap;padding-left:8px}
table.tot tr.strong td{font-weight:600;border-top:0.75px solid #333;padding-top:2px}
table.tot tr.muted td{color:#555;font-size:${spec.smallPx + 0.5}px}
table.vat{margin-left:auto;margin-top:6px;border-collapse:collapse;font-size:${spec.smallPx}px;line-height:${spec.lhSmall + 2}px}
table.vat caption{text-align:left;font-weight:600;color:#555;padding-bottom:1px}
table.vat th{font-weight:400;color:#555;text-align:right;border-bottom:0.5px solid #aaa}
table.vat th:first-child,table.vat td:first-child{text-align:left}
table.vat td{text-align:right;white-space:nowrap}
table.vat tr.sum td{font-weight:600;border-top:0.5px solid #aaa}
.legal{font-size:${spec.smallPx + 0.5}px;line-height:${spec.lhSmall + 1}px;border-left:2px solid ${ctx.accent};padding:2px 0 2px 6px;margin-top:2px}
.notes,.closing{padding-top:6px}
.summary{display:flex;gap:14px;justify-content:space-between;align-items:flex-start}
.tot-col{flex:0 0 ${layout.totalsWidth}px;margin-left:auto}
.pay{flex:0 0 auto}
.pay .paylow{display:flex;gap:8px;align-items:flex-start;margin-top:4px}
.pay .bank{font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#444;flex:1 1 auto;min-width:0}
.pay .bank b{font-weight:600;color:#222}
.pay .qr{flex:0 0 ${layout.qrSize}px;text-align:center;font-size:${spec.smallPx - 1}px;line-height:${spec.lhSmall - 1}px;color:#555}
.pay .qr svg{display:block}
.foot{position:absolute;left:${geo.marginLeft}px;width:${geo.contentWidth}px;bottom:${layout.footerBottom}px;font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#444;padding-top:3px}
.foot .cols{display:flex;gap:${layout.footerGap}px}
.foot .col{flex:1 1 0;min-width:0}
.foot .biz{padding-top:3px}
.foot .pageno{text-align:right;padding-top:2px}
.shipto{font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#333;padding-bottom:6px}
table.lines img.thumb{display:block;height:${THUMB_H}px;max-width:${THUMB_MAX_W}px;object-fit:contain;margin:0 0 3px 0}
.sig{padding-top:10px}
.sig svg{display:block;height:${SIGNATURE_H}px}
.sig .cap{font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#555;padding-top:2px}
.attpage{position:absolute;display:flex;flex-direction:column;align-items:center}
.attpage .cap{font-size:${spec.smallPx}px;line-height:${spec.lhSmall}px;color:#555;align-self:flex-start;padding-bottom:4px}
.attpage img{flex:1 1 auto;min-height:0;max-width:100%;object-fit:contain}
`;
}

// ---------------------------------------------------------------------------------------------
// Page parts
// ---------------------------------------------------------------------------------------------

function th(text: string, width: number, cls = ''): string {
  return `<th class="${cls}" style="width:${width}px">${esc(text)}</th>`;
}

function tableHtml(ctx: Ctx, layout: Layout, page: PagePlan, cumulative: number[]): string {
  const { tr, lang, model } = ctx;
  const c = layout.cols;
  const cols = ctx.showVat ? 6 : 5;
  const colgroup =
    `<colgroup><col style="width:${c.pos}px"><col>` +
    `<col style="width:${c.qty}px"><col style="width:${c.price}px">` +
    (ctx.showVat ? `<col style="width:${c.vat}px">` : '') +
    `<col style="width:${c.amount}px"></colgroup>`;
  const head =
    `<thead><tr>${th(tr('render.col.pos'), c.pos)}${th(tr('render.col.desc'), c.desc)}${th(tr('render.col.qty'), c.qty, 'num')}` +
    `${th(tr('render.col.price'), c.price, 'num')}${ctx.showVat ? th(tr('render.col.vat'), c.vat, 'num') : ''}${th(tr('render.col.amount'), c.amount, 'num')}</tr></thead>`;
  const first = page.rows[0];
  const last = page.rows[page.rows.length - 1];
  const carry = (label: string, cents: number, cls: string) =>
    `<tr class="carry ${cls}"><td colspan="${cols - 1}" style="text-align:right">${esc(label)}</td><td class="num">${esc(formatAmount(cents, lang))}</td></tr>`;
  let body = '';
  if (page.carryIn) body += carry(tr('render.carry'), cumulative[first - 1], 'in');
  for (const i of page.rows) {
    const line = model.lines[i];
    const cells = lineCells(ctx, line);
    body +=
      `<tr class="row" data-line="${line.position}"><td>${esc(cells.pos)}</td>` +
      `<td>${line.imageFile && ctx.images[line.imageFile] ? `<img class="thumb" alt="" src="${ctx.images[line.imageFile]}">` : ''}<div class="nm" dir="auto">${esc(cells.name)}</div>` +
      (cells.description ? `<div class="sub" dir="auto">${escMultiline(cells.description)}</div>` : '') +
      (cells.discount ? `<div class="sub">${esc(cells.discount)}</div>` : '') +
      `</td><td class="num">${esc(cells.qty)}</td><td class="num">${esc(cells.price)}</td>` +
      (ctx.showVat ? `<td class="num">${esc(cells.vat)}</td>` : '') +
      `<td class="num">${esc(cells.amount)}</td></tr>`;
  }
  if (page.carryOut) body += carry(tr('render.carry'), cumulative[last], 'out');
  return `<table class="lines" data-table="1">${colgroup}${head}<tbody>${body}</tbody></table>`;
}

function totalsHtml(ctx: Ctx, layout: Layout): string {
  const rows = totalsRows(ctx)
    .map((r) => `<tr class="${r.kind}"><td style="width:${layout.totalsLabelWidth}px">${esc(r.label)}</td><td class="v">${esc(r.value)}</td></tr>`)
    .join('');
  let html = `<table class="tot" style="width:${layout.totalsWidth}px">${rows}</table>`;
  if (showVatSummary(ctx)) {
    const { tr, model } = ctx;
    const body = printedGroups(ctx)
      .map(
        (g) =>
          `<tr><td>${esc(vatGroupLabel(ctx, g.category, g.rateBp))}</td><td>${esc(fmtMoney(ctx, g.taxable))}</td><td>${esc(fmtMoney(ctx, g.tax))}</td><td>${esc(fmtMoney(ctx, g.gross))}</td></tr>`
      )
      .join('');
    html +=
      `<table class="vat" data-vat-summary="1" style="width:${layout.totalsWidth}px"><caption>${esc(tr('render.vat.summary'))}</caption>` +
      `<thead><tr><th></th><th>${esc(tr('render.vat.col.net'))}</th><th>${esc(tr('render.vat.col.tax'))}</th><th>${esc(tr('render.vat.col.gross'))}</th></tr></thead><tbody>${body}` +
      `<tr class="sum"><td>${esc(tr('render.vat.total'))}</td><td>${esc(fmtMoney(ctx, model.totals.net))}</td><td>${esc(fmtMoney(ctx, model.totals.tax))}</td><td>${esc(fmtMoney(ctx, model.totals.gross))}</td></tr></tbody></table>`;
  }
  return html;
}

function paymentHtml(ctx: Ctx, layout: Layout): string {
  const pay = paymentBlock(ctx);
  if (!pay) return '';
  const parts: string[] = [];
  if (pay.headline) parts.push(`<div><b>${esc(pay.headline)}</b></div>`);
  if (pay.deposit) parts.push(`<div>${esc(pay.deposit)}</div>`);
  if (pay.paymentText) parts.push(`<div>${escMultiline(pay.paymentText)}</div>`);
  const bank = pay.bankLines.length ? `<div class="bank">${pay.bankLines.map((r) => `${esc(r.label)}: <b>${esc(r.value)}</b>`).join('<br>')}</div>` : '';
  const qr = pay.qr ? `<div class="qr">${qrSvg(pay.qr, layout.qrSize)}<div>${esc(ctx.tr('render.girocode.caption'))}</div></div>` : '';
  const lower = qr || bank ? `<div class="paylow">${qr}${bank}</div>` : '';
  return `<div class="pay" data-block="payment" style="width:${layout.payWidth}px">${parts.join('')}${lower}</div>`;
}

/** Payment column (left) and totals (right) as one block that never splits. */
function summaryHtml(ctx: Ctx, layout: Layout): string {
  return `<div class="blk summary" data-block="totals">${paymentHtml(ctx, layout)}<div class="tot-col">${totalsHtml(ctx, layout)}</div></div>`;
}

function blockHtml(ctx: Ctx, layout: Layout, id: BlockId): string {
  const { model } = ctx;
  switch (id) {
    case 'totals':
      return summaryHtml(ctx, layout);
    case 'legal':
      return `<div class="blk legal-wrap" data-block="legal"><div class="legal" data-legal-note="1">${escMultiline(model.texts.legalNote)}</div></div>`;
    case 'notes':
      return `<div class="notes" data-block="notes">${escMultiline(model.texts.notes)}</div>`;
    case 'closing':
      return `<div class="closing" data-block="closing">${escMultiline(model.texts.footer)}</div>`;
    case 'signature':
      return ctx.signature
        ? `<div class="sig" data-block="signature">${signatureSvg(ctx.signature, SIGNATURE_H * 0.2646)}<div class="cap">${esc(model.business.name)}</div></div>`
        : '';
    case 'acceptance':
      return ctx.acceptance
        ? `<div class="sig" data-block="acceptance"><div class="cap">${esc(acceptanceCaption(ctx))}</div>${signatureSvg(ctx.acceptance.signature, SIGNATURE_H * 0.2646)}</div>`
        : '';
  }
}

/** One attachment photo per page after the document, with the later-page head and the same footer (V1.5 P1). */
function attachmentPageHtml(ctx: Ctx, layout: Layout, template: TemplateDef, index: number, page: number, pages: number): string {
  const att = printedAttachments(ctx)[index];
  const top = layout.bodyTopNext;
  const height = ctx.geo.h - top - layout.reserve;
  const caption = ctx.tr('render.attachment', { n: index + 1 }) + (att.name.trim() ? `: ${att.name.trim()}` : '');
  return (
    `<section class="page" data-page="${page}" data-pages="${pages}" data-attachment="${index + 1}">${template.laterHead(ctx)}${marksHtml(ctx)}` +
    `<div class="attpage" style="top:${top}px;left:${ctx.geo.marginLeft}px;width:${ctx.geo.contentWidth}px;height:${height}px">` +
    `<div class="cap">${esc(caption)}</div><img alt="" src="${ctx.images[att.file]}"></div>` +
    `${footerHtml(ctx, page, pages)}</section>`
  );
}

function footerHtml(ctx: Ctx, page: number, pages: number): string {
  const cols = footerColumns(ctx)
    .map((col) => `<div class="col">${col.map((l) => esc(l)).join('<br>')}</div>`)
    .join('');
  const biz = ctx.model.business.footer.trim();
  return (
    `<div class="foot">${cols ? `<div class="cols">${cols}</div>` : ''}` +
    (biz ? `<div class="biz">${escMultiline(biz)}</div>` : '') +
    `<div class="pageno" data-page-number="1">${esc(pageLine(ctx, page, pages))}</div></div>`
  );
}

function marksHtml(ctx: Ctx): string {
  if (!ctx.spec.foldMarks) return '';
  const { fold, punch } = foldMarks(ctx.geo);
  return fold.map((y) => `<div class="mark" data-mark="fold" style="top:${y}px"></div>`).join('') + `<div class="mark punch" data-mark="punch" style="top:${punch}px"></div>`;
}

function firstPageTop(ctx: Ctx, layout: Layout): string {
  const { spec, geo } = ctx;
  const addr = addressLines(ctx)
    .map((l) => `<span dir="auto">${esc(l)}</span>`) // Arabic/Hebrew names keep their direction (review #13)
    .join('<br>');
  const info = infoRows(ctx)
    .map((r, i) => `<div class="ir" style="height:${layout.infoRowHeights[i]}px"><span class="il">${esc(r.label)}</span><span class="iv">${esc(r.value)}</span></div>`)
    .join('');
  const sender = senderFit(ctx, mm(85));
  const senderStyle = sender.px !== spec.smallPx - 0.5 ? ` style="font-size:${sender.px}px"` : '';
  return (
    `<div class="abs addr" style="top:${layout.addressTop}px;height:${layout.addressHeight}px" data-address="1"><div class="sender"${senderStyle}>${esc(sender.text)}</div><div class="to">${addr}</div></div>` +
    `<div class="abs info" style="top:${mm(spec.infoTopMm)}px;left:${layout.infoLeft}px;width:${layout.infoWidth}px">${info}</div>` +
    `<h1 class="abs subject" style="top:${layout.subjectTop}px;left:${geo.marginLeft}px;width:${geo.contentWidth}px">${esc(subjectOf(ctx))}</h1>`
  );
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

export function renderHtml(model: RenderModel, options: RenderOptions = {}): string {
  const ctx = buildCtx(model, options);
  const template = TEMPLATES[ctx.spec.id];
  const layout = computeLayout(ctx);
  const plan = paginate(ctx, layout);

  // running sum of the line amounts shown in the table, for the "carried forward" rows
  const cumulative: number[] = [];
  let running = 0;
  for (const line of model.lines) {
    running += line.net;
    cumulative.push(running);
  }

  const attachments = printedAttachments(ctx);
  const total = plan.length + attachments.length;
  const ship = shipToLine(ctx);
  const pages = plan
    .map((page, p) => {
      const first = p === 0;
      const top = first ? layout.bodyTopFirst : layout.bodyTopNext;
      let body = '';
      if (page.intro && ship) body += `<div class="shipto" data-block="shipto" dir="auto">${esc(ship)}</div>`;
      if (page.intro && model.texts.intro.trim()) body += `<div class="intro" data-block="intro">${escMultiline(model.texts.intro)}</div>`;
      if (page.rows.length > 0) body += tableHtml(ctx, layout, page, cumulative);
      for (const id of page.blocks) body += blockHtml(ctx, layout, id);
      const head = first ? template.letterhead(ctx) + marksHtml(ctx) + firstPageTop(ctx, layout) : template.laterHead(ctx) + marksHtml(ctx);
      return (
        `<section class="page" data-page="${p + 1}" data-pages="${total}">${head}` +
        `<div class="body" style="top:${top}px;left:${ctx.geo.marginLeft}px;width:${ctx.geo.contentWidth}px">${body}</div>` +
        `${footerHtml(ctx, p + 1, total)}</section>`
      );
    })
    .concat(attachments.map((_, i) => attachmentPageHtml(ctx, layout, template, i, plan.length + i + 1, total)))
    .join('\n');

  const fonts = options.embedFonts === false ? '' : FONT_FACE_CSS;
  return (
    `<!doctype html>\n<html lang="${ctx.lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=${ctx.geo.w}">` +
    `<meta name="generator" content="invoice-maker renderer ${RENDERER_VERSION}">` +
    `<title>${esc(subjectOf(ctx))}</title><style>${fonts}${baseCss(ctx, layout)}${template.css(ctx, layout)}</style></head>` +
    `<body data-template="${ctx.spec.id}" data-paper="${ctx.geo.paper}" data-pages="${total}">${pages}</body></html>`
  );
}
