// Reads everything the CSV export needs (src/data/csv.ts is pure).
import type { CsvInput } from '@/data/csv';

import { listClients } from './clients';
import { listDocuments } from './documents';
import { listCatalogItems } from './items';
import type { DocumentLine } from './lines';
import type { Payment } from './payments';
import { fromRow } from './rows';
import type { Db } from './types';

export async function readCsvInput(db: Db): Promise<CsvInput> {
  const lines = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM document_lines ORDER BY document_id, position, id');
  const payments = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM payments ORDER BY date, id');
  return {
    documents: await listDocuments(db),
    lines: lines.map((r) => fromRow<DocumentLine>(r)),
    payments: payments.map((r) => fromRow<Payment>(r)),
    clients: await listClients(db, { includeArchived: true }),
    items: await listCatalogItems(db, { includeArchived: true }),
  };
}
