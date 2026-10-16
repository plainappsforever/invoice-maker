// Attachments of a document (V1.5 P1, N3): scan a receipt or letter, pick photos or a file. Each attachment is printed as
// a page after the document ("Page"), sent as its own file with the e-mail ("E-mail"), or only kept here ("Keep").
// Once a document is issued, its printed pages are part of its PDF and stay (DB triggers, D20); new attachments of an
// issued document can be e-mailed or kept.
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Chip, ChipRow, Divider, Section } from '@/components/ui';
import {
  addAttachment,
  AttachmentLimitError,
  deleteAttachment,
  listAttachments,
  setAttachmentUse,
  type Attachment,
  type AttachmentUse,
} from '@/db/attachments';
import { isLockedError } from '@/db/types';
import { t } from '@/i18n';
import { ATTACHMENT_MAX_PX, pick, removeStored, storedUri, storeImage, storePdf, type CaptureSource } from '@/lib/capture';
import { fixtureImage, isDevBuild } from '@/lib/debug';
import { errorText } from '@/lib/errors';

const USES: readonly AttachmentUse[] = ['page', 'mail', 'keep'];

function limitText(e: unknown): string {
  if (e instanceof AttachmentLimitError) return t(`attach.limit.${e.reason}`);
  if (isLockedError(e)) return t('attach.locked');
  return errorText(e);
}

export function AttachmentsSection({ docId, draft, onChanged }: { docId: number; draft: boolean; onChanged?: () => void }) {
  const db = useSQLiteContext();
  const [items, setItems] = useState<Attachment[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setItems(await listAttachments(db, docId)), [db, docId]);
  useFocusEffect(
    useCallback(() => {
      reload().catch(() => undefined);
    }, [reload])
  );
  const changed = async () => {
    await reload();
    onChanged?.();
  };

  async function add(source: CaptureSource | 'fixture') {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      let files: { uri: string; kind: 'image' | 'pdf'; name?: string }[] = [];
      if (source === 'fixture') {
        const uri = await fixtureImage('receipt');
        if (uri) files = [{ uri, kind: 'image', name: 'Beleg' }];
      } else {
        const picked = await pick(source, 6);
        if (picked.status === 'cancel') return;
        if (picked.status === 'error') {
          setMessage(t(picked.message));
          return;
        }
        files = picked.files;
      }
      let added = 0;
      for (const f of files) {
        const stored = f.kind === 'pdf' ? await storePdf(f.uri, f.name ?? '') : await storeImage(f.uri, 'attachments', ATTACHMENT_MAX_PX, '');
        try {
          await addAttachment(db, docId, { ...stored, use: f.kind === 'pdf' || !draft ? 'mail' : 'page' });
          added++;
        } catch (e) {
          removeStored(stored.file); // the file this tap just stored; the row was refused
          setMessage(limitText(e));
          break;
        }
      }
      if (added) await changed();
    } catch (e) {
      setMessage(limitText(e));
    } finally {
      setBusy(false);
    }
  }

  async function setUse(a: Attachment, use: AttachmentUse) {
    setMessage(null);
    try {
      await setAttachmentUse(db, a.id, use);
      await changed();
    } catch (e) {
      setMessage(limitText(e));
    }
  }

  function remove(a: Attachment) {
    Alert.alert(t('attach.removeTitle'), t('attach.removeBody'), [
      { text: t('action.cancel'), style: 'cancel' },
      {
        text: t('action.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            const file = await deleteAttachment(db, a.id);
            removeStored(file);
            await changed();
          } catch (e) {
            setMessage(limitText(e));
          }
        },
      },
    ]);
  }

  return (
    <Section title={t('attach.title')} hint={draft ? t('attach.hint') : t('attach.hintIssued')}>
      {items.map((a, i) => {
        const locked = !draft && a.use === 'page';
        const uri = a.mime === 'application/pdf' ? null : storedUri(a.file);
        return (
          <View key={a.id} testID={`attach-${i}`}>
            {i > 0 ? <Divider /> : null}
            <View style={{ flexDirection: 'row', gap: 12, padding: 12, alignItems: 'center' }}>
              {uri ? (
                <Image source={{ uri }} style={{ width: 56, height: 56, borderRadius: 6 }} contentFit="cover" />
              ) : (
                <View style={{ width: 56, height: 56, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e5e5ea' }}>
                  <ThemedText type="smallBold">PDF</ThemedText>
                </View>
              )}
              <View style={{ flex: 1, gap: 4 }}>
                <ThemedText type="small" testID={`attach-${i}-label`}>
                  {`${a.name || t('attach.item', { n: i + 1 })} · ${t(`attach.use.${a.use}`)}`}
                </ThemedText>
                {locked ? (
                  <ThemedText type="small" themeColor="textSecondary">{t('attach.inPdf')}</ThemedText>
                ) : (
                  <ChipRow>
                    {USES.filter((u) => a.mime !== 'application/pdf' || u !== 'page').filter((u) => draft || u !== 'page').map((u) => (
                      <Chip key={u} testID={`attach-${i}-use-${u}`} label={t(`attach.use.${u}`)} selected={a.use === u} onPress={() => setUse(a, u)} />
                    ))}
                  </ChipRow>
                )}
              </View>
              {!locked ? (
                <Button testID={`attach-${i}-remove`} variant="secondary" label={t('attach.remove')} onPress={() => remove(a)} />
              ) : null}
            </View>
          </View>
        );
      })}
      <View style={{ padding: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button testID="attach-scan" variant="secondary" label={t('attach.scan')} onPress={() => add('scan')} disabled={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button testID="attach-photos" variant="secondary" label={t('attach.photos')} onPress={() => add('photos')} disabled={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button testID="attach-file" variant="secondary" label={t('attach.file')} onPress={() => add('file')} disabled={busy} />
          </View>
        </View>
        {isDevBuild ? <Button testID="attach-sample" variant="secondary" label="Sample receipt (dev)" onPress={() => add('fixture')} disabled={busy} /> : null}
        {message ? <ThemedText type="small" testID="attach-message">{message}</ThemedText> : null}
      </View>
    </Section>
  );
}
