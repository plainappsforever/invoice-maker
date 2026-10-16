// Draft editing used by the UI (P4): every function is ONE write-queue unit (D50) that keeps the cached totals
// right, so the editor never has to remember to recompute. Rules that cross tables live here: choosing a client
// copies its defaults, changing the treatment or the business's §19 mode converts the lines of drafts (never of
// issued documents, SPEC §10), a legal note the user has not changed follows the treatment.
import type { Lang } from '@/engine/money';
import { roundDiv } from '@/engine/money';
import { defaultLegalNote, LEGACY_NOTE_TEXTS, LEGAL_NOTES, NOTE_IDS } from '@/engine/notes';
import type { DiscountKind } from '@/engine/totals';
import { lineTax, treatmentCategory, type Treatment, type VatMode } from '@/engine/treatment';

import { getBusiness, listTaxRates, updateBusiness } from './business';
import { getClient } from './clients';
import { getDocument, refreshDraftTotals, updateDraft, type Document, type DraftPatch } from './documents';
import { getCatalogItem } from './items';
import { addLine, deleteLine, listLines, reorderLines, updateLine } from './lines';
import { clientDefaults, defaultTexts, invoiceNote } from './lifecycle';
import { queued } from './transaction';
import type { Db } from './types';

const LANGS: readonly Lang[] = ['de', 'en'];

async function mustDraft(db: Db, id: number): Promise<Document> {
  const doc = await getDocument(db, id);
  if (!doc) throw new Error(`document ${id} not found`);
  return doc;
}

/** True when a legal note is empty or still one of the app's own texts (so a treatment change may replace it). */
export function isStockNote(text: string): boolean {
  const note = text.trim();
  return note === '' || LEGACY_NOTE_TEXTS.includes(note) || NOTE_IDS.some((id) => LANGS.some((lang) => LEGAL_NOTES[id].text[lang].trim() === note));
}

/** Fields whose change alters the totals. */
const TOTALS_FIELDS: (keyof DraftPatch)[] = ['discountKind', 'discountValue', 'pricesIncludeVat', 'treatment'];

/** Updates draft fields; recomputes the cached totals when a field that matters for them changed. */
export const patchDraft = queued(async (db: Db, id: number, patch: DraftPatch, now: number = Date.now()): Promise<void> => {
  await updateDraft(db, id, patch, now);
  if (TOTALS_FIELDS.some((f) => f in patch)) await refreshDraftTotals(db, id, now);
});

/** Lines that show VAT or a category the treatment does not allow are converted (D51 one-tap logic, applied early). */
async function convertLines(db: Db, doc: Document, treatment: Treatment, mode: VatMode) {
  const forced = treatmentCategory(treatment, mode);
  const defaultRate = (await listTaxRates(db)).find((r) => r.isDefault)?.rateBp ?? 1900;
  for (const line of await listLines(db, doc.id)) {
    let target: { category: typeof line.taxCategory; rateBp: number } | null = null;
    if (forced) {
      if (line.taxCategory !== forced || line.taxRateBp !== 0) target = { category: forced, rateBp: 0 };
    } else if (['AE', 'K', 'G', 'E', 'O'].includes(line.taxCategory)) {
      target = lineTax(treatment, mode, defaultRate); // back to a normal VAT line at the default rate
    }
    if (target) await updateLine(db, line.id, { taxCategory: target.category, taxRateBp: target.rateBp });
  }
}

async function applyTreatment(db: Db, doc: Document, treatment: Treatment, mode: VatMode, oldTreatment: Treatment, oldMode: VatMode, now: number) {
  const patch: DraftPatch = { treatment };
  if (isStockNote(doc.legalNote) || doc.legalNote === defaultLegalNote(oldTreatment, oldMode, doc.language)) {
    const client = doc.clientId ? await getClient(db, doc.clientId) : null;
    const note = defaultLegalNote(treatment, mode, doc.language);
    patch.legalNote = doc.type === 'invoice' ? await invoiceNote(db, client, note, doc.language) : note;
  }
  await updateDraft(db, doc.id, patch, now);
  await convertLines(db, doc, treatment, mode);
  await refreshDraftTotals(db, doc.id, now);
}

/** The treatment of a draft (VAT category of its lines, legal note) — D21. */
export const setDraftTreatment = queued(async (db: Db, id: number, treatment: Treatment, now: number = Date.now()): Promise<void> => {
  const doc = await mustDraft(db, id);
  const business = await getBusiness(db);
  await applyTreatment(db, doc, treatment, business.vatMode, doc.treatment, business.vatMode, now);
});

/**
 * Chooses (or clears) the client of a draft and takes over its defaults (SPEC flow 2): language, currency,
 * treatment, payment days, buyer reference. Texts that are still the stock defaults of the old language follow the
 * new language.
 */
export const setDraftClient = queued(async (db: Db, id: number, clientId: number | null, now: number = Date.now()): Promise<void> => {
  const doc = await mustDraft(db, id);
  const business = await getBusiness(db);
  const client = clientId ? await getClient(db, clientId) : null;
  const d = clientDefaults(business, client);
  const patch: DraftPatch = {
    clientId: client?.id ?? null,
    buyerReference: client?.buyerReference ?? '',
    language: d.language,
    currency: d.currency,
  };
  if (doc.type === 'invoice') patch.paymentDays = d.paymentDays;
  if (d.language !== doc.language) {
    const before = await defaultTexts(db, doc.language, doc.type);
    const after = await defaultTexts(db, d.language, doc.type);
    if (doc.intro === before.intro) patch.intro = after.intro;
    if (doc.notes === before.notes) patch.notes = after.notes;
    if (doc.paymentText === before.paymentText) patch.paymentText = after.paymentText;
    if (doc.footer === before.footer) patch.footer = after.footer;
  }
  await updateDraft(db, id, patch, now);
  const updated = await mustDraft(db, id);
  await applyTreatment(db, updated, d.treatment, business.vatMode, doc.treatment, business.vatMode, now);
});

/**
 * Switches the business between standard VAT and small business (§ 19 UStG). Drafts follow (lines, stock legal
 * note); issued documents never change (SPEC §10) — their snapshot keeps the old mode.
 */
export const setVatMode = queued(async (db: Db, mode: VatMode, now: number = Date.now()): Promise<void> => {
  const before = (await getBusiness(db)).vatMode;
  if (before === mode) return;
  await updateBusiness(db, { vatMode: mode }, now);
  const drafts = await db.getAllAsync<{ id: number }>("SELECT id FROM documents WHERE status = 'draft' ORDER BY id");
  for (const { id } of drafts) {
    const doc = await mustDraft(db, id);
    await applyTreatment(db, doc, doc.treatment, mode, doc.treatment, before, now);
  }
});

export type LineForm = {
  name: string;
  description: string;
  qtyMilli: number;
  unitCode: string;
  priceE4: number;
  /** The rate the user picked; the treatment decides the category (a no-VAT treatment forces 0 %). */
  rateBp: number;
  discountKind: DiscountKind;
  discountValue: number;
  catalogItemId?: number | null;
  /** Item photo (V1.5 P1); undefined = unchanged. */
  imageFile?: string | null;
};

/** Adds (lineId null) or changes a line of a draft and refreshes the totals. */
export const saveDraftLine = queued(async (db: Db, documentId: number, lineId: number | null, form: LineForm, now: number = Date.now()): Promise<number> => {
  const doc = await mustDraft(db, documentId);
  const business = await getBusiness(db);
  const tax = lineTax(doc.treatment, business.vatMode, form.rateBp);
  const fields = {
    name: form.name,
    description: form.description,
    qtyMilli: form.qtyMilli,
    unitCode: form.unitCode,
    priceE4: form.priceE4,
    taxCategory: tax.category,
    taxRateBp: tax.rateBp,
    discountKind: form.discountKind,
    discountValue: form.discountValue,
    ...(form.catalogItemId !== undefined ? { catalogItemId: form.catalogItemId } : {}),
    ...(form.imageFile !== undefined ? { imageFile: form.imageFile } : {}),
  };
  let id = lineId;
  if (id === null) id = await addLine(db, documentId, fields);
  else await updateLine(db, id, fields);
  await refreshDraftTotals(db, documentId, now);
  return id;
});

/** Adds a catalog item as a line (quantity 1); the price is converted when the item and the document disagree on gross/net. */
export const addCatalogLine = queued(async (db: Db, documentId: number, itemId: number, qtyMilli: number = 1000): Promise<number> => {
  const doc = await mustDraft(db, documentId);
  const item = await getCatalogItem(db, itemId);
  if (!item) throw new Error(`catalog item ${itemId} not found`);
  let price = item.priceE4;
  const rate = item.taxCategory === 'S' ? item.taxRateBp : 0;
  if (rate > 0 && item.priceIncludesVat && !doc.pricesIncludeVat) price = roundDiv(price * 10_000, 10_000 + rate);
  if (rate > 0 && !item.priceIncludesVat && doc.pricesIncludeVat) price = roundDiv(price * (10_000 + rate), 10_000);
  return saveDraftLine(db, documentId, null, {
    name: item.name,
    description: item.description,
    qtyMilli,
    unitCode: item.unitCode,
    priceE4: price,
    rateBp: item.taxCategory === 'S' || item.taxCategory === 'Z' ? item.taxRateBp : 0,
    discountKind: 'none',
    discountValue: 0,
    catalogItemId: item.id,
    imageFile: item.imageFile,
  });
});

export const deleteDraftLine = queued(async (db: Db, lineId: number, now: number = Date.now()): Promise<void> => {
  const row = await db.getFirstAsync<{ document_id: number }>('SELECT document_id FROM document_lines WHERE id = ?', lineId);
  if (!row) return;
  await deleteLine(db, lineId);
  await refreshDraftTotals(db, row.document_id, now);
});

/** Moves a line one place up (-1) or down (+1). */
export const moveDraftLine = queued(async (db: Db, documentId: number, lineId: number, direction: -1 | 1): Promise<void> => {
  const ids = (await listLines(db, documentId)).map((l) => l.id);
  const from = ids.indexOf(lineId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await reorderLines(db, documentId, ids);
});
