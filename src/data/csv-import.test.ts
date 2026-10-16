import { buildCsv, guardFormula } from './csv';
import { guessMapping, needsTreatmentReview, planImport, readCsv, recordsToImport, type Existing } from './csv-import';
import { NOW, emptyDb, seededDb } from './test-data';
import { readCsvInput } from '@/db/export';
import { importClients, importItems, readImportExisting } from '@/db/import';
import { listClients, updateClient } from '@/db/clients';
import { listCatalogItems } from '@/db/items';
import { withRead } from '@/db/transaction';

const NONE: Existing = { clients: [], items: [] };
const ok = (text: string) => {
  const r = readCsv(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('readCsv', () => {
  it('strips the BOM, detects ; and reads quoted separators, quotes and newlines', () => {
    const r = ok('﻿Name;Notizen\r\n"Müller; Söhne";"Zeile 1\r\nZeile 2 mit ""Zitat"""\r\n');
    expect(r.separator).toBe(';');
    expect(r.rows).toEqual([['Name', 'Notizen'], ['Müller; Söhne', 'Zeile 1\r\nZeile 2 mit "Zitat"']]);
  });
  it('detects , and tab, accepts LF and CR line ends, drops blank lines', () => {
    expect(ok('a,b\nc,d\n\n').rows).toEqual([['a', 'b'], ['c', 'd']]);
    expect(ok('a\tb\rc\td').separator).toBe('\t');
    expect(ok('a\tb\rc\td').rows).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('refuses empty, unclosed-quote and oversized files', () => {
    expect(readCsv('')).toEqual({ ok: false, error: 'empty' });
    expect(readCsv('﻿  \n')).toEqual({ ok: false, error: 'empty' });
    expect(readCsv('a;b\n"open;x')).toEqual({ ok: false, error: 'unclosedQuote' });
    expect(readCsv('x'.repeat(5_000_001))).toEqual({ ok: false, error: 'tooLarge' });
    expect(readCsv(`a\n${'x\n'.repeat(5_002)}`)).toEqual({ ok: false, error: 'tooManyRows' });
  });
});

describe('clients', () => {
  it('maps German headers of other apps (Firma/Vorname/Nachname) and reads kind, contact, country', () => {
    const r = ok('Firma;Vorname;Nachname;Straße;PLZ;Ort;Land;E-Mail;USt-IdNr.\nBeta AG;Eva;Klein;Weg 1;1010;Wien;Österreich;eva@beta.at;ATU 1234 5678\n;Max;Muster;Gasse 2;10115;Berlin;;max@web.de;\n');
    const plan = planImport(r, 'clients', NONE);
    expect(plan.counts).toEqual({ total: 2, ready: 2, duplicates: 0, skipped: 0 });
    const [a, b] = recordsToImport(plan, false);
    expect(a).toEqual(expect.objectContaining({ kind: 'business', name: 'Beta AG', contact: 'Eva Klein', countryCode: 'AT', vatId: 'ATU12345678', postalCode: '1010' }));
    expect(b).toEqual(expect.objectContaining({ kind: 'person', name: 'Max Muster', contact: '', countryCode: 'DE' }));
    expect(needsTreatmentReview(a)).toBe(true);
    expect(needsTreatmentReview(b)).toBe(false);
  });
  it('maps Google Contacts and Outlook headers', () => {
    expect(guessMapping(['Given Name', 'Family Name', 'Organization 1 - Name', 'E-mail 1 - Value', 'Phone 1 - Value', 'Address 1 - City'], 'clients'))
      .toEqual(['firstName', 'lastName', 'company', 'email', 'phone', 'city']);
    expect(guessMapping(['First Name', 'Last Name', 'Company', 'Business Street', 'Business City', 'Business Postal Code', 'E-mail Address', 'Business Phone'], 'clients'))
      .toEqual(['firstName', 'lastName', 'company', 'street', 'city', 'postalCode', 'email', 'phone']);
  });
  it('a row without any name is skipped; bad values fall back to defaults and are reported', () => {
    const plan = planImport(ok('Name,Country,Payment terms (days),Currency\n,DE,,\nAcme,Atlantis,400,euro\n'), 'clients', NONE);
    expect(plan.rows[0]).toEqual(expect.objectContaining({ line: 2, record: null, problems: ['noName'] }));
    expect(plan.rows[1].problems).toEqual(['badCountry', 'badPaymentDays', 'badCurrency']);
    expect(plan.rows[1].record).toEqual(expect.objectContaining({ countryCode: 'DE', paymentDays: null, currency: null }));
    expect(plan.counts).toEqual({ total: 2, ready: 1, duplicates: 0, skipped: 1 });
  });
  it('finds duplicates against the phone (same e-mail, or same name + postcode) and inside the file', () => {
    const existing: Existing = { clients: [{ id: 7, name: 'Müller GmbH', email: 'info@mueller.de', postalCode: '80331' }], items: [] };
    const plan = planImport(ok('Name;E-Mail;PLZ\nMÜLLER  GmbH;;80331\nAndere;INFO@mueller.de;\nNeu;neu@x.de;\nneu;neu@x.de;\n'), 'clients', existing);
    expect(plan.rows.map((r) => r.duplicateOf)).toEqual([7, 7, null, 'file']);
    expect(plan.counts).toEqual({ total: 4, ready: 1, duplicates: 3, skipped: 0 });
    expect(recordsToImport(plan, false).map((c) => c.name)).toEqual(['Neu']);
    expect(recordsToImport(plan, true)).toHaveLength(4);
  });
  it('keeps a formula-looking cell as inert text and undoes our own export guard exactly', () => {
    const plan = planImport(ok(`Name;Notizen\n=1+1;${guardFormula('=HYPERLINK("x")')}\n"'=2+2";@cmd\n`), 'clients', NONE);
    const [a, b] = recordsToImport(plan, false);
    expect(a.name).toBe('=1+1');
    expect(a.notes).toBe('=HYPERLINK("x")');
    expect(b.name).toBe('=2+2');
    expect(b.notes).toBe('@cmd');
  });
});

describe('items', () => {
  it('German file: decimal comma, thousands dot, %, unit words, gross flag', () => {
    const plan = planImport(ok('Bezeichnung;Einheit;Preis;MwSt;Brutto;Artikelnr.\nBeratung;Std;1.234,50;19 %;nein;B-1\nBuch;Stk;12,9 €;7;ja;\nExport;pauschal;100;0;;\n'), 'items', NONE);
    expect(recordsToImport(plan, false)).toEqual([
      expect.objectContaining({ name: 'Beratung', unitCode: 'HUR', priceE4: 12_345_000, taxRateBp: 1900, taxCategory: 'S', priceIncludesVat: false, sku: 'B-1' }),
      expect.objectContaining({ name: 'Buch', unitCode: 'C62', priceE4: 129_000, taxRateBp: 700, priceIncludesVat: true }),
      expect.objectContaining({ name: 'Export', unitCode: 'LS', priceE4: 1_000_000, taxRateBp: 0, taxCategory: 'Z' }),
    ]);
  });
  it('English file: 1,234.50; bad price and bad rate rows are skipped, unknown unit reported', () => {
    const plan = planImport(ok('Name,Unit,Price,VAT rate %\nA,hours,"1,234.50",19\nB,crates,5,7\nC,,abc,19\nD,,1,150\n'), 'items', NONE);
    expect(plan.rows.map((r) => r.problems)).toEqual([[], ['unknownUnit'], ['badPrice'], ['badVatRate']]);
    expect(recordsToImport(plan, false).map((i) => [i.name, i.priceE4, i.unitCode])).toEqual([['A', 12_345_000, 'HUR'], ['B', 50_000, 'C62']]);
  });
  it('duplicates by SKU, or by name when there is no SKU', () => {
    const existing: Existing = { clients: [], items: [{ id: 3, name: 'Beratung', sku: '' }, { id: 4, name: 'X', sku: 'S-9' }] };
    const plan = planImport(ok('Name;Artikelnr.\nberatung;\nNeu;s-9\nNeu;\n'), 'items', existing);
    expect(plan.rows.map((r) => r.duplicateOf)).toEqual([3, 4, null]);
  });
});

describe('round trip through our own CSV export (both languages) into an empty phone', () => {
  for (const lang of ['de', 'en'] as const) {
    it(`${lang}: clients and items come back field for field`, async () => {
      const { db, ids } = await seededDb();
      await updateClient(db, ids.kunde, { shipName: 'Lager; Nord', shipStreet: 'Kai 1', shipPostalCode: '20457', shipCity: 'Hamburg', shipCountryCode: 'DE' }, NOW);
      const input = await withRead(db, readCsvInput);
      const target = await emptyDb();
      const clientsCsv = buildCsv('clients', input, { lang, today: '2026-10-14' });
      const itemsCsv = buildCsv('items', input, { lang, today: '2026-10-14' });
      const cPlan = planImport(ok(clientsCsv), 'clients', await readImportExisting(target));
      const iPlan = planImport(ok(itemsCsv), 'items', await readImportExisting(target));
      expect(cPlan.rows.every((r) => r.problems.length === 0)).toBe(true);
      expect(iPlan.rows.every((r) => r.problems.length === 0)).toBe(true);
      await importClients(target, recordsToImport(cPlan, false), NOW);
      await importItems(target, recordsToImport(iPlan, false), NOW);
      const strip = <T extends { id: number; createdAt: number; updatedAt: number }>(rows: T[]) =>
        rows.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(strip(await listClients(target, { includeArchived: true }))).toEqual(strip(input.clients));
      expect(strip(await listCatalogItems(target, { includeArchived: true }))).toEqual(strip(input.items));
      // Importing the same file again finds every row as a duplicate.
      const again = planImport(ok(clientsCsv), 'clients', await readImportExisting(target));
      expect(again.counts.ready).toBe(0);
    });
  }

  it('the import is all or nothing', async () => {
    const db = await emptyDb();
    const bad = [{ name: 'A' }, { name: null }] as never[];
    await expect(importClients(db, bad, NOW)).rejects.toThrow();
    expect(await listClients(db, { includeArchived: true })).toEqual([]);
  });
});
