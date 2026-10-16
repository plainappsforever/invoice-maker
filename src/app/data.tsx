import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Chip, ChipRow, Divider, Row, Screen, Section, SwitchRow } from '@/components/ui';
import { parseBackup, type BackupError, type BackupFile, type RestorePlan } from '@/data/backup';
import { CSV_KINDS, type CsvKind, type CsvPeriodChoice } from '@/data/csv';
import { planImport, readCsv, recordsToImport, type ClientImport, type ImportKind, type ImportPlan, type ItemImport } from '@/data/csv-import';
import { importClients, importItems, readImportExisting } from '@/db/import';
import { eraseAllData, resetNumbering } from '@/db/erase';
import { LATEST_VERSION } from '@/db/migrations';
import { dataCounts, dataFingerprint, previewRestoreBytes, restoreBackup } from '@/db/restore';
import { getSetting, setSetting } from '@/db/settings';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { isDevBuild } from '@/lib/debug';
import { deleteAppFiles, lastBackupFile, pickBackupBytes, pickCsvText, readBackupBytes, safetyCopy, shareFile, writeBackupFile, writeBackupFiles, writeCsvFile, writeSafetyCopy } from '@/lib/data-files';
import { dateLabel } from '@/lib/format';
import { sync } from '@/lib/reminders';

/** Development builds: a German client file with a duplicate row and an empty row, and an items file (Maestro). */
const SAMPLE_CLIENTS_CSV =
  '\uFEFFFirma;Vorname;Nachname;Straße;PLZ;Ort;Land;E-Mail\r\nBeta AG;Eva;Klein;Ring 5;1010;Wien;Österreich;eva@beta.at\r\n;Max;Muster;Gasse 2;10115;Berlin;;max@web.de\r\nBeta AG;Eva;Klein;Ring 5;1010;Wien;AT;eva@beta.at\r\n;;;;;;;\r\n';
const SAMPLE_ITEMS_CSV = 'Bezeichnung;Einheit;Preis;MwSt\r\nBeratung;Std;95,00;19\r\nFahrtkosten;km;0,30;19\r\n';

type Pending = { file: BackupFile; plan: RestorePlan & { phone?: { phoneOnlyNumbers: string[]; countersKept: unknown[] } }; binaries: Record<string, Uint8Array> };

const PERIODS: readonly CsvPeriodChoice[] = ['thisYear', 'lastYear', 'all'];

const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function countsText(plan: RestorePlan): string {
  const c = plan.counts;
  return t('data.restore.counts', {
    invoices: c.invoices,
    cancellations: c.cancellations,
    quotes: c.quotes,
    receipts: c.receipts,
    drafts: c.drafts,
    clients: c.clients,
    items: c.items,
    payments: c.payments,
  });
}

function errorReason(error: BackupError | { code: 'database'; detail: string }): string {
  return t(`data.restore.error.${error.code}`);
}

/** Settings → Backup & data (SPEC F10, §7 flows 7 and 8): back up, restore with a summary, CSV export, delete all. */
export default function DataScreen() {
  const { data, reload, db } = useLoader(async (db) => ({
    lastBackup: await getSetting(db, 'last_backup_at'),
    hash: isDevBuild ? await dataFingerprint(db) : '',
    safety: safetyCopy(),
  }));
  const [backupMessage, setBackupMessage] = useState('');
  const [restoreMessage, setRestoreMessage] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [period, setPeriod] = useState<CsvPeriodChoice>('thisYear');
  const [csvMessage, setCsvMessage] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [importPlan, setImportPlan] = useState<ImportPlan<ClientImport> | ImportPlan<ItemImport> | null>(null);
  const [importDuplicates, setImportDuplicates] = useState(false);
  const [importMessage, setImportMessage] = useState('');

  async function guarded(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  const backUp = () =>
    guarded(async () => {
      setBackupMessage('');
      try {
        const { file, name } = await writeBackupFile(db);
        await shareFile(file, 'application/zip', 'public.zip-archive');
        await setSetting(db, 'last_backup_at', String(Date.now()));
        setBackupMessage(t('data.backup.done', { name }));
        await reload();
      } catch (e) {
        setBackupMessage(t('data.backup.failed', { error: errorText(e) }));
      }
    });

  async function review(bytes: Uint8Array) {
    const result = await previewRestoreBytes(db, bytes);
    if (!result.ok) {
      setPending(null);
      setRestoreMessage(t('data.restore.invalid', { reason: errorReason(result.error) }));
      return;
    }
    setRestoreMessage('');
    setPending({ file: result.file, plan: result.plan, binaries: result.binaries });
  }

  const pickRestore = () =>
    guarded(async () => {
      setRestoreMessage('');
      const picked = await pickBackupBytes();
      if (picked.canceled) return;
      if ('error' in picked) {
        setRestoreMessage(t('data.restore.invalid', { reason: t('data.restore.error.notReadable') }));
        return;
      }
      await review(picked.bytes);
    });

  const pickLast = () =>
    guarded(async () => {
      const file = lastBackupFile();
      if (!file) {
        setRestoreMessage('no backup file made on this phone yet');
        return;
      }
      await review(await readBackupBytes(file));
    });

  const pickSafety = () =>
    guarded(async () => {
      const copy = safetyCopy();
      if (copy) await review(await readBackupBytes(copy.file));
    });

  const confirmRestore = () =>
    guarded(async () => {
      if (!pending) return;
      const parsed = parseBackup(JSON.stringify(pending.file), LATEST_VERSION);
      if (!parsed.ok) {
        setRestoreMessage(t('data.restore.invalid', { reason: errorReason(parsed.error) }));
        return;
      }
      try {
        // The data the restore replaces is kept as the safety copy first; if that fails, nothing is replaced (D92).
        const counts = await dataCounts(db);
        await writeSafetyCopy(db, counts.documents + counts.clients > 0);
      } catch (e) {
        setRestoreMessage(t('data.safety.failed', { error: errorText(e) }));
        return;
      }
      try {
        writeBackupFiles(parsed.file.files, pending.binaries);
        const result = await restoreBackup(db, parsed.file);
        if (!result.ok) {
          setRestoreMessage(t('data.restore.failed', { error: errorReason(result.error) }));
          return;
        }
        setPending(null);
        setDeleteMessage('');
        setRestoreMessage(t('data.restore.done', { counts: countsText(result.plan) }));
        await sync(db).catch(() => undefined);
        await reload();
      } catch (e) {
        setRestoreMessage(t('data.restore.failed', { error: errorText(e) }));
      }
    });

  const exportCsv = (kind: CsvKind) =>
    guarded(async () => {
      setCsvMessage('');
      try {
        const file = await writeCsvFile(db, kind, period);
        await shareFile(file, 'text/csv', 'public.comma-separated-values-text');
        setCsvMessage(t('data.export.done', { name: file.name }));
      } catch (e) {
        setCsvMessage(t('data.export.failed', { error: errorText(e) }));
      }
    });

  // CSV import (V1.5 P1, Idea-b): pick → preview (counts, problems, duplicates) → one transaction.
  async function previewImport(kind: ImportKind, text: string) {
    const read = readCsv(text);
    if (!read.ok) {
      setImportPlan(null);
      setImportMessage(t(`import.error.${read.error}`));
      return;
    }
    const existing = await readImportExisting(db);
    setImportDuplicates(false);
    setImportMessage('');
    setImportPlan(kind === 'clients' ? planImport(read, 'clients', existing) : planImport(read, 'items', existing));
  }

  const pickImport = (kind: ImportKind) =>
    guarded(async () => {
      setImportMessage('');
      const picked = await pickCsvText();
      if (picked.canceled) return;
      if ('error' in picked) {
        setImportMessage(t('import.error.notReadable'));
        return;
      }
      await previewImport(kind, picked.text);
    });

  const confirmImport = () =>
    guarded(async () => {
      if (!importPlan) return;
      try {
        const n =
          importPlan.kind === 'clients'
            ? (await importClients(db, recordsToImport(importPlan as ImportPlan<ClientImport>, importDuplicates))).length
            : (await importItems(db, recordsToImport(importPlan as ImportPlan<ItemImport>, importDuplicates))).length;
        setImportPlan(null);
        setImportMessage(t(importPlan.kind === 'clients' ? 'import.doneClients' : 'import.doneItems', { n }));
      } catch (e) {
        setImportMessage(t('import.failed', { error: errorText(e) }));
      }
    });

  async function deleteEverything() {
    try {
      await eraseAllData(db);
      deleteAppFiles();
      setPending(null);
      setBackupMessage('');
      setRestoreMessage('');
      setDeleteMessage(t('data.delete.done'));
      await sync(db).catch(() => undefined);
      await reload();
    } catch (e) {
      setDeleteMessage(t('data.delete.failed', { error: errorText(e) }));
    }
  }

  async function askDelete() {
    const counts = await dataCounts(db);
    Alert.alert(t('data.delete.step1Title'), t('data.delete.step1Body', { docs: counts.documents, clients: counts.clients }), [
      { text: t('action.cancel'), style: 'cancel' },
      {
        text: t('data.delete.step1Next'),
        style: 'destructive',
        onPress: () =>
          Alert.alert(t('data.delete.step2Title'), t('data.delete.step2Body'), [
            { text: t('action.cancel'), style: 'cancel' },
            { text: t('data.delete.confirm'), style: 'destructive', onPress: () => void deleteEverything() },
          ]),
      },
    ]);
  }

  function askResetNumbering() {
    Alert.alert(t('data.resetNumbering.title'), t('data.resetNumbering.body'), [
      { text: t('action.cancel'), style: 'cancel' },
      {
        text: t('data.resetNumbering.confirm'),
        style: 'destructive',
        onPress: async () => {
          await resetNumbering(db);
          setDeleteMessage(t('data.resetNumbering.done'));
        },
      },
    ]);
  }

  const last = data?.lastBackup ? new Date(Number(data.lastBackup)) : null;
  const lastText = last ? dateLabel(`${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`) : t('data.backup.never');

  return (
    <Screen testID="data-screen">
      <Stack.Screen options={{ title: t('settings.data') }} />
      <Section title={t('data.backup.title')} hint={t('data.backup.hint')}>
        <Row testID="last-backup" title={t('data.backup.last')} value={lastText} />
        <View style={{ padding: 16, gap: 8 }}>
          <Button testID="backup-now" label={t('data.backup.action')} onPress={backUp} disabled={busy} />
          <ThemedText type="small" themeColor="textSecondary" testID="backup-message">{backupMessage}</ThemedText>
        </View>
      </Section>

      <Section title={t('data.restore.title')} hint={t('data.restore.hint')}>
        <View style={{ padding: 16, gap: 8 }}>
          <Button testID="restore-pick" variant="secondary" label={t('data.restore.action')} onPress={pickRestore} disabled={busy} />
          {isDevBuild ? <Button testID="restore-dev-last" variant="secondary" label="Dev: use the last backup made on this phone" onPress={pickLast} disabled={busy} /> : null}
          {data?.safety ? (
            <>
              <Button testID="restore-safety" variant="secondary" label={t('data.safety.action')} onPress={pickSafety} disabled={busy} />
              <ThemedText type="small" themeColor="textSecondary" testID="safety-hint">
                {t('data.safety.hint', { date: data.safety.modified ? dateLabel(isoDay(data.safety.modified)) : '' })}
              </ThemedText>
            </>
          ) : null}
          <ThemedText type="small" themeColor="textSecondary" testID="restore-message">{restoreMessage}</ThemedText>
        </View>
      </Section>
      {pending ? (
        <Section title={t('data.restore.summaryTitle')}>
          <View style={{ padding: 16, gap: 8 }} testID="restore-summary">
            <ThemedText testID="restore-counts">{countsText(pending.plan)}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {t('data.restore.date', { date: dateLabel(pending.plan.exportedAt.slice(0, 10)) })}
            </ThemedText>
            {pending.plan.phone && pending.plan.phone.phoneOnlyNumbers.length > 0 ? (
              <ThemedText type="small" testID="restore-phone-newer">{t('restore.phoneNewer', { numbers: pending.plan.phone.phoneOnlyNumbers.join(', ') })}</ThemedText>
            ) : null}
            {pending.plan.phone && pending.plan.phone.countersKept.length > 0 ? (
              <ThemedText type="small" testID="restore-counters-kept">{t('restore.countersKept')}</ThemedText>
            ) : null}
            {pending.plan.logoFiles.length > 0 ? (
              <ThemedText type="small" testID="restore-files">{t('data.restore.files', { n: pending.plan.logoFiles.length })}</ThemedText>
            ) : null}
            {pending.plan.missingFiles.length > 0 ? (
              <ThemedText type="small" testID="restore-missing-files">{t('data.restore.missingFiles', { n: pending.plan.missingFiles.length })}</ThemedText>
            ) : null}
            <ThemedText type="smallBold">{t('data.restore.replaces')}</ThemedText>
            <Button testID="restore-confirm" label={t('data.restore.confirm')} onPress={confirmRestore} disabled={busy} />
            <Button testID="restore-cancel" variant="secondary" label={t('data.restore.cancel')} onPress={() => setPending(null)} disabled={busy} />
          </View>
        </Section>
      ) : null}

      <Section title={t('data.export.title')} hint={t('data.export.hint')}>
        <ChipRow>
          {PERIODS.map((p) => (
            <Chip key={p} testID={`csv-period-${p}`} label={t(`data.export.${p}`)} selected={period === p} onPress={() => setPeriod(p)} />
          ))}
        </ChipRow>
        {CSV_KINDS.map((kind, i) => (
          <View key={kind}>
            {i > 0 ? <Divider /> : null}
            <Row testID={`csv-${kind}`} title={t(`data.export.${kind}`)} onPress={() => void exportCsv(kind)} />
          </View>
        ))}
        <ThemedText type="small" themeColor="textSecondary" style={{ padding: 16 }} testID="csv-message">{csvMessage}</ThemedText>
      </Section>

      <Section title={t('import.title')} hint={t('import.hint')}>
        <Row testID="import-clients" title={t('import.clients')} onPress={() => void pickImport('clients')} />
        <Divider />
        <Row testID="import-items" title={t('import.items')} onPress={() => void pickImport('items')} />
        {isDevBuild ? (
          <>
            <Divider />
            <Row testID="import-sample-clients" title="Sample clients CSV (dev)" onPress={() => void guarded(() => previewImport('clients', SAMPLE_CLIENTS_CSV))} />
            <Divider />
            <Row testID="import-sample-items" title="Sample items CSV (dev)" onPress={() => void guarded(() => previewImport('items', SAMPLE_ITEMS_CSV))} />
          </>
        ) : null}
        {importPlan ? (
          <View style={{ padding: 16, gap: 8 }} testID="import-preview">
            <ThemedText type="smallBold" testID="import-summary">
              {t('import.summary', { ready: importPlan.counts.ready, duplicates: importPlan.counts.duplicates, skipped: importPlan.counts.skipped })}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" testID="import-columns">
              {t('import.columns', { columns: importPlan.header.map((h, i) => (importPlan.mapping[i] ? h : `${h} (–)`)).join(', ') })}
            </ThemedText>
            {importPlan.rows
              .filter((r) => r.problems.length > 0)
              .slice(0, 5)
              .map((r) => (
                <ThemedText key={r.line} type="small" testID={`import-problem-${r.line}`}>
                  {t('import.problemLine', { line: r.line, problems: r.problems.map((p) => t(`import.problem.${p}`)).join(', ') })}
                </ThemedText>
              ))}
            {importPlan.counts.duplicates > 0 ? (
              <SwitchRow testID="import-include-duplicates" label={t('import.includeDuplicates', { n: importPlan.counts.duplicates })} value={importDuplicates} onValueChange={setImportDuplicates} />
            ) : null}
            <Button
              testID="import-confirm"
              label={t('import.confirm', { n: importPlan.counts.ready + (importDuplicates ? importPlan.counts.duplicates : 0) })}
              onPress={confirmImport}
              disabled={busy || importPlan.counts.ready + (importDuplicates ? importPlan.counts.duplicates : 0) === 0}
            />
            <Button testID="import-cancel" variant="secondary" label={t('action.cancel')} onPress={() => setImportPlan(null)} disabled={busy} />
          </View>
        ) : null}
        {importMessage ? <ThemedText type="small" style={{ padding: 16 }} testID="import-message">{importMessage}</ThemedText> : null}
      </Section>

      <Section title={t('data.delete.title')} hint={t('data.delete.hint')}>
        <View style={{ padding: 16, gap: 8 }}>
          <Button testID="delete-all" variant="secondary" label={t('data.delete.action')} onPress={() => void askDelete()} disabled={busy} />
          <Button testID="reset-numbering" variant="secondary" label={t('data.resetNumbering.action')} onPress={askResetNumbering} disabled={busy} />
          <ThemedText type="small" themeColor="textSecondary" testID="delete-message">{deleteMessage}</ThemedText>
        </View>
      </Section>
      {isDevBuild ? <ThemedText type="small" testID="data-hash">{`DATA hash=${data?.hash ?? ''}`}</ThemedText> : null}
    </Screen>
  );
}
