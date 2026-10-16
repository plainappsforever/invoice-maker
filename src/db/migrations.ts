import { exclusive } from './transaction';
import type { Db } from './types';

// Append-only. Never edit a migration that has shipped; add a new one instead.
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   );`,
  // 2 (v1 P1): Invoice Maker data model (V1_PLAN "Architecture → Data"). Replaces the template demo table.
  `DROP TABLE items;
   CREATE TABLE business (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     name TEXT NOT NULL DEFAULT '', street TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '',
     city TEXT NOT NULL DEFAULT '', country_code TEXT NOT NULL DEFAULT 'DE',
     email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
     tax_number TEXT NOT NULL DEFAULT '', vat_id TEXT NOT NULL DEFAULT '',
     iban TEXT NOT NULL DEFAULT '', bic TEXT NOT NULL DEFAULT '', bank_name TEXT NOT NULL DEFAULT '',
     account_holder TEXT NOT NULL DEFAULT '', logo_file TEXT,
     vat_mode TEXT NOT NULL DEFAULT 'standard' CHECK (vat_mode IN ('standard','small_business')),
     currency TEXT NOT NULL DEFAULT 'EUR', language TEXT NOT NULL DEFAULT 'de' CHECK (language IN ('de','en')),
     payment_days INTEGER NOT NULL DEFAULT 14, footer TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL
   );
   INSERT INTO business (id, updated_at) VALUES (1, 0);
   CREATE TABLE tax_rates (
     id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, rate_bp INTEGER NOT NULL,
     is_default INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO tax_rates (label, rate_bp, is_default, sort) VALUES ('19 %', 1900, 1, 0), ('7 %', 700, 0, 1), ('0 %', 0, 0, 2);
   CREATE TABLE clients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL DEFAULT 'business' CHECK (kind IN ('business','person')),
     name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', street TEXT NOT NULL DEFAULT '',
     postal_code TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', country_code TEXT NOT NULL DEFAULT 'DE',
     email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', vat_id TEXT NOT NULL DEFAULT '',
     buyer_reference TEXT NOT NULL DEFAULT '',
     treatment TEXT NOT NULL DEFAULT 'standard'
       CHECK (treatment IN ('standard','reverse_charge','intra_eu_goods','export','exempt')),
     language TEXT, currency TEXT, payment_days INTEGER, notes TEXT NOT NULL DEFAULT '',
     archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE TABLE catalog_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     unit_code TEXT NOT NULL DEFAULT 'C62', sku TEXT NOT NULL DEFAULT '',
     price_e4 INTEGER NOT NULL DEFAULT 0, price_includes_vat INTEGER NOT NULL DEFAULT 0,
     tax_category TEXT NOT NULL DEFAULT 'S', tax_rate_bp INTEGER NOT NULL DEFAULT 1900,
     archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE TABLE documents (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     type TEXT NOT NULL CHECK (type IN ('invoice','quote','receipt','cancellation')),
     receipt_kind TEXT CHECK (receipt_kind IN ('payment','cash')),
     status TEXT NOT NULL DEFAULT 'draft'
       CHECK (status IN ('draft','issued','cancelled','accepted','declined','invoiced')),
     series TEXT, number TEXT,
     client_id INTEGER REFERENCES clients(id),
     issue_date TEXT NOT NULL,
     service_mode TEXT NOT NULL DEFAULT 'same' CHECK (service_mode IN ('same','date','period','month','none')),
     service_from TEXT, service_to TEXT, due_date TEXT, valid_until TEXT, payment_days INTEGER,
     reference TEXT NOT NULL DEFAULT '', buyer_reference TEXT NOT NULL DEFAULT '',
     currency TEXT NOT NULL DEFAULT 'EUR', language TEXT NOT NULL DEFAULT 'de',
     prices_include_vat INTEGER NOT NULL DEFAULT 0, treatment TEXT NOT NULL DEFAULT 'standard',
     discount_kind TEXT NOT NULL DEFAULT 'none' CHECK (discount_kind IN ('none','percent','amount')),
     discount_value INTEGER NOT NULL DEFAULT 0,
     intro TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', payment_text TEXT NOT NULL DEFAULT '',
     footer TEXT NOT NULL DEFAULT '', legal_note TEXT NOT NULL DEFAULT '',
     custom_fields TEXT NOT NULL DEFAULT '[]',
     template TEXT NOT NULL DEFAULT 'classic', accent TEXT NOT NULL DEFAULT '#1F4E79', logo_right INTEGER NOT NULL DEFAULT 0,
     paper TEXT NOT NULL DEFAULT 'A4' CHECK (paper IN ('A4','LETTER')), show_girocode INTEGER NOT NULL DEFAULT 1,
     deposit_cents INTEGER,
     source_id INTEGER REFERENCES documents(id),
     net_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, gross_cents INTEGER NOT NULL DEFAULT 0,
     snapshot TEXT, pdf_file TEXT,
     sent_at INTEGER, issued_at INTEGER, cancelled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     UNIQUE (series, number)
   );
   CREATE TABLE document_lines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     position INTEGER NOT NULL, catalog_item_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL,
     name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     qty_milli INTEGER NOT NULL, unit_code TEXT NOT NULL DEFAULT 'C62', price_e4 INTEGER NOT NULL,
     tax_category TEXT NOT NULL DEFAULT 'S' CHECK (tax_category IN ('S','Z','E','AE','K','G','O')),
     tax_rate_bp INTEGER NOT NULL,
     discount_kind TEXT NOT NULL DEFAULT 'none' CHECK (discount_kind IN ('none','percent','amount')),
     discount_value INTEGER NOT NULL DEFAULT 0, net_cents INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
     method TEXT NOT NULL DEFAULT 'bank' CHECK (method IN ('bank','cash','card','paypal','other')),
     note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
   );
   CREATE TABLE number_counters (
     series_key TEXT PRIMARY KEY NOT NULL, next_value INTEGER NOT NULL,
     max_used INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX documents_type_status ON documents(type, status);
   CREATE INDEX documents_client ON documents(client_id);
   CREATE INDEX lines_document ON document_lines(document_id, position);
   CREATE INDEX payments_document ON payments(document_id);
   CREATE TRIGGER documents_locked_update
     BEFORE UPDATE OF type, receipt_kind, series, number, client_id, issue_date, service_mode, service_from,
       service_to, due_date, valid_until, payment_days, reference, buyer_reference, currency, language,
       prices_include_vat, treatment, discount_kind, discount_value, intro, notes, payment_text, footer,
       legal_note, custom_fields, template, accent, logo_right, paper, show_girocode, deposit_cents, source_id,
       net_cents, tax_cents, gross_cents, snapshot, issued_at, created_at
     ON documents WHEN OLD.status <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TRIGGER documents_locked_delete BEFORE DELETE ON documents
     WHEN OLD.status <> 'draft' AND OLD.type IN ('invoice','receipt','cancellation')
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TRIGGER lines_locked_insert BEFORE INSERT ON document_lines
     WHEN (SELECT status FROM documents WHERE id = NEW.document_id) <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TRIGGER lines_locked_update BEFORE UPDATE ON document_lines
     WHEN (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
       OR (SELECT status FROM documents WHERE id = NEW.document_id) <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TRIGGER lines_locked_delete BEFORE DELETE ON document_lines
     WHEN (SELECT status FROM documents WHERE id = OLD.document_id) IN ('issued','cancelled','invoiced')
       AND (SELECT type FROM documents WHERE id = OLD.document_id) IN ('invoice','receipt','cancellation')
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;`,
  // 3 (v1 P3.5, review #10): the status of a locked document never goes back to draft (that would unlock all
  // the other triggers). The one allowed way back is reopening an issued quote (D38).
  `CREATE TRIGGER documents_locked_status
     BEFORE UPDATE OF status ON documents
     WHEN OLD.status <> 'draft' AND NEW.status = 'draft' AND NOT (OLD.type = 'quote' AND OLD.status = 'issued')
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;`,
  // 4 (v1.1, review #12, D86): raw SQL may only make the status moves of the transition table (src/engine/status.ts):
  // Issue (draft → issued), Storno (invoice issued → cancelled), quote issued → accepted/declined/draft (reopen),
  // accepted → invoiced and back (convert undone by deleting the invoice draft). A cancelled invoice can no longer be
  // set back to issued. Lines of an issued invoice, receipt or cancellation can never be deleted, whatever its status.
  `CREATE TRIGGER documents_status_moves
     BEFORE UPDATE OF status ON documents
     WHEN NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'issued')
       OR (OLD.type = 'invoice' AND OLD.status = 'issued' AND NEW.status = 'cancelled')
       OR (OLD.type = 'quote' AND OLD.status = 'issued' AND NEW.status IN ('accepted', 'declined', 'draft'))
       OR (OLD.type = 'quote' AND OLD.status = 'accepted' AND NEW.status = 'invoiced')
       OR (OLD.type = 'quote' AND OLD.status = 'invoiced' AND NEW.status = 'accepted')
     )
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   DROP TRIGGER lines_locked_delete;
   CREATE TRIGGER lines_locked_delete BEFORE DELETE ON document_lines
     WHEN (SELECT type FROM documents WHERE id = OLD.document_id) IN ('invoice','receipt','cancellation')
       AND (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;`,
  // 5 (V1.5 P1 "Capture"): shipping address on the client (L141-a), a photo on catalog items and document lines
  // (L153-a), the business's drawn signature (L140-a), attachments on documents (N3) and the client's signature on a
  // quote (L140-a). Files live under the app's document folder; rows hold relative names (like business.logo_file).
  // Attachments printed as pages of an issued document are part of its PDF: they can be neither removed nor switched
  // off, and a document that is no longer a draft only takes new attachments that are not printed.
  `ALTER TABLE clients ADD COLUMN ship_name TEXT NOT NULL DEFAULT '';
   ALTER TABLE clients ADD COLUMN ship_street TEXT NOT NULL DEFAULT '';
   ALTER TABLE clients ADD COLUMN ship_postal_code TEXT NOT NULL DEFAULT '';
   ALTER TABLE clients ADD COLUMN ship_city TEXT NOT NULL DEFAULT '';
   ALTER TABLE clients ADD COLUMN ship_country_code TEXT NOT NULL DEFAULT '';
   ALTER TABLE catalog_items ADD COLUMN image_file TEXT;
   ALTER TABLE document_lines ADD COLUMN image_file TEXT;
   ALTER TABLE business ADD COLUMN signature TEXT;
   CREATE TABLE attachments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     file TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','application/pdf')),
     width INTEGER, height INTEGER,
     bytes INTEGER NOT NULL CHECK (bytes >= 0),
     use TEXT NOT NULL DEFAULT 'page' CHECK (use IN ('page','mail','keep')),
     position INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     CHECK (use <> 'page' OR mime <> 'application/pdf')
   );
   CREATE INDEX attachments_document ON attachments(document_id, position);
   CREATE TRIGGER attachments_locked_insert BEFORE INSERT ON attachments
     WHEN NEW.use = 'page' AND (SELECT status FROM documents WHERE id = NEW.document_id) <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TRIGGER attachments_locked_update BEFORE UPDATE ON attachments
     WHEN (OLD.use = 'page' OR NEW.use = 'page') AND (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
       AND (NEW.use IS NOT OLD.use OR NEW.file IS NOT OLD.file OR NEW.document_id IS NOT OLD.document_id
         OR NEW.position IS NOT OLD.position OR NEW.mime IS NOT OLD.mime OR NEW.width IS NOT OLD.width OR NEW.height IS NOT OLD.height)
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TRIGGER attachments_locked_delete BEFORE DELETE ON attachments
     WHEN OLD.use = 'page' AND (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'document_locked'); END;
   CREATE TABLE signatures (
     document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
     signer TEXT NOT NULL DEFAULT '',
     data TEXT NOT NULL,
     signed_at INTEGER NOT NULL
   );`,
];

export const LATEST_VERSION = MIGRATIONS.length;

/** Call when the database opens (and in the Node fake): SQLite leaves foreign keys off by default. */
export async function openDatabase(db: Db): Promise<void> {
  await exclusive(db, (tx) => tx.execAsync('PRAGMA foreign_keys = ON;')); // queued: never inside another handle's transaction
  await migrate(db);
}

/** Runs the missing migrations, each in its own transaction (a failing one is rolled back and rethrown). */
export function migrate(db: Db): Promise<void> {
  return exclusive(db, async (db) => {
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    let version = row?.user_version ?? 0;
    while (version < MIGRATIONS.length) {
      await db.execAsync('BEGIN;');
      try {
        await db.execAsync(`${MIGRATIONS[version]} PRAGMA user_version = ${version + 1};`);
        await db.execAsync('COMMIT;');
      } catch (error) {
        await db.execAsync('ROLLBACK;').catch(() => undefined);
        throw error;
      }
      version++;
    }
  });
}
