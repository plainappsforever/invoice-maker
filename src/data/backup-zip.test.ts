/**
 * @jest-environment node
 */
// Backup format 2 (V1.5 P1): a ZIP of backup.json + every referenced file. Round trip with photos, a PDF attachment,
// a drawn signature, a client signature, a shipping address; safety of the container.
import { strToU8, zipSync } from 'fflate';

import { addAttachment, setDocumentSignature } from '@/db/attachments';
import { updateBusiness } from '@/db/business';
import { updateClient } from '@/db/clients';
import { createCatalogItem } from '@/db/items';
import { addCatalogLine } from '@/db/editing';
import { issueDocument, newDraft } from '@/db/lifecycle';
import { LATEST_VERSION } from '@/db/migrations';
import { dataFingerprint, exportBackup, readAllData, replaceAllData } from '@/db/restore';
import { withRead } from '@/db/transaction';
import type { Db } from '@/db/types';
import { serializeSignature, signatureFromStrokes } from '@/engine/signature';

import { buildBackupZip, isZip, MAX_ZIP_FILE_BYTES, parseBackupBytes, referencedFiles, serializeBackup } from './backup';
import { emptyDb, NOW, seededDb } from './test-data';

const SIG = serializeSignature(signatureFromStrokes([[{ x: 0, y: 0 }, { x: 40, y: 12 }, { x: 80, y: 3 }]])!);
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

async function richDb(): Promise<{ db: Db; files: Record<string, Uint8Array> }> {
  const { db, ids } = await seededDb();
  await updateBusiness(db, { signature: SIG }, NOW);
  await updateClient(db, ids.kunde, { shipName: 'Lager', shipStreet: 'Kai 1', shipPostalCode: '20457', shipCity: 'Hamburg', shipCountryCode: 'DE' }, NOW);
  const item = await createCatalogItem(db, { name: 'Stuhl', priceE4: 1_000_000, taxRateBp: 1900, imageFile: 'items/stuhl.jpg' }, NOW);
  const draft = await newDraft(db, { type: 'invoice', clientId: ids.kunde, today: '2026-10-10', now: NOW });
  await addCatalogLine(db, draft, item);
  await addAttachment(db, draft, { file: 'attachments/beleg.jpg', mime: 'image/jpeg', bytes: 3000, width: 800, height: 1100 }, NOW);
  await addAttachment(db, draft, { file: 'attachments/plan.pdf', mime: 'application/pdf', bytes: 5000, name: 'Plan.pdf' }, NOW);
  const quote = (await db.getFirstAsync<{ id: number }>("SELECT id FROM documents WHERE type = 'quote' AND status <> 'draft' ORDER BY id LIMIT 1"))?.id;
  if (quote) await setDocumentSignature(db, quote, 'Eva Klein', SIG, NOW);
  const files = {
    'logo/abc123.png': bytes(500, 1),
    'items/stuhl.jpg': bytes(4000, 2),
    'attachments/beleg.jpg': bytes(3000, 3),
    'attachments/plan.pdf': bytes(5000, 4),
  };
  return { db, files };
}

describe('backup format 2 (ZIP)', () => {
  it('round trip: rows hash equal, every file byte-equal, nothing missing', async () => {
    const { db, files } = await richDb();
    const data = await withRead(db, readAllData);
    expect(referencedFiles(data)).toEqual(Object.keys(files).sort());
    const file = await exportBackup(db, { exportedAt: '2026-10-14T10:00:00.000Z' });
    const zip = buildBackupZip(file, files);
    expect(isZip(zip)).toBe(true);
    const parsed = parseBackupBytes(zip, LATEST_VERSION);
    if (!parsed.ok) throw new Error(parsed.error.detail);
    expect(parsed.plan).toEqual(expect.objectContaining({ formatVersion: 2, missingFiles: [], logoFiles: Object.keys(files).sort() }));
    for (const [name, b] of Object.entries(files)) expect(Buffer.from(parsed.binaries[name]).equals(Buffer.from(b))).toBe(true);
    const target = await emptyDb();
    await replaceAllData(target, parsed.file.data);
    expect(await dataFingerprint(target)).toBe(await dataFingerprint(db));
    expect(parsed.plan.hash).toBe(await dataFingerprint(db));
    expect((await target.getAllAsync('SELECT * FROM attachments')).length).toBe(2);
    expect((await target.getAllAsync('SELECT * FROM signatures')).length).toBe(1);
  });

  it('the same data gives the same ZIP bytes', async () => {
    const { db, files } = await richDb();
    const file = await exportBackup(db, { exportedAt: '2026-10-14T10:00:00.000Z' });
    expect(Buffer.from(buildBackupZip(file, files)).equals(Buffer.from(buildBackupZip(file, files)))).toBe(true);
  });

  it('an issued document keeps its printed photo in the backup after the item photo changed', async () => {
    const { db, ids } = await seededDb();
    const item = await createCatalogItem(db, { name: 'Lampe', priceE4: 10_000, taxRateBp: 1900, imageFile: 'items/old.jpg' }, NOW);
    const draft = await newDraft(db, { type: 'invoice', clientId: ids.kunde, today: '2026-10-10', now: NOW });
    await addCatalogLine(db, draft, item);
    await issueDocument(db, draft, { today: '2026-10-10', now: NOW });
    expect((await db.getFirstAsync<{ status: string }>('SELECT status FROM documents WHERE id = ?', draft))?.status).toBe('issued');
    await db.runAsync("UPDATE catalog_items SET image_file = 'items/new.jpg' WHERE id = ?", item);
    expect(referencedFiles(await withRead(db, readAllData))).toEqual(expect.arrayContaining(['items/old.jpg', 'items/new.jpg']));
  });

  it('a referenced file that the ZIP lacks is listed, not silently dropped', async () => {
    const { db, files } = await richDb();
    const { 'attachments/beleg.jpg': _gone, ...rest } = files;
    const parsed = parseBackupBytes(buildBackupZip(await exportBackup(db), rest), LATEST_VERSION);
    expect(parsed.ok && parsed.plan.missingFiles).toEqual(['attachments/beleg.jpg']);
  });

  it('format-1 JSON given as bytes still parses (v1.x backups)', async () => {
    const { db } = await seededDb();
    const text = serializeBackup({ ...(await exportBackup(db)), version: 1 });
    const parsed = parseBackupBytes(strToU8(text), LATEST_VERSION);
    expect(parsed.ok && parsed.plan.formatVersion).toBe(1);
  });

  it('refuses hostile or broken containers before writing anything', async () => {
    const { db } = await seededDb();
    const json = strToU8(serializeBackup(await exportBackup(db)));
    const cases: [string, Uint8Array][] = [
      ['path escape', zipSync({ 'backup.json': json, 'files/../../evil.png': bytes(10, 1) })],
      ['absolute', zipSync({ 'backup.json': json, '/etc/x.png': bytes(10, 1) })],
      ['odd folder', zipSync({ 'backup.json': json, 'files/secret/x.png': bytes(10, 1) })],
      ['odd type', zipSync({ 'backup.json': json, 'files/logo/x.exe': bytes(10, 1) })],
      ['no backup.json', zipSync({ 'files/logo/x.png': bytes(10, 1) })],
      ['too large', zipSync({ 'backup.json': json, 'files/logo/big.png': [new Uint8Array(MAX_ZIP_FILE_BYTES + 1), { level: 9 }] })],
      ['damaged', zipSync({ 'backup.json': json }).slice(0, 60)],
      ['not ours', zipSync({ 'backup.json': strToU8('{"format":"other"}') })],
      ['format 1 inside a ZIP', zipSync({ 'backup.json': strToU8(serializeBackup({ ...(JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>), version: 1 } as never)) })],
    ];
    for (const [name, zip] of cases) {
      const r = parseBackupBytes(zip, LATEST_VERSION);
      expect([name, r.ok]).toEqual([name, false]);
    }
  });

  it('refuses a hostile signature, a printed PDF page and a signature on an invoice', async () => {
    const { db } = await richDb();
    const file = await exportBackup(db);
    const variants: [string, (d: typeof file.data) => void][] = [
      ['script in signature', (d) => (d.business[0].signature = '{"v":1,"w":9,"h":9,"d":"M1 1\\"/><script>x</script>"}')],
      ['pdf as page', (d) => (d.attachments.find((a) => a.mime === 'application/pdf')!.use = 'page')],
      ['attachment file escape', (d) => (d.attachments[0].file = '../x.jpg')],
      ['signature on an invoice', (d) => (d.signatures[0].document_id = d.documents.find((x) => x.type === 'invoice' && x.status !== 'draft')!.id)],
    ];
    for (const [name, change] of variants) {
      const copy = JSON.parse(JSON.stringify(file)) as typeof file;
      change(copy.data);
      const r = parseBackupBytes(buildBackupZip(copy, {}), LATEST_VERSION);
      expect([name, r.ok]).toEqual([name, false]);
    }
  });
});
