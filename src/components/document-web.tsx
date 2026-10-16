import { useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { WebView } from 'react-native-webview';

import { PAPER_PX } from '@/render/html/din5008';
import { PREVIEW_GAP, previewHtml } from '@/render/preview';

/**
 * The document's own HTML (the same string the PDF is made from, D24) in a WebView: no JavaScript, no network,
 * no navigation. The view is as tall as the pages it shows, so the screen scrolls as one piece (no nested
 * scrolling); `pages` limits it to the first n pages, `crop` (0–1) shows only the top part of the first page (the
 * card on the issued view).
 */
export function DocumentWeb({ html, paper, pages, crop, testID }: { html: string; paper: 'A4' | 'LETTER'; pages?: number; crop?: number; testID?: string }) {
  const [width, setWidth] = useState(0);
  const { w, h } = PAPER_PX[paper] ?? PAPER_PX.A4;
  const total = Number(/<body[^>]*data-pages="(\d+)"/.exec(html)?.[1] ?? 1);
  const shown = Math.min(total, pages ?? total);
  const scale = width / (w + 2 * PREVIEW_GAP);
  const height = Math.ceil((shown * (h + PREVIEW_GAP) + (shown === total ? PREVIEW_GAP : 0) + PREVIEW_GAP) * scale);
  const visible = crop ? Math.ceil((PREVIEW_GAP + h * crop) * scale) : height;
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  return (
    <View testID={testID} onLayout={onLayout} style={[styles.frame, { height: width ? visible : 300 }]}>
      {width ? (
        <WebView
          source={{ html: previewHtml(html, paper) }}
          originWhitelist={['about:*', 'data:*']}
          onShouldStartLoadWithRequest={(r) => r.url.startsWith('about:') || r.url.startsWith('data:')}
          javaScriptEnabled={false}
          scrollEnabled={false}
          allowFileAccess={false}
          setSupportMultipleWindows={false}
          textZoom={100}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          style={[styles.web, { height, flex: undefined }]}
          {...(Platform.OS === 'android' ? { nestedScrollEnabled: false } : {})}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 8, overflow: 'hidden', backgroundColor: '#d9d9de' },
  web: { flex: 1, backgroundColor: '#d9d9de' },
});
