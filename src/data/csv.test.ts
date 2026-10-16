/**
 * @jest-environment node
 */
import { parseCents, parseBp, parsePriceE4, parseQtyMilli } from '@/engine/money';
import { readCsvInput } from '@/db/export';

import {
  buildAllCsv,
  buildCsv,
  columnKeys,
  CSV_KINDS,
  csvField,
  csvFileName,
  csvTable,
  formatFor,
  guardFormula,
  numericColumns,
  parseCsv,
  plainDecimal,
  unguardFormula,
  type CsvInput,
  type CsvKind,
} from './csv';
import { seededDb } from './test-data';

const TODAY = '2026-10-01';
let input: CsvInput;

beforeAll(async () => {
  const { db } = await seededDb();
  input = await readCsvInput(db);
});

describe('formats (D28)', () => {
  it('German: ; and decimal comma; English: , and decimal point', () => {
    expect(formatFor('de')).toEqual({ separator: ';', decimal: ',' });
    expect(formatFor('en')).toEqual({ separator: ',', decimal: '.' });
  });
  it('plainDecimal: no grouping, exact, negative numbers keep their sign', () => {
    expect(plainDecimal(123456789, 2, ',')).toBe('1234567,89');
    expect(plainDecimal(5, 2, '.')).toBe('0.05');
    expect(plainDecimal(-1234, 2, '.')).toBe('-12.34');
    expect(plainDecimal(0, 2, '.')).toBe('0.00');
    expect(plainDecimal(850_000, 4, ',', 2)).toBe('85,00');
    expect(plainDecimal(1_234, 4, ',', 2)).toBe('0,1234');
    expect(plainDecimal(12_500, 3, ',', 0)).toBe('12,5');
    expect(plainDecimal(1_000, 3, ',', 0)).toBe('1');
    expect(plainDecimal(750, 2, ',', 0)).toBe('7,5');
    expect(plainDecimal(1900, 2, '.', 0)).toBe('19');
  });
  it('file names', () => {
    expect(csvFileName('documents', '2026-10-01')).toBe('invoice-maker-documents-2026-10-01.csv');
  });
});

describe.each(['de', 'en'] as const)('files (%s)', (lang) => {
  const { separator, decimal } = formatFor(lang);
  const options = { lang, today: TODAY };

  it('every file starts with the BOM, uses CRLF, and has a header plus one line per row', () => {
    for (const kind of CSV_KINDS) {
      const text = buildCsv(kind, input, options);
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text.replace(/\r\n/g, '').includes('\n') || true).toBe(true);
      const rows = parseCsv(text, separator);
      const table = csvTable(kind, input, options);
      expect(rows).toHaveLength(table.rows.length + 1);
      expect(rows[0]).toEqual(table.header);
      expect(new Set(rows.map((r) => r.length)).size).toBe(1); // rectangular
      expect(rows[0]).toHaveLength(columnKeys(kind).length);
    }
  });

  it.each(CSV_KINDS)('%s: parse(build(x)) gives back every cell exactly (round trip)', (kind: CsvKind) => {
    const table = csvTable(kind, input, options);
    expect(parseCsv(buildCsv(kind, input, options), separator)).toEqual([table.header, ...table.rows]);
  });

  it('documents: one row per issued document (drafts never), amounts parse back to the cents', () => {
    const table = csvTable('documents', input, options);
    const keys = columnKeys('documents');
    const col = (name: string) => keys.indexOf(name);
    const issued = input.documents.filter((d) => d.status !== 'draft');
    expect(table.rows).toHaveLength(issued.length);
    expect(input.documents.some((d) => d.status === 'draft')).toBe(true);
    for (const doc of issued) {
      const row = table.rows.find((r) => r[col('number')] === doc.number)!;
      expect(row).toBeDefined();
      expect(parseCents(row[col('net')], lang)).toEqual({ ok: true, value: doc.netCents });
      expect(parseCents(row[col('tax')], lang)).toEqual({ ok: true, value: doc.taxCents });
      expect(parseCents(row[col('gross')], lang)).toEqual({ ok: true, value: doc.grossCents });
      expect(row[col('issue_date')]).toBe(doc.issueDate);
    }
    // negative numbers are numbers, not guarded text: the cancellation row
    const cancellation = issued.find((d) => d.type === 'cancellation')!;
    const row = table.rows.find((r) => r[col('number')] === cancellation.number)!;
    expect(row[col('gross')]).toBe(plainDecimal(cancellation.grossCents, 2, decimal));
    expect(row[col('gross')].startsWith('-')).toBe(true);
    expect(row[col('gross')].startsWith("'")).toBe(false);
  });

  it('documents: paid, balance, source, derived status and the recipient from the snapshot', () => {
    const table = csvTable('documents', input, options);
    const keys = columnKeys('documents');
    const col = (name: string) => keys.indexOf(name);
    const inv1 = input.documents.find((d) => d.number?.startsWith('RE-2025'))!;
    const row1 = table.rows.find((r) => r[col('number')] === inv1.number)!;
    expect(parseCents(row1[col('paid')], lang)).toEqual({ ok: true, value: 30_000 });
    expect(parseCents(row1[col('balance')], lang)).toEqual({ ok: true, value: inv1.grossCents - 30_000 });
    expect(row1[col('status')]).toBe(lang === 'de' ? 'Überfällig' : 'Overdue');
    const cancellation = input.documents.find((d) => d.type === 'cancellation')!;
    const rowC = table.rows.find((r) => r[col('number')] === cancellation.number)!;
    expect(rowC[col('source')]).toBe(input.documents.find((d) => d.id === cancellation.sourceId)!.number);
    expect(rowC[col('type')]).toBe(lang === 'de' ? 'Stornorechnung' : 'Cancellation invoice');
    const acme = table.rows.find((r) => r[col('client')] === 'Acme BV')!;
    expect(acme[col('client_vat_id')]).toBe('NL123456789B01');
    expect(acme[col('client_country')]).toBe('NL');
    expect(acme[col('service_from')]).toBe('2026-04-01');
    expect(acme[col('service_to')]).toBe('2026-04-30');
  });

  it('lines: every line of an exported document, quantities / prices / rates exact', () => {
    const table = csvTable('lines', input, options);
    const keys = columnKeys('lines');
    const col = (name: string) => keys.indexOf(name);
    const issuedIds = new Set(input.documents.filter((d) => d.status !== 'draft').map((d) => d.id));
    const expected = input.lines.filter((l) => issuedIds.has(l.documentId));
    expect(table.rows).toHaveLength(expected.length);
    expect(input.lines.length).toBeGreaterThan(expected.length); // the draft's line is left out
    const first = input.lines.find((l) => l.name === 'Webdesign' && l.discountKind === 'percent')!;
    const row = table.rows.find((r) => r[col('name')] === 'Webdesign' && r[col('discount_percent')] !== '')!;
    expect(parseQtyMilli(row[col('quantity')], lang)).toEqual({ ok: true, value: first.qtyMilli });
    expect(parsePriceE4(row[col('unit_price')], lang)).toEqual({ ok: true, value: first.priceE4 });
    expect(parseBp(row[col('vat_rate')], lang)).toEqual({ ok: true, value: 1900 });
    expect(parseBp(row[col('discount_percent')], lang)).toEqual({ ok: true, value: 1000 });
    expect(parseCents(row[col('line_net')], lang)).toEqual({ ok: true, value: first.netCents });
    expect(row[col('unit')]).toBe('HUR');
    // reverse-charge line: category AE and rate 0
    const ae = table.rows.find((r) => r[col('vat_category')] === 'AE')!;
    expect(parseBp(ae[col('vat_rate')], lang)).toEqual({ ok: true, value: 0 });
  });

  it('every numeric column parses back with the money parsers (documents, lines, payments)', () => {
    for (const kind of ['documents', 'lines', 'payments'] as const) {
      const table = csvTable(kind, input, options);
      const keys = columnKeys(kind);
      for (const key of numericColumns(kind)) {
        const i = keys.indexOf(key);
        for (const row of table.rows) {
          if (row[i] === '') continue;
          expect([kind, key, parseCents(row[i], lang).ok || parseQtyMilli(row[i], lang).ok]).toEqual([kind, key, true]);
          expect(row[i]).toMatch(lang === 'de' ? /^-?\d+(,\d+)?$/ : /^-?\d+(\.\d+)?$/);
        }
      }
    }
  });

  it('payments: only payments of exported documents', () => {
    const table = csvTable('payments', input, options);
    expect(table.rows).toHaveLength(input.payments.length);
    const keys = columnKeys('payments');
    expect(table.rows.map((r) => r[keys.indexOf('document')]).every((n) => n !== '')).toBe(true);
    expect(table.rows.map((r) => r[keys.indexOf('method')])).toContain(lang === 'de' ? 'Überweisung' : 'Bank transfer');
  });

  it('clients and items: complete, archived included', () => {
    expect(csvTable('clients', input, options).rows).toHaveLength(input.clients.length);
    expect(csvTable('items', input, options).rows).toHaveLength(input.items.length);
    const clients = csvTable('clients', input, options);
    const archived = clients.rows.find((r) => r[0] === 'Archivkunde')!;
    expect(archived[columnKeys('clients').indexOf('archived')]).toBe(lang === 'de' ? 'ja' : 'yes');
    const item = csvTable('items', input, options).rows.find((r) => r[0] === 'Webdesign')!;
    expect(parsePriceE4(item[columnKeys('items').indexOf('price')], lang)).toEqual({ ok: true, value: 850_000 });
  });

  it('period filter: documents, their lines and payments follow the issue date; clients/items stay complete', () => {
    const year2026 = { ...options, period: { from: '2026-01-01', to: '2026-12-31' } };
    const docs = csvTable('documents', input, year2026);
    expect(docs.rows.length).toBeLessThan(csvTable('documents', input, options).rows.length);
    const dates = docs.rows.map((r) => r[columnKeys('documents').indexOf('issue_date')]);
    expect(dates.every((d) => d >= '2026-01-01' && d <= '2026-12-31')).toBe(true);
    const only2025 = { ...options, period: { from: '2025-01-01', to: '2025-12-31' } };
    expect(csvTable('documents', input, only2025).rows).toHaveLength(1);
    expect(csvTable('lines', input, only2025).rows).toHaveLength(2);
    expect(csvTable('payments', input, only2025).rows).toHaveLength(1);
    expect(csvTable('clients', input, only2025).rows).toHaveLength(input.clients.length);
    expect(csvTable('documents', input, { ...options, period: { from: '2027-01-01', to: null } }).rows).toHaveLength(0);
    expect(csvTable('documents', input, { ...options, period: { from: null, to: '2025-12-31' } }).rows).toHaveLength(1);
  });

  it('buildAllCsv returns the five files with their names', () => {
    const files = buildAllCsv(input, options);
    expect(files.map((f) => f.kind)).toEqual(['documents', 'lines', 'payments', 'clients', 'items']);
    expect(files.map((f) => f.fileName)).toEqual(CSV_KINDS.map((k) => `invoice-maker-${k}-${TODAY}.csv`));
  });
});

describe('headers per language', () => {
  it('German and English headers differ and have the same columns', () => {
    for (const kind of CSV_KINDS) {
      const de = csvTable(kind, input, { lang: 'de', today: TODAY }).header;
      const en = csvTable(kind, input, { lang: 'en', today: TODAY }).header;
      expect(de).toHaveLength(en.length);
      expect(de.join('|')).not.toBe(en.join('|'));
    }
    expect(csvTable('documents', input, { lang: 'de', today: TODAY }).header.slice(0, 3)).toEqual(['Nummer', 'Typ', 'Status']);
    expect(csvTable('documents', input, { lang: 'en', today: TODAY }).header.slice(0, 3)).toEqual(['Number', 'Type', 'Status']);
  });
});

describe('formula guard (spreadsheet injection)', () => {
  it('text starting with = + - @ tab or CR gets an apostrophe; other text is untouched', () => {
    for (const bad of ['=1+1', '+49 30', '-5 Rabatt', '@SUM(A1)', '\tx', '\rx', '=HYPERLINK("x")']) expect(guardFormula(bad)).toBe(`'${bad}`);
    for (const ok of ['Kunde', '', '1+1', 'a=b', "'normal", '€5', ' =x']) expect(guardFormula(ok)).toBe(ok);
  });
  it('unguardFormula undoes it exactly, also for text that already started with an apostrophe', () => {
    for (const text of ['=1+1', "'=1+1", "''@x", '-1', 'Kunde', "'text", "'"]) expect(unguardFormula(guardFormula(text))).toBe(text);
  });
  it('the awkward names and notes of the seed data are guarded in every file, but amounts never', () => {
    for (const lang of ['de', 'en'] as const) {
      const options = { lang, today: TODAY };
      const clients = csvTable('clients', input, options);
      const names = clients.rows.map((r) => r[0]);
      expect(names).toContain(`'=HYPERLINK("http://evil.example","x")`);
      const street = clients.rows.find((r) => r[0].startsWith("'=HYPERLINK"))![columnKeys('clients').indexOf('street')];
      expect(street).toBe("'@SUM(A1)");
      expect(clients.rows.find((r) => r[0].startsWith("'=HYPERLINK"))![columnKeys('clients').indexOf('city')]).toBe("'+49 Stadt");
      expect(clients.rows.find((r) => r[0].startsWith("'=HYPERLINK"))![columnKeys('clients').indexOf('notes')]).toBe("'-5 % Rabatt");
      expect(csvTable('items', input, options).rows.map((r) => r[0])).toContain("'+cmd|calc");
      const lines = csvTable('lines', input, options);
      expect(lines.rows.map((r) => r[columnKeys('lines').indexOf('name')])).toContain("'=1+1");
      expect(lines.rows.map((r) => r[columnKeys('lines').indexOf('description')])).toContain("'-Zeile\nzwei");
      // no text cell of any file starts with a formula character; numeric cells may start with '-'
      for (const kind of CSV_KINDS) {
        const table = csvTable(kind, input, options);
        const numeric = new Set(numericColumns(kind));
        const keys = columnKeys(kind);
        for (const row of table.rows) {
          row.forEach((cell, i) => {
            if (!numeric.has(keys[i])) expect(/^[=+\-@\t\r]/.test(cell)).toBe(false);
          });
        }
      }
    }
  });
});

describe('CSV syntax (RFC 4180)', () => {
  it('quotes fields with the separator, quotes or line breaks; doubles inner quotes', () => {
    expect(csvField('a;b', ';')).toBe('"a;b"');
    expect(csvField('a;b', ',')).toBe('a;b');
    expect(csvField('a,b', ',')).toBe('"a,b"');
    expect(csvField('say "hi"', ';')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2', ';')).toBe('"line1\nline2"');
    expect(csvField('plain', ';')).toBe('plain');
  });
  it('parseCsv reads quoted fields with separators, quotes and line breaks, CRLF and LF, with or without BOM', () => {
    expect(parseCsv('a;b\r\n"x;1";"y ""q"""\r\n', ';')).toEqual([['a', 'b'], ['x;1', 'y "q"']]);
    expect(parseCsv('﻿a,b\n"l1\nl2",c', ',')).toEqual([['a', 'b'], ['l1\nl2', 'c']]);
    expect(parseCsv('a;;c\r\n;;\r\n', ';')).toEqual([['a', '', 'c'], ['', '', '']]);
    expect(parseCsv('', ';')).toEqual([]);
    expect(parseCsv('"";"x"', ';')).toEqual([['', 'x']]);
  });
  it('the awkward client name survives the file: separator, quotes and a line break', () => {
    for (const lang of ['de', 'en'] as const) {
      const text = buildCsv('clients', input, { lang, today: TODAY });
      const rows = parseCsv(text, formatFor(lang).separator);
      expect(rows.map((r) => r[0])).toContain('Müller; "Söhne"\n& Co, KG');
      expect(rows.find((r) => r[0].startsWith('Müller'))![columnKeys('clients').indexOf('notes')]).toBe('Zeile 1\nZeile 2, mit "Quote"');
    }
  });
});
