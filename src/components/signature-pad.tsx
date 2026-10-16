// Finger signature pad (V1.5 P1, L140-a). View responder props (no gesture-handler root needed) + react-native-svg. The strokes
// go through src/engine/signature.ts (crop, simplify, strict path grammar) before they are stored.
import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '@/hooks/use-theme';
import type { Point, Stroke } from '@/engine/signature';

const toPath = (s: Stroke) => (s.length ? `M${s[0].x.toFixed(1)} ${s[0].y.toFixed(1)}` + (s.length === 1 ? ` L${s[0].x.toFixed(1)} ${s[0].y.toFixed(1)}` : s.slice(1).map((p) => ` L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('')) : '');

export function SignaturePad({ strokes, onChange, height = 220, testID }: { strokes: Stroke[]; onChange: (s: Stroke[]) => void; height?: number; testID?: string }) {
  const theme = useTheme();
  const current = useRef<Stroke | null>(null);
  const [live, setLive] = useState<Stroke | null>(null);
  const point = (e: GestureResponderEvent): Point => ({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
  // Plain responder props (no PanResponder object built during render): the handlers are event handlers.
  const finish = () => {
    if (current.current) onChange([...strokes, current.current]);
    current.current = null;
    setLive(null);
  };
  return (
    <View
      testID={testID}
      accessibilityLabel={testID}
      style={[styles.pad, { height, borderColor: theme.textSecondary, backgroundColor: '#ffffff' }]}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        current.current = [point(e)];
        setLive([...current.current]);
      }}
      onResponderMove={(e) => {
        if (!current.current) return;
        current.current.push(point(e));
        setLive([...current.current]);
      }}
      onResponderRelease={finish}
      onResponderTerminate={finish}>
      <Svg width="100%" height="100%" pointerEvents="none">
        {[...strokes, ...(live ? [live] : [])].map((s, i) => (
          <Path key={i} d={toPath(s)} stroke="#1a1a1a" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ))}
      </Svg>
      <View pointerEvents="none" style={[styles.line, { borderColor: theme.textSecondary }]} />
    </View>
  );
}

/** A stored signature, drawn (business form, quote detail). */
export function SignatureView({ d, w, h, height = 60, testID }: { d: string; w: number; h: number; height?: number; testID?: string }) {
  return (
    <View testID={testID} style={{ height, aspectRatio: Math.max(0.5, Math.min(8, w / h)), backgroundColor: '#ffffff', borderRadius: 6 }}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`}>
        <Path d={d} stroke="#1a1a1a" strokeWidth={Math.max(1.5, Math.min(w, h) / 40)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  line: { position: 'absolute', left: 24, right: 24, bottom: 40, borderTopWidth: 1, borderStyle: 'dashed' },
});
