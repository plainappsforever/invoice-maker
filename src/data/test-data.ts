// A populated test database for the CSV and backup tests: a business with a logo, clients with awkward names
// (separators, quotes, line breaks, formula starts), catalog items, drafts, issued invoices in two languages with
// mixed VAT, discounts and payments, a cancellation, a quote that became an invoice, receipts, raised counters
// and settings. Built through the real lifecycle functions, so every row is one the app can produce.
import { createClient, setClientArchived } from '@/db/clients';
import { updateBusiness } from '@/db/business';
import { setNextValue } from '@/db/counters';
import { updateDraft } from '@/db/documents';
import { createCatalogItem } from '@/db/items';
import { acceptQuote, cancelInvoice, convertQuote, createPaymentReceipt, issueDocument, newDraft } from '@/db/lifecycle';
import { addLine } from '@/db/lines';
import { openDatabase } from '@/db/migrations';
import { addPayment } from '@/db/payments';
import { setSetting } from '@/db/settings';
import type { Db } from '@/db/types';

import { createTestDb } from '../../test/node-sqlite-db';

export const NOW = 1_790_000_000_000;

export async function emptyDb(): Promise<Db> {
  const db = createTestDb();
  await openDatabase(db);
  return db;
}

export type Seeded = { db: Db; ids: Record<string, number> };

export async function seededDb(): Promise<Seeded> {
  const db = await emptyDb();
  const ids: Record<string, number> = {};
  const clock = (today: string, step = 0) => ({ today, now: NOW + step });

  await updateBusiness(
    db,
    {
      name: 'Muster Design GmbH', street: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '12/345/67890',
      vatId: 'DE123456789', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', bankName: 'Commerzbank',
      accountHolder: 'Muster Design GmbH', email: 'hallo@muster.example', footer: 'Amtsgericht Berlin HRB 1', logoFile: 'logo/abc123.png',
    },
    NOW
  );
  ids.kunde = await createClient(db, { name: 'Kunde GmbH', street: 'Weg 2', postalCode: '20095', city: 'Hamburg', email: 'k@kunde.example' }, NOW);
  ids.weird = await createClient(db, { name: 'Müller; "Söhne"\n& Co, KG', street: 'Ring 1', postalCode: '80331', city: 'München', notes: 'Zeile 1\nZeile 2, mit "Quote"' }, NOW);
  ids.formula = await createClient(db, { name: '=HYPERLINK("http://evil.example","x")', street: '@SUM(A1)', city: '+49 Stadt', notes: '-5 % Rabatt' }, NOW);
  ids.acme = await createClient(
    db,
    { name: 'Acme BV', street: 'Keizersgracht 1', postalCode: '1015 CJ', city: 'Amsterdam', countryCode: 'NL', vatId: 'NL123456789B01', treatment: 'reverse_charge', language: 'en', currency: 'EUR', paymentDays: 30 },
    NOW
  );
  ids.old = await createClient(db, { name: 'Archivkunde', paymentDays: 7 }, NOW);
  await setClientArchived(db, ids.old, true, NOW);

  ids.item1 = await createCatalogItem(db, { name: 'Webdesign', unitCode: 'HUR', priceE4: 850_000, taxRateBp: 1900 }, NOW);
  ids.item2 = await createCatalogItem(db, { name: '+cmd|calc', description: 'Formel, "Test"', priceE4: 1_234_500, priceIncludesVat: true, taxRateBp: 700 }, NOW);
  ids.item3 = await createCatalogItem(db, { name: 'Beratung', unitCode: 'DAY', priceE4: 5_000_000, taxCategory: 'AE', taxRateBp: 0 }, NOW);

  // Invoice 1 (2025 → the period filter has something outside 2026): two VAT rates, discounts, part payment.
  ids.inv1 = await newDraft(db, { type: 'invoice', clientId: ids.kunde, today: '2025-12-15', now: NOW });
  await addLine(db, ids.inv1, { name: 'Webdesign', description: 'Relaunch', qtyMilli: 12_500, priceE4: 850_000, taxRateBp: 1900, unitCode: 'HUR', discountKind: 'percent', discountValue: 1000, catalogItemId: ids.item1 });
  await addLine(db, ids.inv1, { name: 'Fachbuch', qtyMilli: 2_000, priceE4: 249_000, taxRateBp: 700 });
  await updateDraft(db, ids.inv1, { discountKind: 'percent', discountValue: 500, intro: 'Danke!', depositCents: 20_000 }, NOW);
  await issueDocument(db, ids.inv1, clock('2025-12-15', 1));
  await addPayment(db, ids.inv1, { date: '2025-12-20', amountCents: 30_000, method: 'bank', note: 'Anzahlung; "teilweise"' }, NOW);

  // Invoice 2: client with the awkward name, gross prices, paid in full; then a payment receipt.
  ids.inv2 = await newDraft(db, { type: 'invoice', clientId: ids.weird, today: '2026-03-10', now: NOW });
  await addLine(db, ids.inv2, { name: '=1+1', description: '-Zeile\nzwei', qtyMilli: 1_000, priceE4: 1_234_500, taxRateBp: 700, catalogItemId: ids.item2 });
  await updateDraft(db, ids.inv2, { pricesIncludeVat: true }, NOW);
  await issueDocument(db, ids.inv2, clock('2026-03-10', 2));
  const gross2 = (await db.getFirstAsync<{ gross_cents: number }>('SELECT gross_cents FROM documents WHERE id = ?', ids.inv2))!.gross_cents;
  ids.pay2 = await addPayment(db, ids.inv2, { date: '2026-03-12', amountCents: gross2, method: 'cash' }, NOW);
  ids.receipt = await createPaymentReceipt(db, ids.inv2, { today: '2026-03-12', now: NOW + 3 });
  await issueDocument(db, ids.receipt, clock('2026-03-12', 3));

  // Invoice 3: reverse charge, English, then cancelled (cancellation invoice in the same series).
  ids.inv3 = await newDraft(db, { type: 'invoice', clientId: ids.acme, today: '2026-05-02', now: NOW });
  await addLine(db, ids.inv3, { name: 'Consulting', qtyMilli: 1_000, priceE4: 20_000_000, taxCategory: 'AE', taxRateBp: 0, unitCode: 'DAY', catalogItemId: ids.item3 });
  await updateDraft(db, ids.inv3, { reference: 'PO-77', serviceMode: 'period', serviceFrom: '2026-04-01', serviceTo: '2026-04-30' }, NOW);
  await issueDocument(db, ids.inv3, clock('2026-05-02', 4));
  const cancelled = await cancelInvoice(db, ids.inv3, clock('2026-05-20', 5));
  ids.cancellation = cancelled.cancellationId;

  // A quote that is accepted and converted; the invoice made from it is issued.
  ids.quote = await newDraft(db, { type: 'quote', clientId: ids.kunde, today: '2026-06-01', now: NOW });
  await addLine(db, ids.quote, { name: 'Logo-Entwurf', qtyMilli: 1_000, priceE4: 4_000_000, taxRateBp: 1900 });
  await issueDocument(db, ids.quote, clock('2026-06-01', 6));
  await acceptQuote(db, ids.quote, NOW + 7);
  ids.inv4 = await convertQuote(db, ids.quote, clock('2026-06-15', 8));
  await issueDocument(db, ids.inv4, clock('2026-06-15', 9));

  // A cash receipt and a draft invoice that stays a draft.
  ids.cash = await newDraft(db, { type: 'receipt', receiptKind: 'cash', clientId: null, today: '2026-07-04', now: NOW });
  await addLine(db, ids.cash, { name: 'Kaffee', qtyMilli: 2_000, priceE4: 35_000, taxRateBp: 700 });
  await issueDocument(db, ids.cash, clock('2026-07-04', 10));
  ids.draft = await newDraft(db, { type: 'invoice', clientId: ids.kunde, today: '2026-09-30', now: NOW });
  await addLine(db, ids.draft, { name: 'Entwurf', qtyMilli: 1_000, priceE4: 100_000, taxRateBp: 1900 });

  await setNextValue(db, 'quote:2026', 40);
  await setSetting(db, 'default_template', 'modern');
  await setSetting(db, 'text.de.intro.invoice', 'Vielen Dank für Ihren Auftrag.');
  await setSetting(db, 'theme', 'dark');
  await setSetting(db, 'notif_asked', '1');
  await setSetting(db, 'last_backup_at', '123');
  return { db, ids };
}

export const DATA_TABLES = ['business', 'tax_rates', 'clients', 'catalog_items', 'documents', 'document_lines', 'payments', 'number_counters', 'settings', 'attachments', 'signatures'] as const;

/** Every row of every table as SQLite returns it, except documents.pdf_file (not part of a backup). */
export async function dump(db: Db): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of DATA_TABLES) {
    const order = t === 'settings' ? 'key' : t === 'number_counters' ? 'series_key' : t === 'signatures' ? 'document_id' : 'id';
    const rows = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY ${order}`);
    out[t] = rows.map((r) => {
      const { pdf_file: _pdf, ...rest } = r;
      return rest;
    });
  }
  return out;
}

export async function triggerNames(db: Db): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).map((r) => r.name);
}
