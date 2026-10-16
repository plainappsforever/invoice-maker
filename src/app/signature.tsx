// Draw a signature (V1.5 P1, L140-a): `?target=business` = the business signature printed under documents;
// `?quote=<id>` = the client signs an issued quote on this phone ("Accept with signature").
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/button';
import { SignaturePad } from '@/components/signature-pad';
import { ThemedText } from '@/components/themed-text';
import { ErrorText, Input } from '@/components/ui';
import { updateBusiness } from '@/db/business';
import { getDocument } from '@/db/documents';
import { acceptQuoteSigned, renderModelFor } from '@/db/lifecycle';
import { serializeSignature, signatureFromStrokes, type Stroke } from '@/engine/signature';
import { t } from '@/i18n';
import { errorText } from '@/lib/errors';

export default function SignatureScreen() {
  const { target, quote } = useLocalSearchParams<{ target?: string; quote?: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const quoteId = quote ? Number(quote) : null;
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [signer, setSigner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (quoteId === null) return;
    (async () => {
      const doc = await getDocument(db, quoteId);
      if (!doc) return;
      const model = await renderModelFor(db, quoteId);
      setSigner(model.client?.contact || (model.client?.kind === 'person' ? model.client.name : '') || '');
    })().catch(() => undefined);
  }, [db, quoteId]);

  async function save() {
    if (busy) return;
    const sig = signatureFromStrokes(strokes);
    if (!sig) {
      setError(strokes.length ? t('signature.tooLong') : t('signature.empty'));
      return;
    }
    setBusy(true);
    try {
      if (quoteId !== null) await acceptQuoteSigned(db, quoteId, signer.trim(), serializeSignature(sig));
      else if (target === 'business') await updateBusiness(db, { signature: serializeSignature(sig) });
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView scrollEnabled={false} contentContainerStyle={{ padding: 16, gap: 12 }} testID="signature-screen">
      <Stack.Screen options={{ title: quoteId !== null ? t('signature.quoteTitle') : t('signature.businessTitle') }} />
      <ThemedText type="small" themeColor="textSecondary">
        {quoteId !== null ? t('signature.quoteHint') : t('signature.businessHint')}
      </ThemedText>
      {quoteId !== null ? <Input label={t('signature.signer')} testID="signature-signer" value={signer} onChangeText={setSigner} /> : null}
      <SignaturePad testID="signature-pad" strokes={strokes} onChange={(s) => { setStrokes(s); setError(null); }} />
      <ErrorText testID="signature-error">{error}</ErrorText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button testID="signature-clear" variant="secondary" label={t('signature.clear')} onPress={() => setStrokes([])} />
        </View>
        <View style={{ flex: 1 }}>
          <Button testID="signature-save" label={quoteId !== null ? t('signature.acceptAndSign') : t('signature.save')} onPress={save} disabled={busy} />
        </View>
      </View>
    </ScrollView>
  );
}
