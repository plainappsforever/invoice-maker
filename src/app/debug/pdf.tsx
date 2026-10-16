import { File, Paths } from 'expo-file-system';
import { Redirect, Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Screen, Section } from '@/components/ui';
import { tallRowProbe, type ProbeResult } from '@/db/debug';
import { isDevBuild } from '@/lib/debug';
import { PROBE_DIR, probeHtmls, runPdfProbe, type ProbeReport } from '@/lib/pdf-probe';

// Measures the real layout of every page in this platform's WebView: free room between the end of the page body
// and the footer (negative = the estimate was too optimistic and content would be clipped, D46/D56).
const MEASURE = `(function(){function run(){var out=[];document.querySelectorAll('.page').forEach(function(p){var b=p.querySelector('.body');var f=p.querySelector('.foot');var bt=b.getBoundingClientRect().top;var bottom=bt+b.scrollHeight;var ft=f?f.getBoundingClientRect().top:p.getBoundingClientRect().bottom;out.push(Math.round(ft-bottom));});window.ReactNativeWebView.postMessage(JSON.stringify(out));}
if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){setTimeout(run,50);});}else{setTimeout(run,300);}})();true;`;

type LayoutRow = { name: string; rooms: number[] };

/** Debug → PDF probes (development builds only): PDF files on this device, real layout room, tall-row refusal. */
export default function DebugPdf() {
  const db = useSQLiteContext();
  const [status, setStatus] = useState('');
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [layout, setLayout] = useState<LayoutRow[] | null>(null);
  const [current, setCurrent] = useState<number>(-1);
  const [tall, setTall] = useState<ProbeResult[] | null>(null);
  const [htmls] = useState(probeHtmls);
  if (!isDevBuild) return <Redirect href="/" />;

  const onMessage = (e: WebViewMessageEvent) => {
    const rooms = JSON.parse(e.nativeEvent.data) as number[];
    const name = htmls[current].name;
    const next = [...(layout ?? []), { name, rooms }];
    setLayout(next);
    if (current + 1 >= htmls.length) new File(Paths.document, PROBE_DIR, 'layout.json').write(JSON.stringify({ platform: Platform.OS, rows: next }));
    setCurrent((n) => (n + 1 < htmls.length ? n + 1 : -1));
  };
  const layoutDone = layout !== null && current === -1;
  const layoutBad = layout?.filter((r) => r.rooms.some((x) => x < 0)) ?? [];
  const okRows = report?.rows.filter((r) => r.ok).length ?? 0;

  return (
    <Screen testID="debug-pdf-screen">
      <Stack.Screen options={{ title: 'PDF probes' }} />
      <Section title="PDF files (expo-print)">
        <Button
          testID="debug-pdf-probe"
          label="Run PDF probe"
          onPress={async () => {
            setReport(null);
            try {
              setReport(await runPdfProbe(Platform.OS, setStatus));
              setStatus('done');
            } catch (e) {
              setStatus(`failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        />
        <ThemedText testID="debug-pdf-status" type="small">{status}</ThemedText>
        {report ? (
          <>
            <ThemedText testID="pdf-probe-summary">
              {`PDFPROBE ${okRows}/${report.rows.length} ok · cold ${report.coldMs} ms · stable bytes ${report.stable.identicalBytes ? 'yes' : 'no'} · normalised ${report.stable.identicalNormalised ? 'yes' : 'no'}`}
            </ThemedText>
            {report.rows.map((r) => (
              <ThemedText key={r.name} type="small">
                {`${r.ok ? 'OK' : 'BAD'} ${r.name}: ${r.pages}/${r.expectedPages} p (engine said ${r.reportedPages}), ${r.mediaBox?.join('×')}, ${Math.round(r.bytes / 1024)} KB, ${r.ms} ms (${r.msPerPage}/p), fonts ${r.embeddedFonts} [${r.fonts.join(', ')}] ${r.problems.join('; ')}`}
              </ThemedText>
            ))}
          </>
        ) : null}
      </Section>
      <Section title="Real layout in this WebView">
        <Button
          testID="debug-layout-probe"
          variant="secondary"
          label="Measure layout"
          onPress={() => {
            setLayout([]);
            setCurrent(0);
          }}
        />
        {layoutDone ? (
          <>
            <ThemedText testID="layout-probe-summary">{`LAYOUT ${layout.length - layoutBad.length}/${layout.length} ok`}</ThemedText>
            {layout.map((r) => (
              <ThemedText key={r.name} type="small">{`${r.rooms.some((x) => x < 0) ? 'BAD' : 'OK'} ${r.name}: room per page ${r.rooms.join(', ')} px`}</ThemedText>
            ))}
          </>
        ) : current >= 0 ? (
          <ThemedText type="small">{`measuring ${current + 1}/${htmls.length}`}</ThemedText>
        ) : null}
        {current >= 0 ? (
          <View style={{ height: 200, opacity: 0.99 }}>
            <WebView
              key={current}
              source={{ html: htmls[current].html }}
              originWhitelist={['about:*', 'data:*']}
              javaScriptEnabled
              injectedJavaScript={MEASURE}
              onMessage={onMessage}
            />
          </View>
        ) : null}
      </Section>
      <Section title="Tall row refusal (D56)">
        <Button testID="debug-tall-probe" variant="secondary" label="Run tall-row probe" onPress={async () => setTall(await tallRowProbe(db))} />
        {tall ? (
          <>
            <ThemedText testID="tall-probe-summary">{`TALL ${tall.filter((r) => r.ok).length}/${tall.length} ok`}</ThemedText>
            {tall.map((r) => (
              <ThemedText key={r.name} type="small">{`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`}</ThemedText>
            ))}
          </>
        ) : null}
      </Section>
    </Screen>
  );
}
