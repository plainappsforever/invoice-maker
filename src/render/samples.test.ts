/**
 * @jest-environment node
 */
// Writes artifacts/samples/*.html for a look in a desktop browser (scripts/render-samples.mjs sets RENDER_SAMPLES=1).
// Skipped in normal runs. Includes the fonts, so the files look like the PDF content will.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderHtml, TEMPLATE_IDS } from '@/render/html';
import { exampleModel, longInvoiceModel, type ExampleId } from '@/render/test-models';

const enabled = process.env.RENDER_SAMPLES === '1';
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJAAAAAwCAYAAAD+WvNWAAABB0lEQVR42u3bQQrCQBAF0dzEG3kfT68rIZuAxJ7k98xrmJ2LgqpV5G+bc8451/8ez9f7+45u/5vkh3/c+ykgIvCXBEQE/pKAiMBfEhAR+EsCImJd/tKAiFiPf0hARKzDPzQgIubnvyQgIublvzQgIubjvyUgIubhvzUgIvrzRwRERF/+qICE1I8/MiAh9eGPDkhI+fwtAhJSLn+rgISUx98yICHl8B8GRAT+v74DEYG/LCAi8J/6kEgE/pK/MojAbxeG3y5MSHZhRNiFEYHfLgy/XZiQ7MKIsAsjwi7MLgy/XZiQ7MKEZBdGhF2YXRh+uzAh2YUJyS6MCLswIvCf24U555xzfe4DKuvrvC/lnngAAAAASUVORK5CYII=';

(enabled ? describe : describe.skip)('render samples', () => {
  const dir = join(__dirname, '..', '..', 'artifacts', 'samples');
  it('writes the sample HTML files', () => {
    mkdirSync(dir, { recursive: true });
    const write = (name: string, html: string) => writeFileSync(join(dir, `${name}.html`), html);
    const payments = { A: [{ date: '2026-10-05', amountCents: 30000 }] } as Record<string, { date: string; amountCents: number }[]>;
    for (const id of ['A', 'B', 'C', 'D', 'E1', 'E2', 'F'] as ExampleId[]) {
      write(`example-${id}`, renderHtml(exampleModel(id), { payments: payments[id], logoDataUri: id === 'A' ? LOGO : null }));
    }
    for (const template of TEMPLATE_IDS) {
      write(`example-A-${template}`, renderHtml(exampleModel('A'), { template, payments: payments.A, logoDataUri: LOGO }));
      write(`long-60-${template}`, renderHtml(longInvoiceModel(60), { template, logoDataUri: LOGO }));
    }
    write('long-60-letter', renderHtml(longInvoiceModel(60), { paper: 'LETTER' }));
    write('example-A-letter', renderHtml(exampleModel('A'), { paper: 'LETTER', payments: payments.A }));
  });
});
