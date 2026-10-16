// The render model = the snapshot of an issued document (D20, V1_PLAN "Lifecycle"). PURE.
// Issue stores it as JSON in documents.snapshot; PDFs of issued documents are always rendered from it,
// drafts from live rows through the same builder. P3 renders it to HTML; it may add fields (bump
// RENDER_MODEL_VERSION and keep reading older snapshots).
import type { Lang } from '@/engine/money';
import { LEGAL_NOTES, noteIdFor, type LegalSource } from '@/engine/notes';
import type { DocumentType, Series } from '@/engine/numbering';
import type { ReceiptKind } from '@/engine/status';
import { computeTotals, type Discount, type DiscountKind, type GroupTotals, type TaxCategory } from '@/engine/totals';
import type { Treatment, VatMode } from '@/engine/treatment';

// 2 (V1.5 P1): optional business.signature, client.shipTo, lines[].imageFile, attachments. Version-1 snapshots lack
// them and render exactly as before.
export const RENDER_MODEL_VERSION = 2;
/** Version of the HTML templates that rendered a snapshot (P3 bumps it when templates change). */
export const RENDERER_VERSION = 5; // 3: P5 return-address line fits the window; 4: v1.1 "not an e-invoice" footer note (D88); 5: V1.5 P1 delivery address, item photos, signature, attachment pages

export type ModelBusiness = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  phone: string;
  website: string;
  taxNumber: string;
  vatId: string;
  iban: string;
  bic: string;
  bankName: string;
  accountHolder: string;
  logoFile: string | null;
  vatMode: VatMode;
  footer: string;
  /** Drawn signature (engine/signature.ts JSON), printed under the document (model 2). */
  signature?: string | null;
};

export type ModelAddress = { name: string; street: string; postalCode: string; city: string; countryCode: string };
/** A file printed as a page after the document (model 2). */
export type ModelAttachment = { file: string; name: string; width: number | null; height: number | null };

export type ModelClient = {
  kind: 'business' | 'person';
  name: string;
  contact: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  vatId: string;
  buyerReference: string;
  /** Delivery address when it differs (model 2). */
  shipTo?: ModelAddress | null;
};

export type ModelLine = {
  position: number;
  name: string;
  description: string;
  qtyMilli: number;
  unitCode: string;
  priceE4: number;
  category: TaxCategory;
  rateBp: number;
  discount: Discount;
  /** Cents, from the totals engine (SPEC §5 steps 1–2). */
  base: number;
  discountCents: number;
  net: number;
  /** Item photo printed next to the line (model 2). */
  imageFile?: string | null;
};

export type CustomField = { label: string; value: string };

export type RenderModel = {
  modelVersion: number;
  rendererVersion: number;
  type: DocumentType;
  receiptKind: ReceiptKind | null;
  series: Series | null;
  /** null for drafts (rendered as "Draft"/"Entwurf"). */
  number: string | null;
  language: Lang;
  currency: string;
  issueDate: string;
  serviceMode: 'same' | 'date' | 'period' | 'month' | 'none';
  serviceFrom: string | null;
  serviceTo: string | null;
  dueDate: string | null;
  validUntil: string | null;
  paymentDays: number | null;
  reference: string;
  buyerReference: string;
  pricesIncludeVat: boolean;
  treatment: Treatment;
  business: ModelBusiness;
  client: ModelClient | null;
  lines: ModelLine[];
  discount: Discount;
  /** Totals at Issue. Payments are live data (not frozen): paid/balance come from the payments table. */
  totals: { lineTotal: number; discount: number; net: number; tax: number; gross: number; groups: GroupTotals[] };
  texts: { intro: string; notes: string; paymentText: string; footer: string; legalNote: string };
  /** Sources of the treatment's legal note (shown in the app; P3 decides whether the PDF shows them). */
  legalSources: LegalSource[];
  customFields: CustomField[];
  layout: { template: string; accent: string; logoRight: boolean; paper: 'A4' | 'LETTER'; showGirocode: boolean };
  depositCents: number | null;
  /** The quote an invoice came from, the invoice a cancellation/payment receipt refers to. */
  source: { type: DocumentType; number: string | null; issueDate: string } | null;
  /** Photos printed as pages after the document, in order (model 2). */
  attachments?: ModelAttachment[];
};

export type ModelDocument = {
  type: DocumentType;
  receiptKind: ReceiptKind | null;
  issueDate: string;
  serviceMode: RenderModel['serviceMode'];
  serviceFrom: string | null;
  serviceTo: string | null;
  dueDate: string | null;
  validUntil: string | null;
  paymentDays: number | null;
  reference: string;
  buyerReference: string;
  currency: string;
  language: Lang;
  pricesIncludeVat: boolean;
  treatment: Treatment;
  discountKind: DiscountKind;
  discountValue: number;
  intro: string;
  notes: string;
  paymentText: string;
  footer: string;
  legalNote: string;
  customFields: string;
  template: string;
  accent: string;
  logoRight: boolean;
  paper: 'A4' | 'LETTER';
  showGirocode: boolean;
  depositCents: number | null;
};

export type ModelLineInput = {
  name: string;
  description: string;
  qtyMilli: number;
  unitCode: string;
  priceE4: number;
  taxCategory: TaxCategory;
  taxRateBp: number;
  discountKind: DiscountKind;
  discountValue: number;
  imageFile?: string | null;
};

export type ModelInput = {
  doc: ModelDocument;
  number: string | null;
  series: Series | null;
  /** Due date as it will be frozen (Issue fills issue date + payment days). */
  dueDate?: string | null;
  business: ModelBusiness;
  client: ClientLike | null;
  lines: ModelLineInput[];
  source: RenderModel['source'];
  attachments?: ModelAttachment[];
};

/** The client as the database row has it (flat ship* fields) or as a snapshot has it (shipTo). */
export type ClientLike = ModelClient & Partial<{ shipName: string; shipStreet: string; shipPostalCode: string; shipCity: string; shipCountryCode: string }>;

/** Parses the custom-field JSON defensively: at most 5 {label, value} string pairs. */
export function parseCustomFields(json: string): CustomField[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f): f is CustomField => typeof f?.label === 'string' && typeof f?.value === 'string')
      .slice(0, 5)
      .map((f) => ({ label: f.label, value: f.value }));
  } catch {
    return [];
  }
}

function pickBusiness(b: ModelBusiness): ModelBusiness {
  const { name, street, postalCode, city, countryCode, email, phone, website, taxNumber, vatId, iban, bic, bankName,
    accountHolder, logoFile, vatMode, footer } = b;
  return { name, street, postalCode, city, countryCode, email, phone, website, taxNumber, vatId, iban, bic, bankName,
    accountHolder, logoFile, vatMode, footer, signature: b.signature ?? null };
}

function pickClient(c: ClientLike | null): ModelClient | null {
  if (!c) return null;
  const { kind, name, contact, street, postalCode, city, countryCode, email, vatId, buyerReference } = c;
  const ship: ModelAddress | null = c.shipTo !== undefined
    ? c.shipTo
    : { name: c.shipName ?? '', street: c.shipStreet ?? '', postalCode: c.shipPostalCode ?? '', city: c.shipCity ?? '', countryCode: c.shipCountryCode ?? '' };
  const hasShip = !!ship && [ship.street, ship.postalCode, ship.city].some((v) => v.trim() !== '');
  return { kind, name, contact, street, postalCode, city, countryCode, email, vatId, buyerReference, shipTo: hasShip ? ship : null };
}

export function buildRenderModel(input: ModelInput): RenderModel {
  const { doc } = input;
  const totalsLines = input.lines.map((l) => ({
    qtyMilli: l.qtyMilli,
    priceE4: l.priceE4,
    category: l.taxCategory,
    rateBp: l.taxRateBp,
    discount: { kind: l.discountKind, value: l.discountValue },
  }));
  const discount = { kind: doc.discountKind, value: doc.discountValue };
  const totals = computeTotals({ lines: totalsLines, pricesIncludeVat: doc.pricesIncludeVat, discount, payments: [] });
  const noteId = noteIdFor(doc.treatment, input.business.vatMode);
  return {
    modelVersion: RENDER_MODEL_VERSION,
    rendererVersion: RENDERER_VERSION,
    type: doc.type,
    receiptKind: doc.receiptKind,
    series: input.series,
    number: input.number,
    language: doc.language,
    currency: doc.currency,
    issueDate: doc.issueDate,
    serviceMode: doc.serviceMode,
    serviceFrom: doc.serviceFrom,
    serviceTo: doc.serviceTo,
    dueDate: input.dueDate === undefined ? doc.dueDate : input.dueDate,
    validUntil: doc.validUntil,
    paymentDays: doc.paymentDays,
    reference: doc.reference,
    buyerReference: doc.buyerReference,
    pricesIncludeVat: doc.pricesIncludeVat,
    treatment: doc.treatment,
    business: pickBusiness(input.business),
    client: pickClient(input.client),
    lines: input.lines.map((l, i) => ({
      position: i + 1,
      name: l.name,
      description: l.description,
      qtyMilli: l.qtyMilli,
      unitCode: l.unitCode,
      priceE4: l.priceE4,
      category: l.taxCategory,
      rateBp: l.taxRateBp,
      discount: { kind: l.discountKind, value: l.discountValue },
      base: totals.lines[i].base,
      discountCents: totals.lines[i].discount,
      net: totals.lines[i].net,
      imageFile: l.imageFile ?? null,
    })),
    discount,
    totals: {
      lineTotal: totals.lineTotal,
      discount: totals.discount,
      net: totals.net,
      tax: totals.tax,
      gross: totals.gross,
      groups: totals.groups,
    },
    texts: { intro: doc.intro, notes: doc.notes, paymentText: doc.paymentText, footer: doc.footer, legalNote: doc.legalNote },
    legalSources: noteId ? LEGAL_NOTES[noteId].sources : [],
    customFields: parseCustomFields(doc.customFields),
    layout: { template: doc.template, accent: doc.accent, logoRight: doc.logoRight, paper: doc.paper, showGirocode: doc.showGirocode },
    depositCents: doc.depositCents,
    source: input.source,
    attachments: input.attachments ?? [],
  };
}
