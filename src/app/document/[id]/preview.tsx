import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button } from '@/components/button';
import { CheckPanel, useCheckFix } from '@/components/check-panel';
import { DocumentWeb } from '@/components/document-web';
import { SendActions } from '@/components/send-actions';
import { ThemedText } from '@/components/themed-text';
import { Chip, ChipRow, Screen, Section, SwitchRow } from '@/components/ui';
import { getDocument } from '@/db/documents';
import { patchDraft } from '@/db/editing';
import { checkStoredDocument, issueDocument, IssueBlockedError } from '@/db/lifecycle';
import { listLines } from '@/db/lines';
import { hasBlockingErrors, type CheckItem } from '@/engine/check';
import { todayLocal } from '@/engine/dates';
import { can } from '@/engine/status';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { documentHtml } from '@/lib/pdf';
import { TEMPLATE_IDS } from '@/render/html';

const ACCENTS = ['#1F4E79', '#0B7A4B', '#9B1C12', '#6A3FA0', '#B26A00', '#2B2F36'];

/**
 * Preview (SPEC §6, D24): the document exactly as the PDF shows it, the mandatory-details check with Fix (drafts),
 * Issue (drafts, same check path as the editor, D59), the layout of THIS document (drafts; issued documents keep
 * theirs, D68), and Share · E-mail · Print.
 */
export default function PreviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const router = useRouter();
  const busy = useRef(false);
  const [issuing, setIssuing] = useState(false);
  const { data, reload, db } = useLoader(async (db) => {
    const doc = await getDocument(db, docId);
    if (!doc) return null;
    const { model, html } = await documentHtml(db, docId);
    const draft = doc.status === 'draft';
    return {
      doc,
      model,
      html,
      lines: draft ? await listLines(db, docId) : [],
      items: draft ? await checkStoredDocument(db, docId, todayLocal()) : ([] as CheckItem[]),
    };
  });
  const fixItem = useCheckFix(docId, reload, 'editor');

  if (!data) return <Screen testID="preview-loading">{null}</Screen>;
  const { doc, model, html, lines, items } = data;
  const draft = doc.status === 'draft';
  const blocked = hasBlockingErrors(items);
  const set = (patch: Parameters<typeof patchDraft>[2]) => async () => {
    await patchDraft(db, docId, patch);
    await reload();
  };

  async function issue() {
    if (busy.current || blocked) return;
    busy.current = true;
    setIssuing(true);
    try {
      await issueDocument(db, docId, { today: todayLocal() });
      router.dismissAll(); // back to the list, then the issued document: "back" never returns to the editor
      router.push({ pathname: '/document/[id]', params: { id: String(docId) } });
    } catch (e) {
      if (e instanceof IssueBlockedError) await reload();
      else Alert.alert(t('editor.issueFailed'), errorText(e));
    } finally {
      busy.current = false;
      setIssuing(false);
    }
  }

  return (
    <Screen testID="preview-screen">
      <Stack.Screen options={{ title: t('preview.title') }} />
      {draft ? (
        <>
          <ThemedText type="small" themeColor="textSecondary" testID="preview-draft-note">{t('preview.draftNote')}</ThemedText>
          <Section title={t('preview.check')}>
            <View style={{ padding: 12 }}>
              <CheckPanel items={items} onFix={(item, choice) => fixItem(item, doc, lines, choice)} busy={issuing} />
            </View>
          </Section>
          <Button
            testID="preview-issue"
            label={items.length ? t('check.issueAnyway') : doc.type === 'quote' ? t('editor.issueQuote') : t('editor.issue')}
            disabled={blocked || issuing}
            onPress={issue}
          />
        </>
      ) : null}
      <SendActions docId={docId} issued={!draft} sentAt={doc.sentAt} canMarkSent={can(doc, 'markSent')} onChanged={reload} />
      {draft ? (
        <Section title={t('preview.layout')}>
          <ChipRow>
            {TEMPLATE_IDS.map((tpl) => (
              <Chip key={tpl} testID={`layout-template-${tpl}`} label={t(`docdefaults.template.${tpl}`)} selected={model.layout.template === tpl} onPress={set({ template: tpl })} />
            ))}
          </ChipRow>
          <ChipRow>
            <Chip testID="layout-paper-A4" label="A4" selected={model.layout.paper === 'A4'} onPress={set({ paper: 'A4' })} />
            <Chip testID="layout-paper-LETTER" label="Letter" selected={model.layout.paper === 'LETTER'} onPress={set({ paper: 'LETTER' })} />
          </ChipRow>
          <ChipRow>
            {ACCENTS.map((c) => (
              <Chip key={c} testID={`layout-accent-${c.slice(1)}`} label={c} selected={model.layout.accent.toLowerCase() === c.toLowerCase()} onPress={set({ accent: c })} />
            ))}
          </ChipRow>
          <SwitchRow testID="layout-logo-right" label={t('docdefaults.logoRight')} value={model.layout.logoRight} onValueChange={(v) => set({ logoRight: v })()} />
          {doc.type === 'invoice' ? (
            <SwitchRow testID="layout-girocode" label={t('docdefaults.girocode')} value={model.layout.showGirocode} onValueChange={(v) => set({ showGirocode: v })()} />
          ) : null}
        </Section>
      ) : (
        <ThemedText type="small" themeColor="textSecondary">{t('preview.layoutFrozen')}</ThemedText>
      )}
      <DocumentWeb testID="preview-web" html={html} paper={model.layout.paper} />
    </Screen>
  );
}
