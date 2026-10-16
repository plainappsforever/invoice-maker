import { NativeModule, requireNativeModule } from 'expo';

/** A recognised text line. Box normalised 0..1, origin top-left on both platforms. */
export type RecognizedLine = { text: string; box: { x: number; y: number; w: number; h: number }; confidence?: number };
export type RecognizeResult = { width: number; height: number; lines: RecognizedLine[] };

// Local Expo module (DECISIONS D95): iOS Vision, Android ML Kit with the bundled Latin model. URIs are file:// URIs.
declare class TextScanModule extends NativeModule<{}> {
  /** Android: whether Play services has the ML Kit document scanner ('downloading' = requested for next time). iOS: VisionKit support. */
  documentScannerStatus(): Promise<'ready' | 'downloading' | 'unavailable'>;
  /** On-device text recognition of an image file. `correct` = iOS language correction (ignored on Android). */
  recognize(uri: string, correct: boolean): Promise<RecognizeResult>;
}

export default requireNativeModule<TextScanModule>('TextScan');
