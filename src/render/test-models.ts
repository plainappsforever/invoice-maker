// RenderModels for tests and the sample script: the worked examples A–F (SPEC §5) wrapped in a business and a
// client, plus a long 60-line invoice. Built with the real snapshot builder, so totals come from the engine.
import examples from '@/engine/__fixtures__/worked-examples.json';
import { defaultLegalNote } from '@/engine/notes';
import type { TaxCategory } from '@/engine/totals';
import type { Treatment, VatMode } from '@/engine/treatment';

import { buildRenderModel, type ModelBusiness, type ModelClient, type ModelDocument, type ModelLineInput, type RenderModel } from './model';

export const TEST_BUSINESS: ModelBusiness = {
  name: 'Muster Design GmbH',
  street: 'Hauptstraße 1',
  postalCode: '10115',
  city: 'Berlin',
  countryCode: 'DE',
  email: 'hallo@muster-design.example',
  phone: '+49 30 1234567',
  website: 'muster-design.example',
  taxNumber: '12/345/67890',
  vatId: 'DE123456789',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  bankName: 'Commerzbank',
  accountHolder: 'Muster Design GmbH',
  logoFile: null,
  vatMode: 'standard',
  footer: 'Amtsgericht Berlin HRB 123456 · Geschäftsführer: Max Muster',
};

export const TEST_CLIENT: ModelClient = {
  kind: 'business',
  name: 'Kunde & Söhne <GmbH>',
  contact: 'Frau Beispiel',
  street: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  countryCode: 'DE',
  email: 'einkauf@kunde.example',
  vatId: '',
  buyerReference: '',
};

const baseDoc = (over: Partial<ModelDocument> = {}): ModelDocument => ({
  type: 'invoice',
  receiptKind: null,
  issueDate: '2026-10-01',
  serviceMode: 'same',
  serviceFrom: null,
  serviceTo: null,
  dueDate: '2026-10-15',
  validUntil: null,
  paymentDays: 14,
  reference: '',
  buyerReference: '',
  currency: 'EUR',
  language: 'de',
  pricesIncludeVat: false,
  treatment: 'standard',
  discountKind: 'none',
  discountValue: 0,
  intro: '',
  notes: '',
  paymentText: '',
  footer: '',
  legalNote: '',
  customFields: '[]',
  template: 'classic',
  accent: '#1F4E79',
  logoRight: false,
  paper: 'A4',
  showGirocode: true,
  depositCents: null,
  ...over,
});

type ExampleLine = {
  name: string;
  qtyMilli: number;
  priceE4: number;
  category: TaxCategory;
  rateBp: number;
  discount: { kind: 'none' | 'percent' | 'amount'; value: number };
};

const lineInput = (l: ExampleLine): ModelLineInput => ({
  name: l.name,
  description: '',
  qtyMilli: l.qtyMilli,
  unitCode: 'C62',
  priceE4: l.priceE4,
  taxCategory: l.category,
  taxRateBp: l.rateBp,
  discountKind: l.discount.kind,
  discountValue: l.discount.value,
});

export type ExampleId = 'A' | 'B' | 'C' | 'D' | 'E1' | 'E2' | 'F';

/** The model of a worked example; `over` replaces document fields, `business`/`client` replace the parties. */
export function exampleModel(
  id: ExampleId,
  over: Partial<ModelDocument> = {},
  parties: { business?: Partial<ModelBusiness>; client?: Partial<ModelClient> | null } = {}
): RenderModel {
  const example = examples.examples.find((e) => e.id === id) as unknown as {
    id: string;
    document: { type: string; language: 'de' | 'en'; vatMode?: VatMode; treatment?: Treatment; legalNote?: string; number?: string; referenceText?: string };
    input?: { pricesIncludeVat: boolean; discount: { kind: 'none' | 'percent' | 'amount'; value: number }; lines: ExampleLine[] };
  };
  const vatMode: VatMode = example.document.vatMode ?? 'standard';
  const treatment: Treatment = example.document.treatment ?? 'standard';
  const language = example.document.language;
  const business: ModelBusiness = { ...TEST_BUSINESS, vatMode, ...(language === 'en' ? { footer: 'Registered in Berlin HRB 123456' } : {}), ...parties.business };
  const client: ModelClient | null =
    parties.client === null
      ? null
      : {
          ...TEST_CLIENT,
          ...(id === 'D' ? { name: 'Acme BV', street: 'Keizersgracht 1', postalCode: '1015 CJ', city: 'Amsterdam', countryCode: 'NL', vatId: 'NL123456789B01' } : {}),
          ...parties.client,
        };
  const legalNote = defaultLegalNote(treatment, vatMode, language);
  const doc = baseDoc({ language, treatment, legalNote, ...over });

  if (id === 'F') {
    const a = examples.examples.find((e) => e.id === 'A') as unknown as { input: { pricesIncludeVat: boolean; discount: { kind: 'none' | 'percent' | 'amount'; value: number }; lines: ExampleLine[] } };
    return buildRenderModel({
      doc: { ...doc, type: 'cancellation', serviceMode: 'date', serviceFrom: '2026-10-01', dueDate: null, intro: 'Stornorechnung zu Rechnung RE-2026-0001 vom 01.10.2026.', discountKind: a.input.discount.kind, discountValue: a.input.discount.value, ...over },
      number: 'RE-2026-0002',
      series: 'invoice',
      business,
      client,
      lines: a.input.lines.map((l) => lineInput({ ...l, qtyMilli: -l.qtyMilli })),
      source: { type: 'invoice', number: 'RE-2026-0001', issueDate: '2026-10-01' },
    });
  }
  const input = example.input!;
  return buildRenderModel({
    doc: {
      ...doc,
      pricesIncludeVat: input.pricesIncludeVat,
      discountKind: input.discount.kind,
      discountValue: input.discount.value,
      ...over,
    },
    number: example.document.number ?? (language === 'en' ? 'INV-2026-0001' : 'RE-2026-0001'),
    series: 'invoice',
    business,
    client,
    lines: input.lines.map(lineInput),
    source: null,
  });
}

/** `count` invoice lines, some with long descriptions (the pagination fixture, V1_PLAN P3). */
export function longInvoiceModel(count = 60, over: Partial<ModelDocument> = {}, long = true): RenderModel {
  const lines: ModelLineInput[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push({
      name: `Position ${i}: Webdesign und Pflege`,
      description:
        long && i % 3 === 0
          ? 'Ausführliche Beschreibung der Leistung mit mehreren Sätzen, damit die Zeile umbricht und mehr Platz braucht als eine einzelne Zeile. Dritter Satz mit weiteren Details zur Abrechnung und zum Umfang der Arbeiten.'
          : '',
      qtyMilli: 1000 + (i % 4) * 500,
      unitCode: i % 2 ? 'HUR' : 'C62',
      priceE4: 850_000 + i * 1_000,
      taxCategory: 'S',
      taxRateBp: i % 5 === 0 ? 700 : 1900,
      discountKind: i % 7 === 0 ? 'percent' : 'none',
      discountValue: i % 7 === 0 ? 1000 : 0,
    });
  }
  return buildRenderModel({
    doc: baseDoc({ intro: 'Vielen Dank für Ihren Auftrag. Wir berechnen wie folgt:', notes: 'Bitte beachten Sie unsere Allgemeinen Geschäftsbedingungen.', paymentText: 'Zahlbar ohne Abzug.', ...over }),
    number: 'RE-2026-0060',
    series: 'invoice',
    business: TEST_BUSINESS,
    client: TEST_CLIENT,
    lines,
    source: null,
  });
}
