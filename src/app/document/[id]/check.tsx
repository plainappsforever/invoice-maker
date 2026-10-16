import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button } from '@/components/button';
import { CheckPanel, useCheckFix, type ServiceChoice } from '@/components/check-panel';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/ui';
import { getDocument } from '@/db/documents';
import { checkStoredDocument, issueDocument, IssueBlockedError } from '@/db/lifecycle';
import { listLines } from '@/db/lines';
import { todayLocal } from '@/engine/dates';
import { hasBlockingErrors, type CheckItem } from '@/engine/check';
import { useLoader } from '@/hooks/use-loader';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';

/**
 * The mandatory-details check before Issue (SPEC §6/§7 flow 1): what is missing, with the source and a Fix button.
 * Only errors block (D21); with warnings the button says "Issue anyway". The §19 VAT block has the one-tap fix (D51).
 */
export default function CheckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const docId = Number(id);
  const router = useRouter();
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const { data, reload, db } = useLoader(async (db) => ({
    items: await checkStoredDocument(db, docId, todayLocal()),
    doc: await getDocument(db, docId),
    lines: await listLines(db, docId),
  }));

  const fixItem = useCheckFix(docId, reload, 'back');

  useEffect(() => {
    if (data?.doc && data.doc.status !== 'draft') router.replace({ pathname: '/document/[id]', params: { id: String(docId) } });
  }, [data, docId, router]);

  if (!data?.doc) return <Screen testID="check-loading">{null}</Screen>;
  const { items, doc, lines } = data;
  const blocked = hasBlockingErrors(items);
  const fix = (item: CheckItem, choice?: ServiceChoice) => fixItem(item, doc, lines, choice);

  async function issue() {
    if (busy.current || blocked) return;
    busy.current = true;
    setWorking(true);
    try {
      await issueDocument(db, docId, { today: todayLocal() });
      router.dismissAll(); // back to the list, then the issued document: "back" never returns to the editor
      router.push({ pathname: '/document/[id]', params: { id: String(docId) } });
    } catch (e) {
      if (e instanceof IssueBlockedError) await reload();
      else Alert.alert(t('editor.issueFailed'), errorText(e));
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  return (
    <Screen testID="check-screen">
      <Stack.Screen options={{ title: t('check.title') }} />
      <CheckPanel items={items} onFix={fix} busy={working} />
      <View style={{ gap: 8 }}>
        {blocked ? (
          <ThemedText testID="check-blocked" type="small" themeColor="danger">
            {t('check.blocked')}
          </ThemedText>
        ) : null}
        <Button
          testID="issue-anyway"
          label={items.length ? t('check.issueAnyway') : doc.type === 'quote' ? t('editor.issueQuote') : t('editor.issue')}
          disabled={blocked || working}
          onPress={issue}
        />
        <Button testID="check-back" variant="secondary" label={t('check.backToEdit')} onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
