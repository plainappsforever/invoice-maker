// Shared pieces of the three templates (D23): text escaping, content builders (labels, number formatting per
// document language, totals, VAT summary, payment block, footer columns) and the estimated text metrics the
// paginator uses. PURE: a RenderModel (+ live payments) goes in, strings and numbers come out.
import { buildEpcPayload, remittanceText } from '@/engine/epc-qr';
import { formatAmount, formatMoney, formatPercent, formatPrice, formatQty, type Lang } from '@/engine/money';
import { formatDate, parseIsoDate } from '@/engine/dates';
import type { TranslationKey } from '@/i18n';
import type { ModelAttachment, ModelLine, RenderModel } from '@/render/model';
import type { Signature } from '@/engine/signature';
import type { GroupTotals, TaxCategory } from '@/engine/totals';

import type { Geometry } from './din5008';

export type TemplateId = 'classic' | 'modern' | 'compact';
export const TEMPLATE_IDS: readonly TemplateId[] = ['classic', 'modern', 'compact'];
export const DEFAULT_ACCENT = '#1F4E79';

export type RenderPayment = { date: string; amountCents: number };

export type RenderOptions = {
  paper?: 'A4' | 'LETTER';
  template?: TemplateId;
  /** `data:image/png;base64,…` of the business logo (the model only holds the file name, D41). */
  logoDataUri?: string | null;
  /** Payments of the invoice (live data, not frozen): paid amount, balance and the GiroCode amount. */
  payments?: RenderPayment[];
  /** Embed the Inter font (default true). Tests that compare layout pass false to keep strings small. */
  embedFonts?: boolean;
  /**
   * Data URIs of the photos the model names (line photos, attachment pages), keyed by file name (V1.5 P1). A photo
   * without a usable data URI is left out: the line prints without it, the page is skipped (and the count says so).
   */
  images?: Record<string, string>;
  /** The client's signature on an issued quote ("accepted by"), for the signed copy (V1.5 P1). */
  acceptance?: { signer: string; signedAt: string; signature: string } | null;
};

/** Geometry and typography of a template. Lengths in px unless the name says mm. */
export type TemplateSpec = {
  id: TemplateId;
  fontPx: number;
  smallPx: number;
  lh: number;
  lhSmall: number;
  cellPadV: number;
  letterheadTopMm: number;
  addressTopMm: number;
  addressHeightMm: number;
  infoTopMm: number;
  infoLeftMm: number;
  subjectTopMm: number;
  laterHeadTopMm: number;
  laterBodyTopMm: number;
  foldMarks: boolean;
};

export type Ctx = {
  model: RenderModel;
  lang: Lang;
  geo: Geometry;
  spec: TemplateSpec;
  accent: string;
  logo: string | null;
  payments: RenderPayment[];
  paid: number;
  /** gross − paid (invoices only; other types: gross). */
  balance: number;
  showVat: boolean;
  /** Usable photo data URIs by file name (only safe `data:image/png|jpeg;base64` values). */
  images: Record<string, string>;
  /** Parsed business signature, or null. */
  signature: Signature | null;
  acceptance: { signer: string; signedAt: string; signature: Signature } | null;
  tr: (key: TranslationKey, params?: Record<string, string | number>) => string;
};

// ---------------------------------------------------------------------------------------------
// Escaping and sanitising: ALL user text goes through esc()
// ---------------------------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes text (element content and attribute values). Control characters other than \n and \t are dropped. */
export function esc(text: string): string {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Escaped text with line breaks as <br>. */
export function escMultiline(text: string): string {
  return esc(text.replace(/\r\n?/g, '\n').trim()).replace(/\n/g, '<br>');
}

/** Only #RRGGBB reaches a style attribute or stylesheet (no CSS injection through the accent). */
export function safeAccent(color: string | null | undefined): string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_ACCENT;
}

/** Only base64 PNG/JPEG data URIs are accepted as logo. */
export function safeLogo(uri: string | null | undefined): string | null {
  return typeof uri === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(uri) ? uri : null;
}

export function safeImages(images: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, uri] of Object.entries(images ?? {})) {
    const safe = safeLogo(uri);
    if (safe) out[file] = safe;
  }
  return out;
}

/** "Delivery address: Lager Nord, Hafenstraße 1, 20457 Hamburg" (model 2), or null. */
export function shipToLine(ctx: Pick<Ctx, 'model' | 'lang' | 'tr'>): string | null {
  const ship = ctx.model.client?.shipTo;
  if (!ship) return null;
  const own = clean(ctx.model.business.countryCode).toUpperCase() || 'DE';
  const country = clean(ship.countryCode).toUpperCase();
  const parts = [ship.name, ship.street, joinParts([ship.postalCode, ship.city], ' '), country && country !== own ? countryName(country, ctx.lang) : '']
    .map(clean)
    .filter(Boolean);
  return parts.length ? `${ctx.tr('render.shipTo')}: ${parts.join(', ')}` : null;
}

/** Attachment pages that will print: the model's attachments that have a usable photo. */
export function printedAttachments(ctx: Pick<Ctx, 'model' | 'images'>): ModelAttachment[] {
  return (ctx.model.attachments ?? []).filter((a) => ctx.images[a.file]);
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const UNIT_KEYS = ['C62', 'HUR', 'DAY', 'MON', 'KMT', 'KGM', 'MTR', 'MTK', 'LTR', 'LS'] as const;

export function unitLabel(ctx: Pick<Ctx, 'tr'>, unitCode: string): string {
  return (UNIT_KEYS as readonly string[]).includes(unitCode) ? ctx.tr(`render.unit.${unitCode}` as TranslationKey) : unitCode;
}

export function fmtMoney(ctx: Pick<Ctx, 'model' | 'lang'>, cents: number): string {
  return formatMoney(cents, ctx.model.currency, ctx.lang);
}

export function fmtPercent(bp: number, lang: Lang): string {
  return formatPercent(bp, lang);
}

/** "September 2026" for the service month mode. */
export function monthYear(ctx: Pick<Ctx, 'tr'>, iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return iso;
  return `${ctx.tr('render.months').split(',')[parsed.m - 1]} ${parsed.y}`;
}

const COUNTRY_NAMES: Record<string, [string, string]> = {
  DE: ['Deutschland', 'Germany'], AT: ['Österreich', 'Austria'], CH: ['Schweiz', 'Switzerland'], LI: ['Liechtenstein', 'Liechtenstein'],
  LU: ['Luxemburg', 'Luxembourg'], BE: ['Belgien', 'Belgium'], NL: ['Niederlande', 'Netherlands'], FR: ['Frankreich', 'France'],
  IT: ['Italien', 'Italy'], ES: ['Spanien', 'Spain'], PT: ['Portugal', 'Portugal'], IE: ['Irland', 'Ireland'],
  GB: ['Vereinigtes Königreich', 'United Kingdom'], DK: ['Dänemark', 'Denmark'], SE: ['Schweden', 'Sweden'], NO: ['Norwegen', 'Norway'],
  FI: ['Finnland', 'Finland'], PL: ['Polen', 'Poland'], CZ: ['Tschechien', 'Czechia'], SK: ['Slowakei', 'Slovakia'],
  HU: ['Ungarn', 'Hungary'], SI: ['Slowenien', 'Slovenia'], HR: ['Kroatien', 'Croatia'], RO: ['Rumänien', 'Romania'],
  BG: ['Bulgarien', 'Bulgaria'], GR: ['Griechenland', 'Greece'], CY: ['Zypern', 'Cyprus'], MT: ['Malta', 'Malta'],
  EE: ['Estland', 'Estonia'], LV: ['Lettland', 'Latvia'], LT: ['Litauen', 'Lithuania'], US: ['USA', 'United States'],
  CA: ['Kanada', 'Canada'], AU: ['Australien', 'Australia'],
};

export function countryName(code: string, lang: Lang): string {
  const entry = COUNTRY_NAMES[code.trim().toUpperCase()];
  return entry ? entry[lang === 'de' ? 0 : 1] : code.trim().toUpperCase();
}

const clean = (s: string | null | undefined) => (s ?? '').trim();
const joinParts = (parts: (string | undefined | null)[], sep: string) => parts.map(clean).filter(Boolean).join(sep);

// ---------------------------------------------------------------------------------------------
// Address field, sender line, info block, titles
// ---------------------------------------------------------------------------------------------

export function titleOf(ctx: Pick<Ctx, 'model' | 'tr'>): string {
  const { model, tr } = ctx;
  if (model.type === 'receipt') return tr(model.receiptKind === 'payment' ? 'render.title.receipt.payment' : 'render.title.receipt.cash');
  return tr(`doc.type.${model.type}` as TranslationKey);
}

/** "Rechnung RE-2026-0001" / "Rechnung – Entwurf". */
export function subjectOf(ctx: Pick<Ctx, 'model' | 'tr'>): string {
  const number = ctx.model.number;
  return number ? `${titleOf(ctx)} ${number}` : `${titleOf(ctx)} – ${ctx.tr('render.draft')}`;
}

export function senderLine(ctx: Pick<Ctx, 'model'>): string {
  const b = ctx.model.business;
  return joinParts([b.name, b.street, joinParts([b.postalCode, b.city], ' ')], ' · ');
}

/** Smallest font the return-address line may shrink to (px = pt in print). */
export const SENDER_MIN_PX = 6;

/**
 * The one-line return address above the window (DIN 5008) must fit 85 mm: first the full line at the template's
 * size, then smaller (down to SENDER_MIN_PX), then without the street (postal code and town are what a return
 * needs most), then the name alone (clipped if even that is too long). P5 device finding: long business names cut
 * the town off (review #18).
 */
export function senderFit(ctx: Pick<Ctx, 'model' | 'spec'>, widthPx: number): { text: string; px: number } {
  const b = ctx.model.business;
  const place = joinParts([b.postalCode, b.city], ' ');
  const size = ctx.spec.smallPx - 0.5;
  const texts = [senderLine(ctx), joinParts([b.name, place], ' · '), clean(b.name)];
  for (const text of texts) {
    for (const px of [size, SENDER_MIN_PX]) if (textWidth(text, px) <= widthPx) return { text, px };
  }
  return { text: texts[2] || texts[0], px: SENDER_MIN_PX };
}

export function businessAddressLines(ctx: Pick<Ctx, 'model' | 'lang'>): string[] {
  const b = ctx.model.business;
  const lines = [clean(b.street), joinParts([b.postalCode, b.city], ' ')];
  if (clean(b.countryCode) && clean(b.countryCode).toUpperCase() !== 'DE') lines.push(countryName(b.countryCode, ctx.lang));
  return lines.filter(Boolean);
}

export function addressLines(ctx: Pick<Ctx, 'model' | 'lang' | 'tr'>): string[] {
  const c = ctx.model.client;
  if (!c) return [];
  const lines = [clean(c.name)];
  if (clean(c.contact)) lines.push(ctx.tr('render.client.attn', { name: clean(c.contact) }));
  if (clean(c.street)) lines.push(clean(c.street));
  const cityLine = joinParts([c.postalCode, c.city], ' ');
  if (cityLine) lines.push(cityLine);
  const own = clean(ctx.model.business.countryCode).toUpperCase() || 'DE';
  const theirs = clean(c.countryCode).toUpperCase();
  if (theirs && theirs !== own) lines.push(countryName(theirs, ctx.lang).toUpperCase());
  return lines.filter(Boolean);
}

export type InfoRow = { label: string; value: string };

export function serviceText(ctx: Pick<Ctx, 'model' | 'lang' | 'tr'>): InfoRow | null {
  const { model, lang, tr } = ctx;
  if (model.type === 'quote' || (model.type === 'receipt' && model.receiptKind === 'payment')) return null;
  const from = model.serviceFrom;
  const to = model.serviceTo;
  switch (model.serviceMode) {
    case 'none':
      return null;
    case 'same':
      return { label: tr('render.date.service'), value: `${formatDate(model.issueDate, lang)} (${tr('render.service.same')})` };
    case 'date':
      return from ? { label: tr('render.date.service'), value: formatDate(from, lang) } : null;
    case 'month':
      return from ? { label: tr('render.date.period'), value: monthYear(ctx, from) } : null;
    case 'period':
      return from && to ? { label: tr('render.date.period'), value: `${formatDate(from, lang)} – ${formatDate(to, lang)}` } : null;
  }
}

export function infoRows(ctx: Ctx): InfoRow[] {
  const { model, lang, tr } = ctx;
  const rows: InfoRow[] = [];
  rows.push({ label: tr(`render.no.${model.type}` as TranslationKey), value: model.number ?? tr('render.draft') });
  rows.push({ label: tr('render.date.issue'), value: formatDate(model.issueDate, lang) });
  const service = serviceText(ctx);
  if (service) rows.push(service);
  if (model.type === 'invoice' && model.dueDate) rows.push({ label: tr('render.date.due'), value: formatDate(model.dueDate, lang) });
  if (model.type === 'quote' && model.validUntil) rows.push({ label: tr('render.date.validUntil'), value: formatDate(model.validUntil, lang) });
  if (model.source) {
    const key = model.source.type === 'quote' ? 'render.source.quote' : 'render.source.invoice';
    const ref = joinParts([model.source.number, model.source.issueDate ? `(${formatDate(model.source.issueDate, lang)})` : ''], ' ');
    rows.push({ label: tr(key), value: ref });
  }
  if (clean(model.reference)) rows.push({ label: tr('render.reference'), value: clean(model.reference) });
  if (clean(model.buyerReference)) rows.push({ label: tr('render.buyerReference'), value: clean(model.buyerReference) });
  if (model.client && clean(model.client.vatId)) rows.push({ label: tr('render.client.vatId'), value: clean(model.client.vatId) });
  for (const f of model.customFields) if (clean(f.label) || clean(f.value)) rows.push({ label: clean(f.label), value: clean(f.value) });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

export function lineVatText(line: ModelLine, lang: Lang): string {
  return `${formatPercent(line.category === 'S' ? line.rateBp : 0, lang)} %`;
}

export type LineCells = { pos: string; name: string; description: string; discount: string; qty: string; price: string; vat: string; amount: string };

export function lineCells(ctx: Ctx, line: ModelLine): LineCells {
  const { lang, tr } = ctx;
  let discount = '';
  if (line.discount.kind === 'percent' && line.discount.value !== 0) {
    discount = tr('render.discount.line', { value: `${formatPercent(line.discount.value, lang)} %` });
  } else if (line.discount.kind === 'amount' && line.discount.value !== 0) {
    discount = tr('render.discount.line', { value: fmtMoney(ctx, line.discount.value) });
  }
  return {
    pos: String(line.position),
    name: clean(line.name),
    description: clean(line.description),
    discount,
    qty: `${formatQty(line.qtyMilli, lang)} ${unitLabel(ctx, line.unitCode)}`,
    price: formatPrice(line.priceE4, lang),
    vat: lineVatText(line, lang),
    amount: formatAmount(line.net, lang),
  };
}

// ---------------------------------------------------------------------------------------------
// Totals, VAT summary
// ---------------------------------------------------------------------------------------------

export type TotalsRow = { kind: 'plain' | 'strong' | 'muted'; label: string; value: string };

export function totalsRows(ctx: Ctx): TotalsRow[] {
  const { model, lang, tr } = ctx;
  const t = model.totals;
  const rows: TotalsRow[] = [];
  const money = (c: number) => fmtMoney(ctx, c);
  const net = !model.pricesIncludeVat;
  const hasDiscount = t.discount !== 0;
  if (hasDiscount) {
    rows.push({ kind: 'plain', label: tr('render.total.subtotal'), value: money(t.lineTotal) });
    const label =
      model.discount.kind === 'percent' ? tr('render.total.discountPct', { pct: formatPercent(model.discount.value, lang) }) : tr('render.total.discount');
    rows.push({ kind: 'plain', label, value: money(-t.discount) });
  }
  if (ctx.showVat) {
    if (net) {
      if (hasDiscount || t.groups.some((g) => g.category === 'S')) rows.push({ kind: 'plain', label: tr('render.total.net'), value: money(t.net) });
      for (const g of printedGroups(ctx)) {
        if (g.category === 'S') {
          rows.push({ kind: 'muted', label: tr('render.total.vatOn', { rate: formatPercent(g.rateBp, lang), base: money(g.taxable) }), value: money(g.tax) });
        }
      }
    }
  }
  const grossLabel = model.type === 'receipt' && model.receiptKind === 'payment' ? tr('render.total.received') : tr('render.total.gross');
  rows.push({ kind: 'strong', label: grossLabel, value: money(t.gross) });
  if (ctx.showVat && !net) {
    for (const g of printedGroups(ctx)) {
      if (g.category === 'S') {
        rows.push({ kind: 'muted', label: tr('render.total.vatIncluded', { rate: formatPercent(g.rateBp, lang), base: money(g.taxable) }), value: money(g.tax) });
      }
    }
  }
  if (model.type === 'invoice' && ctx.paid !== 0) {
    // Payment status of this copy, dated by the latest payment (review #13): the copy is not the PDF as issued.
    const last = ctx.payments.map((p) => p.date).filter(Boolean).sort().at(-1);
    const paidLabel = last ? tr('render.total.paidOn', { date: formatDate(last, lang) }) : tr('render.total.paid');
    rows.push({ kind: 'plain', label: paidLabel, value: money(-ctx.paid) });
    // An overpaid invoice says so, never "amount due -359,60 €" (review #13).
    if (ctx.balance < 0) rows.push({ kind: 'strong', label: tr('render.total.overpaid'), value: money(-ctx.balance) });
    else rows.push({ kind: 'strong', label: tr('render.total.balance'), value: money(ctx.balance) });
  }
  return rows;
}

export function vatGroupLabel(ctx: Pick<Ctx, 'tr' | 'lang'>, category: TaxCategory, rateBp: number): string {
  if (category === 'S') return ctx.tr('render.vat.rate', { rate: formatPercent(rateBp, ctx.lang) });
  return ctx.tr(`render.vat.${category}` as TranslationKey);
}

/** Tax groups with an amount; a group reduced to 0 (100 % line discount) prints no row (review #19). */
export function printedGroups(ctx: Pick<Ctx, 'model'>): GroupTotals[] {
  return ctx.model.totals.groups.filter((g) => g.amount !== 0 || g.taxable !== 0 || g.tax !== 0);
}

/** The VAT summary table is shown when there is more than one tax group or a group without VAT. Not in §19 mode without VAT. */
export function showVatSummary(ctx: Ctx): boolean {
  if (!ctx.showVat) return false;
  const groups = printedGroups(ctx);
  return groups.length > 1 || groups.some((g) => g.category !== 'S' || g.tax === 0);
}

// ---------------------------------------------------------------------------------------------
// Payment block and GiroCode
// ---------------------------------------------------------------------------------------------

/** The GiroCode payload of an invoice (the engine's EPC payload), or null when the rules say no code (D26). */
export function giroPayload(model: RenderModel, balance: number): string | null {
  if (model.type !== 'invoice' || !model.layout.showGirocode || model.currency !== 'EUR' || balance < 1) return null;
  const b = model.business;
  if (!clean(b.iban)) return null;
  const result = buildEpcPayload({
    name: clean(b.accountHolder) || clean(b.name),
    iban: b.iban,
    bic: clean(b.bic) || undefined,
    amountCents: balance,
    currency: model.currency,
    remittance: remittanceText(model.number ?? '', model.client?.name ?? ''),
  });
  return result.ok ? result.payload : null;
}

export type PaymentBlock = {
  headline: string;
  textLines: string[];
  bankLines: InfoRow[];
  paymentText: string;
  deposit: string;
  qr: string | null;
};

export function paymentBlock(ctx: Ctx): PaymentBlock | null {
  const { model, tr, lang } = ctx;
  if (model.type !== 'invoice') return null;
  const b = model.business;
  const owing = ctx.balance > 0;
  const bankLines: InfoRow[] = [];
  if (owing) {
    if (clean(b.accountHolder)) bankLines.push({ label: tr('render.accountHolder'), value: clean(b.accountHolder) });
    if (clean(b.bankName)) bankLines.push({ label: tr('render.bank'), value: clean(b.bankName) });
    if (clean(b.iban)) bankLines.push({ label: tr('render.iban'), value: clean(b.iban) });
    if (clean(b.bic)) bankLines.push({ label: tr('render.bic'), value: clean(b.bic) });
    if (bankLines.length && model.number) bankLines.push({ label: tr('render.payment.reference'), value: model.number });
  }
  const headline = owing
    ? model.dueDate
      ? tr('render.payment.due', { amount: fmtMoney(ctx, ctx.balance), date: formatDate(model.dueDate, lang) })
      : tr('render.payment.dueNoDate', { amount: fmtMoney(ctx, ctx.balance) })
    : '';
  const deposit = model.depositCents && model.depositCents > 0 ? `${tr('render.total.deposit')}: ${fmtMoney(ctx, model.depositCents)}` : '';
  const paymentText = clean(model.texts.paymentText);
  const epc = giroPayload(model, ctx.balance);
  if (!headline && !bankLines.length && !paymentText && !deposit && !epc) return null;
  return { headline, textLines: [], bankLines, paymentText, deposit, qr: epc };
}

// ---------------------------------------------------------------------------------------------
// "Not an e-invoice" note (v1.1 D88, review #10)
// ---------------------------------------------------------------------------------------------

/**
 * Domestic B2B invoices (and their Storno) above 250 € will have to be e-invoices from 2027/2028 (§ 27 Abs. 38 UStG,
 * BMF FAQ March 2026); a PDF is not one (§ 14 Abs. 1 Satz 3 UStG). The footer says so on exactly those documents:
 * German business to a business client in Germany, not §19 (exempt), not a small amount (§ 33 UStDV). Documents
 * issued before renderer 4 keep their footer as it was.
 */
export function einvoiceNote(ctx: Pick<Ctx, 'model' | 'tr'>): string | null {
  const m = ctx.model;
  if ((m.rendererVersion ?? 0) < 4 || (m.type !== 'invoice' && m.type !== 'cancellation')) return null;
  if (m.business.vatMode === 'small_business' || (clean(m.business.countryCode).toUpperCase() || 'DE') !== 'DE') return null;
  if (!m.client || m.client.kind !== 'business' || (clean(m.client.countryCode).toUpperCase() || 'DE') !== 'DE') return null;
  if (Math.abs(m.totals.gross) <= 25_000) return null;
  return ctx.tr('render.einvoiceNote');
}

/** The last footer line: the e-invoice note (if any) and "Seite n von m". */
export function pageLine(ctx: Pick<Ctx, 'model' | 'tr'>, page: number, pages: number): string {
  const note = einvoiceNote(ctx);
  const pageText = ctx.tr('render.page', { n: page, m: pages });
  return note ? `${note} · ${pageText}` : pageText;
}

// ---------------------------------------------------------------------------------------------
// Footer columns (page 1 and every page)
// ---------------------------------------------------------------------------------------------

export function footerColumns(ctx: Ctx): string[][] {
  const b = ctx.model.business;
  const { tr } = ctx;
  const cols: string[][] = [
    [clean(b.email), clean(b.phone), clean(b.website)].filter(Boolean),
    [clean(b.taxNumber) ? `${tr('render.taxNumber')}: ${clean(b.taxNumber)}` : '', clean(b.vatId) ? `${tr('render.vatId')}: ${clean(b.vatId)}` : ''].filter(Boolean),
    [
      clean(b.bankName),
      clean(b.iban) ? `${tr('render.iban')}: ${clean(b.iban)}` : '',
      clean(b.bic) ? `${tr('render.bic')}: ${clean(b.bic)}` : '',
      clean(b.accountHolder) && clean(b.accountHolder) !== clean(b.name) ? clean(b.accountHolder) : '',
    ].filter(Boolean),
  ];
  return cols.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Text metrics: a deliberately conservative width estimate for Inter (no font files at test time)
// ---------------------------------------------------------------------------------------------

/** Safety factor on every width estimate (V1_PLAN: "conservative +10 %"). */
export const WIDTH_SAFETY = 1.1;

const NARROW = " ijl.,:;'!|`";
const HALF = 'ftr()[]{}-/\\"1I*';

/** Estimated advance width of one character in em (Inter averages: lower case ≈ 0.56, digits ≈ 0.60, capitals ≈ 0.68). */
export function charWidthEm(ch: string): number {
  if (NARROW.includes(ch)) return 0.27;
  if (HALF.includes(ch)) return 0.4;
  if (ch === 'm' || ch === 'w') return 0.86;
  if ('MW@%&'.includes(ch)) return 0.9;
  if (ch >= '0' && ch <= '9') return 0.6;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  if (ch >= 'a' && ch <= 'z') return 0.56;
  if (isWide(ch)) return 1.0; // CJK, full-width forms, emoji: a full em (fallback fonts), review #13
  return 0.64;
}

function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji and pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension B…
  );
}

export function textWidth(text: string, fontPx: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charWidthEm(ch);
  return em * fontPx * (bold ? 1.06 : 1) * WIDTH_SAFETY;
}

/** Number of lines `text` takes in a box `widthPx` wide (greedy word wrap, over-long words break by character). */
export function wrapLineCount(text: string, widthPx: number, fontPx: number, bold = false): number {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  let total = 0;
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      total += 1;
      continue;
    }
    let lines = 1;
    let used = 0;
    const space = textWidth(' ', fontPx, bold);
    for (const word of words) {
      const w = textWidth(word, fontPx, bold);
      if (w > widthPx) {
        // an over-long word breaks over several lines (CSS overflow-wrap: anywhere)
        if (used > 0) lines++;
        const chunks = Math.ceil(w / widthPx);
        lines += chunks - 1;
        used = Math.max(0, w - (chunks - 1) * widthPx);
        continue;
      }
      if (used === 0) used = w;
      else if (used + space + w <= widthPx) used += space + w;
      else {
        lines++;
        used = w;
      }
    }
    total += lines;
  }
  return total;
}

