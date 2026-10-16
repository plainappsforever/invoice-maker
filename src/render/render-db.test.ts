/**
 * @jest-environment node
 */
// Rendering of documents made by the real lifecycle (database → snapshot → HTML): the legal notes come out of
// Issue exactly as the rules say, payments change the GiroCode, and an issued document renders the same after
// the business or the client is edited.
import { prng } from '@/engine/__fixtures__/generated';
import { LEGAL_NOTES, defaultLegalNote } from '@/engine/notes';
import { updateBusiness } from '@/db/business';
import { createClient, updateClient } from '@/db/clients';
import { updateDraft } from '@/db/documents';
import { cancelInvoice, createPaymentReceipt, issueDocument, IssueBlockedError, newDraft, removeLineVat, renderModelFor } from '@/db/lifecycle';
import { getCounter } from '@/db/counters';
import { addLine, listLines } from '@/db/lines';
import { addPayment, listPayments } from '@/db/payments';
import { seededDb, emptyDb, NOW } from '@/data/test-data';
import { buildCtx, paginate, renderHtml, TEMPLATE_IDS } from '@/render/html';
import { longInvoiceModel } from '@/render/test-models';

const clock = (today: string) => ({ today, now: NOW });
const opts = { embedFonts: false } as const;

function text(html: string): string {
  return html
    .slice(html.indexOf('<body'))
    .replace(/<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

async function setup(business: Parameters<typeof updateBusiness>[1] = {}) {
  const db = await emptyDb();
  await updateBusiness(db, { name: 'Muster', street: 'Weg 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890', iban: 'DE89370400440532013000', ...business }, NOW);
  return db;
}

async function issued(db: Awaited<ReturnType<typeof setup>>, clientId: number | null, over: Parameters<typeof updateDraft>[2] = {}) {
  const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
  await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 });
  if (Object.keys(over).length) await updateDraft(db, id, over, NOW);
  await issueDocument(db, id, clock('2026-10-01'));
  return id;
}

describe('legal notes through Issue (A4: DE and EN)', () => {
  it('§19 small business: the note is on the issued invoice, no VAT shown, still there after the mode is switched back', async () => {
    const db = await setup({ vatMode: 'small_business' });
    const clientId = await createClient(db, { name: 'Kunde', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxCategory: 'E', taxRateBp: 0 });
    await issueDocument(db, id, clock('2026-10-01'));
    const html = renderHtml(await renderModelFor(db, id), opts);
    expect(text(html)).toContain(LEGAL_NOTES.small_business.text.de);
    expect(text(html)).toContain('Gesamtbetrag 100,00 €');
    expect(html).not.toContain('data-vat-summary');
    await updateBusiness(db, { vatMode: 'standard' }, NOW + 1);
    expect(renderHtml(await renderModelFor(db, id), opts)).toBe(html); // the snapshot is what prints
  });
  it('reverse charge client (EN): the English note with the German phrase, VAT 0, VAT ids shown', async () => {
    const db = await setup({ vatId: 'DE123456789' });
    const clientId = await createClient(db, { name: 'Acme BV', countryCode: 'NL', vatId: 'NL123456789B01', treatment: 'reverse_charge', language: 'en', street: 'K 1', postalCode: '1015', city: 'Amsterdam' }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Consulting', qtyMilli: 1000, priceE4: 20_000_000, taxCategory: 'AE', taxRateBp: 0 });
    await issueDocument(db, id, clock('2026-10-01'));
    const t = text(renderHtml(await renderModelFor(db, id), opts));
    expect(t).toContain(LEGAL_NOTES.reverse_charge.text.en);
    expect(t).toContain('Steuerschuldnerschaft des Leistungsempfängers');
    expect(t).toContain('NL123456789B01');
    expect(t).toContain('DE123456789');
    expect(t).toContain('€2,000.00');
  });
  it.each(['intra_eu_goods', 'export', 'exempt'] as const)('%s: its note appears; a standard invoice of the same business has none', async (treatment) => {
    const db = await setup();
    const clientId = await createClient(db, { name: 'Kunde', treatment, street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Ware', qtyMilli: 1000, priceE4: 1_000_000, taxCategory: treatment === 'intra_eu_goods' ? 'K' : treatment === 'export' ? 'G' : 'E', taxRateBp: 0 });
    if (treatment === 'exempt') await updateDraft(db, id, { legalNote: 'Umsatzsteuerfrei: § 4 Nr. 8 UStG' }, NOW);
    await issueDocument(db, id, clock('2026-10-01'));
    const t = text(renderHtml(await renderModelFor(db, id), opts));
    expect(t).toContain(treatment === 'exempt' ? 'Umsatzsteuerfrei: § 4 Nr. 8 UStG' : defaultLegalNote(treatment, 'standard', 'de'));
    const plain = text(renderHtml(await renderModelFor(db, await issued(db, null)), opts));
    for (const note of Object.values(LEGAL_NOTES)) expect(plain).not.toContain(note.text.de);
  });
  it('a draft is rendered from live rows ("Entwurf"), an issued document from its snapshot', async () => {
    const db = await setup();
    const id = await newDraft(db, { type: 'invoice', clientId: null, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 });
    expect(text(renderHtml(await renderModelFor(db, id), opts))).toContain('Rechnung – Entwurf');
    await issueDocument(db, id, clock('2026-10-01'));
    expect(text(renderHtml(await renderModelFor(db, id), opts))).toContain('Rechnung RE-2026-0001');
  });
});

describe('payments and the GiroCode', () => {
  it('the QR amount follows the balance; a paid invoice has no QR and no bank block', async () => {
    const db = await setup();
    const id = await issued(db, null);
    const model = await renderModelFor(db, id);
    const html0 = renderHtml(model, { ...opts, payments: await listPayments(db, id) });
    expect(html0).toContain('<svg class="girocode"');
    await addPayment(db, id, { date: '2026-10-05', amountCents: 5_000 }, NOW);
    const half = renderHtml(model, { ...opts, payments: await listPayments(db, id) });
    expect(half).toContain('<svg class="girocode"');
    expect(half).not.toBe(html0);
    expect(text(half)).toContain('Noch zu zahlen 69,00 €');
    await addPayment(db, id, { date: '2026-10-06', amountCents: 6_900 }, NOW);
    const paid = renderHtml(model, { ...opts, payments: await listPayments(db, id) });
    expect(paid).not.toContain('<svg class="girocode"');
    expect(text(paid)).not.toContain('Bitte überweisen');
  });
});

describe('issued documents are stable', () => {
  it('editing the business or the client afterwards does not change the rendered invoice', async () => {
    const { db, ids } = await seededDb();
    const render = async (id: number) => renderHtml(await renderModelFor(db, id), { ...opts, template: 'modern' });
    const before = await Promise.all([ids.inv1, ids.inv2, ids.inv4].map(render));
    await updateBusiness(db, { name: 'Ganz anders', iban: '', city: 'München' }, NOW + 5);
    await updateClient(db, ids.kunde, { name: 'Umbenannt AG', city: 'Köln' }, NOW + 5);
    expect(await Promise.all([ids.inv1, ids.inv2, ids.inv4].map(render))).toEqual(before);
  });
  it('every seeded document renders in every template and paper; page counts agree', async () => {
    const { db } = await seededDb();
    const all = await db.getAllAsync<{ id: number }>('SELECT id FROM documents ORDER BY id');
    for (const { id } of all) {
      const model = await renderModelFor(db, id);
      for (const template of TEMPLATE_IDS) {
        for (const paper of ['A4', 'LETTER'] as const) {
          const html = renderHtml(model, { ...opts, template, paper });
          const pages = html.split('<section class="page"').length - 1;
          expect(html).toContain(`data-pages="${pages}"`);
          expect(pages).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
  it('the cancellation renders without GiroCode and with negative totals', async () => {
    const { db, ids } = await seededDb();
    const html = renderHtml(await renderModelFor(db, ids.cancellation), opts);
    expect(html).not.toContain('<svg class="girocode"');
    expect(text(html)).toContain('Cancellation invoice RE-2026-0003'); // the client's language (English)
    expect(text(html)).toContain('-€2,000.00');
  });
});

describe('Storno and receipts use the invoice as it was issued (v1.1 D80, review #3)', () => {
  it('review #3 probe: client renamed/moved and business changed between Issue and Storno → the Storno prints the invoice\'s parties', async () => {
    const db = await setup({ name: 'Muster Design', street: 'Musterstr. 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890' });
    const clientId = await createClient(db, { name: 'Müller GmbH', street: 'Hauptstr. 5', postalCode: '20095', city: 'Hamburg' }, NOW);
    const id = await issued(db, clientId);
    await updateClient(db, clientId, { name: 'Neue Firma AG', street: 'Andere Str. 9', postalCode: '80331', city: 'München' }, NOW + 1);
    await updateBusiness(db, { name: 'Muster Design NEU', street: 'Neuer Weg 2', taxNumber: '99/999/99999' }, NOW + 1);
    const { cancellationId } = await cancelInvoice(db, id, clock('2026-10-02'));
    const invoice = await renderModelFor(db, id);
    const storno = await renderModelFor(db, cancellationId);
    expect(storno.client).toEqual(invoice.client);
    expect(storno.business).toEqual(invoice.business);
    const t = text(renderHtml(storno, opts));
    expect(t).toContain('Müller GmbH');
    expect(t).toContain('Hauptstr. 5');
    expect(t).toContain('12/345/67890');
    expect(t).not.toMatch(/Neue Firma|Andere Str|München|NEU|Neuer Weg|99\/999/);
  });
  it('a payment receipt is addressed to the invoice\'s recipient, not the renamed client', async () => {
    const db = await setup();
    const clientId = await createClient(db, { name: 'Müller GmbH', street: 'Hauptstr. 5', postalCode: '20095', city: 'Hamburg' }, NOW);
    const id = await issued(db, clientId);
    await addPayment(db, id, { date: '2026-10-02', amountCents: 5_000 }, NOW);
    await updateClient(db, clientId, { name: 'Neue Firma AG' }, NOW + 1);
    const receiptId = await createPaymentReceipt(db, id, { today: '2026-10-02', now: NOW });
    await issueDocument(db, receiptId, clock('2026-10-02'));
    expect((await renderModelFor(db, receiptId)).client?.name).toBe('Müller GmbH');
  });
});

describe('pagination invariants (randomised, 300 invoices)', () => {
  it('every line exactly once in order; a page is never over capacity unless one item alone is taller than a page', () => {
    const rng = prng(20261001);
    for (let n = 0; n < 300; n++) {
      const count = rng.int(1, 120);
      const model = longInvoiceModel(count, { template: rng.pick(['classic', 'modern', 'compact']), paper: rng.pick(['A4', 'LETTER']) }, rng.int(0, 1) === 1);
      model.lines.forEach((line) => {
        if (rng.int(0, 5) === 0) line.description = 'Beschreibung '.repeat(rng.int(1, 40));
        if (rng.int(0, 9) === 0) line.name = 'Langername'.repeat(rng.int(1, 12));
        if (rng.int(0, 15) === 0) line.description = 'x'.repeat(rng.int(100, 900));
      });
      if (rng.int(0, 3) === 0) model.texts.notes = 'Notiz '.repeat(rng.int(1, 120));
      if (rng.int(0, 3) === 0) model.texts.intro = 'Einleitung '.repeat(rng.int(1, 60));
      if (rng.int(0, 3) === 0) model.texts.legalNote = 'Hinweis '.repeat(rng.int(1, 60));
      const ctx = buildCtx(model, {});
      const plan = paginate(ctx);
      expect(plan.flatMap((p) => p.rows)).toEqual(model.lines.map((_, i) => i));
      plan.forEach((p, i) => {
        expect(p.index).toBe(i);
        const items = p.rows.length + p.blocks.length + (p.intro ? 1 : 0);
        if (p.usedPx > p.capacityPx) expect(items).toBe(1);
        expect(p.carryIn).toBe(p.rows.length > 0 && p.rows[0] > 0);
        expect(p.carryOut).toBe(p.rows.length > 0 && p.rows[p.rows.length - 1] < count - 1);
      });
      expect(plan.flatMap((p) => p.blocks)).toContain('totals');
      expect(plan.flatMap((p) => p.blocks).filter((b) => b === 'totals')).toHaveLength(1);
      // the totals block comes after the last row
      const lastRowPage = plan.findIndex((p) => p.rows.includes(count - 1));
      const totalsPage = plan.findIndex((p) => p.blocks.includes('totals'));
      expect(totalsPage).toBeGreaterThanOrEqual(lastRowPage);
    }
  });
});

describe('§19 small business and VAT (P3.5 F2, D51, review #2 and #6)', () => {
  const sb19 = async () => {
    const db = await setup({ vatMode: 'small_business' });
    const clientId = await createClient(db, { name: 'Kunde', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 }); // catalog default S 19 %
    return { db, clientId, id };
  };

  it('a VAT line blocks Issue (no number taken); the one-tap fix sets it to 0 % and Issue goes through', async () => {
    const { db, id } = await sb19();
    const error = await issueDocument(db, id, clock('2026-10-01')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IssueBlockedError);
    expect((error as IssueBlockedError).items.map((i) => i.id)).toEqual(['small_business_vat']);
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ nextValue: 1, maxUsed: 0 });

    expect(await removeLineVat(db, id, NOW)).toBe(1);
    expect((await listLines(db, id))[0]).toMatchObject({ taxCategory: 'E', taxRateBp: 0, netCents: 10_000 });
    expect(await removeLineVat(db, id, NOW)).toBe(0);
    await issueDocument(db, id, clock('2026-10-01'));
    const t = text(renderHtml(await renderModelFor(db, id), opts));
    expect(t).toContain('Gesamtbetrag 100,00 €');
    expect(t).not.toContain('USt. auf');
    expect(t).toContain(LEGAL_NOTES.small_business.text.de);
  });

  it('the renderer shows VAT whenever the document carries VAT, whatever the mode (total = lines + VAT shown)', async () => {
    const { db, id } = await sb19(); // the draft preview of the blocked document
    const html = renderHtml(await renderModelFor(db, id), opts);
    const t = text(html);
    expect(t).toContain('Nettobetrag 100,00 €');
    expect(t).toContain('zzgl. 19 % USt. auf 100,00 €: 19,00 €'.replace(': ', ' '));
    expect(t).toContain('Gesamtbetrag 119,00 €');
  });

  it('a Storno after switching §19 on reproduces the invoice VAT and shows it', async () => {
    const db = await setup();
    const clientId = await createClient(db, { name: 'Kunde', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const invoiceId = await issued(db, clientId); // 100 + 19 % = 119
    await updateBusiness(db, { vatMode: 'small_business' }, NOW + 1);
    const { cancellationId } = await cancelInvoice(db, invoiceId, clock('2026-10-02'));
    const original = await renderModelFor(db, invoiceId);
    const storno = await renderModelFor(db, cancellationId);
    expect(storno.business.vatMode).toBe('standard');
    expect(storno.totals).toMatchObject({ net: -10_000, tax: -1_900, gross: -11_900 });
    expect(storno.totals.groups).toEqual(original.totals.groups.map((g) => ({ ...g, amount: -g.amount, discount: 0 - g.discount, taxable: -g.taxable, tax: -g.tax, gross: -g.gross })));
    const t = text(renderHtml(storno, opts));
    expect(t).toContain('zzgl. 19 % USt. auf -100,00 € -19,00 €');
    expect(t).toContain('Gesamtbetrag -119,00 €');
    expect(t).not.toContain(LEGAL_NOTES.small_business.text.de);
  });

  it('…and the other way round: a Storno of a §19 invoice after switching back keeps §19 (note, no VAT)', async () => {
    const { db, id } = await sb19();
    await removeLineVat(db, id, NOW);
    await issueDocument(db, id, clock('2026-10-01'));
    await updateBusiness(db, { vatMode: 'standard' }, NOW + 1);
    const { cancellationId } = await cancelInvoice(db, id, clock('2026-10-02'));
    const storno = await renderModelFor(db, cancellationId);
    expect(storno.business.vatMode).toBe('small_business');
    const t = text(renderHtml(storno, opts));
    expect(t).toContain(LEGAL_NOTES.small_business.text.de);
    expect(t).toContain('Gesamtbetrag -100,00 €');
    expect(t).not.toContain('USt. auf');
  });

  it('a payment receipt prints no VAT breakdown, refers to the invoice and names an overpayment (v1.1 D79, review #1)', async () => {
    const db = await setup();
    const clientId = await createClient(db, { name: 'Kunde', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const invoiceId = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, invoiceId, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 });
    await addLine(db, invoiceId, { name: 'Buch', qtyMilli: 1000, priceE4: 200_000, taxRateBp: 700 });
    await issueDocument(db, invoiceId, clock('2026-10-01')); // 140,40
    await addPayment(db, invoiceId, { date: '2026-10-05', amountCents: 50_000 }, NOW);
    await updateBusiness(db, { vatMode: 'small_business' }, NOW + 1);
    const receiptId = await createPaymentReceipt(db, invoiceId, { today: '2026-10-05', now: NOW });
    await issueDocument(db, receiptId, clock('2026-10-05')); // receipts of an invoice are not blocked by §19
    const html = renderHtml(await renderModelFor(db, receiptId), opts);
    const t = text(html);
    expect(t).toContain('Erhaltener Betrag 140,40 €');
    expect(t).toContain('Überzahlt um 359,60 €');
    expect(t).toContain('Angaben zur Umsatzsteuer: siehe Rechnung RE-2026-0001 vom 01.10.2026');
    expect(t).not.toMatch(/USt\. auf|72,65|67,66|4,99/);
    expect(html).not.toContain('data-vat-summary');
  });
});

describe('no-VAT treatments with VAT lines (v1.1 D83, review #6)', () => {
  it('review probe B2: intra-EU client (FR) with a 19 % line → Issue blocked, no number taken; the one-tap fix issues it without VAT', async () => {
    const db = await setup({ vatId: 'DE123456789' });
    const clientId = await createClient(db, { name: 'Client SARL', countryCode: 'FR', vatId: 'FR12345678901', treatment: 'intra_eu_goods', street: 'Rue 1', postalCode: '75001', city: 'Paris' }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Ware', qtyMilli: 1000, priceE4: 1_000_000, taxCategory: 'S', taxRateBp: 1900 });
    const blocked = await issueDocument(db, id, clock('2026-10-01')).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(IssueBlockedError);
    expect((blocked as IssueBlockedError).items.map((i) => i.id)).toEqual(['vat_lines_conflict']);
    expect(await getCounter(db, 'invoice:2026')).toMatchObject({ maxUsed: 0 });
    expect(await removeLineVat(db, id, NOW)).toBe(1);
    await issueDocument(db, id, clock('2026-10-01'));
    const t = text(renderHtml(await renderModelFor(db, id), opts));
    expect(t).toContain('Gesamtbetrag 100,00 €');
    expect(t).not.toContain('19 % USt.');
  });
});

describe('"This PDF is not an e-invoice" in the footer (v1.1 D88, review #10)', () => {
  const big = async (db: Awaited<ReturnType<typeof setup>>, clientId: number | null, priceE4 = 10_000_000) => {
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4, taxRateBp: 1900 });
    await issueDocument(db, id, clock('2026-10-01'));
    return text(renderHtml(await renderModelFor(db, id), opts));
  };
  const NOTE = 'Dieses PDF ist keine E-Rechnung (kein strukturiertes Format nach § 14 Abs. 1 UStG). · Seite 1 von 1';

  it('domestic business client above 250 €: the note sits next to the page number; also on the Storno', async () => {
    const db = await setup();
    const firm = await createClient(db, { name: 'Firma GmbH', kind: 'business', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    expect(await big(db, firm)).toContain(NOTE); // 1.190,00 €
    const [inv] = await db.getAllAsync<{ id: number }>("SELECT id FROM documents WHERE type = 'invoice' ORDER BY id");
    const { cancellationId } = await cancelInvoice(db, inv.id, clock('2026-10-02'));
    expect(text(renderHtml(await renderModelFor(db, cancellationId), opts))).toContain(NOTE);
  });

  it('not for private clients, foreign clients, no client, 250 € or less, §19, and not on documents issued before renderer 4', async () => {
    const db = await setup();
    const person = await createClient(db, { name: 'Erika Muster', kind: 'person', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const foreign = await createClient(db, { name: 'Acme SARL', kind: 'business', countryCode: 'FR', street: 'R 1', postalCode: '75001', city: 'Paris' }, NOW);
    const firm = await createClient(db, { name: 'Firma GmbH', kind: 'business', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    for (const t of [await big(db, person), await big(db, foreign), await big(db, null), await big(db, firm, 2_100_000)]) {
      expect(t).not.toContain('E-Rechnung');
      expect(t).toContain('Seite 1 von 1');
    }
    const id = await newDraft(db, { type: 'invoice', clientId: firm, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 10_000_000, taxRateBp: 1900 });
    await issueDocument(db, id, clock('2026-10-01'));
    const model = await renderModelFor(db, id);
    expect(text(renderHtml({ ...model, rendererVersion: 3 }, opts))).not.toContain('E-Rechnung'); // a v1.0 snapshot
    expect(text(renderHtml({ ...model, business: { ...model.business, vatMode: 'small_business' } }, opts))).not.toContain('E-Rechnung');
    expect(text(renderHtml({ ...model, language: 'en' }, opts))).toContain('This PDF is not an e-invoice');
  });
});

describe('cosmetic fixes (review #19)', () => {
  it('a group reduced to 0 by a 100 % line discount prints no VAT row and no summary table', async () => {
    const db = await setup();
    const clientId = await createClient(db, { name: 'Kunde', street: 'A 1', postalCode: '20095', city: 'Hamburg' }, NOW);
    const id = await newDraft(db, { type: 'invoice', clientId, today: '2026-10-01', now: NOW });
    await addLine(db, id, { name: 'Leistung', qtyMilli: 1000, priceE4: 1_000_000, taxRateBp: 1900 });
    await addLine(db, id, { name: 'Buch (geschenkt)', qtyMilli: 1000, priceE4: 200_000, taxRateBp: 700, discountKind: 'percent', discountValue: 10_000 });
    await issueDocument(db, id, clock('2026-10-01'));
    const html = renderHtml(await renderModelFor(db, id), opts);
    expect(text(html)).toContain('zzgl. 19 % USt. auf 100,00 €');
    expect(text(html)).not.toContain('7 % USt. auf');
    expect(html).not.toContain('data-vat-summary');
  });
});
