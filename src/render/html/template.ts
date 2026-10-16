// What a template is: numbers (TemplateSpec in shared.ts) + its own CSS and letterhead markup. The page
// structure, tables, totals and pagination are common to all three (index.ts).
import type { Layout } from './paginate';
import type { Ctx, TemplateSpec } from './shared';

export type TemplateDef = {
  spec: TemplateSpec;
  /** CSS on top of the common stylesheet. */
  css: (ctx: Ctx, layout: Layout) => string;
  /** Page 1 letterhead (absolutely positioned inside the page). */
  letterhead: (ctx: Ctx) => string;
  /** Header of pages 2…n. */
  laterHead: (ctx: Ctx) => string;
};
