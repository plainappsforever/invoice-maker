// The in-app preview (D24) shows the same HTML as the PDF; only a grey desk around the pages is added, and the
// viewport is widened by that margin so the WebView scales whole pages to the screen width. PURE.
import { PAPER_PX } from './html/din5008';

export const PREVIEW_GAP = 12;
const GAP = PREVIEW_GAP;

export function previewHtml(html: string, paper: 'A4' | 'LETTER'): string {
  const { w } = PAPER_PX[paper] ?? PAPER_PX.A4;
  const css = `<style>html,body{background:#d9d9de}body{padding:${GAP}px 0}.page{margin:0 auto ${GAP}px;box-shadow:0 1px 4px rgba(0,0,0,.25)}</style>`;
  return html.replace(/<meta name="viewport" content="width=\d+">/, `<meta name="viewport" content="width=${w + 2 * GAP}">`).replace('</head>', `${css}</head>`);
}

/**
 * Print engines do not map CSS px to PDF points 1:1 (measured in P5, D67): WebKit (iOS) prints with its minimum
 * shrink factor 1.25 (1 px → 0.8 pt), Chromium (Android) at 96 px per inch (1 px → 0.75 pt). The renderer's page
 * boxes are in points (595 × 842 for A4), so the print HTML is zoomed by the engine's factor: 1 renderer px = 1 pt.
 * The engines round the printed page height down (iOS A4 by ~0.5 px, Android by ~1 pt), so a full-height box would
 * spill onto a blank extra page: in print, every page box is PRINT_TRIM px shorter (only the footer moves up by that).
 */
export const PRINT_ZOOM = { ios: 1.25, android: 4 / 3 } as const;
export const PRINT_TRIM = 2;

export function printHtml(html: string, zoom: number, paper: 'A4' | 'LETTER'): string {
  const { h } = PAPER_PX[paper] ?? PAPER_PX.A4;
  return html.replace('</head>', `<style>html{zoom:${zoom}}.page{height:${h - PRINT_TRIM}px}</style></head>`);
}
