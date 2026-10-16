// Classic template: DIN 5008 Form B for window envelopes (D23). Address field 20 mm from the left, 45 mm from
// the top, 85 × 45 mm with a one-line sender; fold marks at 105/210 mm and the punch mark at 148.5 mm (A4).
import { mm } from './din5008';
import { esc, subjectOf, businessAddressLines } from './shared';
import type { TemplateDef } from './template';

export const classic: TemplateDef = {
  spec: {
    id: 'classic',
    fontPx: 9,
    smallPx: 7.5,
    lh: 12,
    lhSmall: 10,
    cellPadV: 3,
    letterheadTopMm: 12,
    addressTopMm: 45,
    addressHeightMm: 45,
    infoTopMm: 50,
    infoLeftMm: 125,
    subjectTopMm: 98.5,
    laterHeadTopMm: 12,
    laterBodyTopMm: 28,
    foldMarks: true,
  },
  css: (ctx) => `
.lh{display:flex;align-items:flex-start;gap:10px}
.lh.right{flex-direction:row-reverse;justify-content:space-between}
.lh .logo{max-height:${mm(18)}px;max-width:${mm(55)}px;display:block}
.lh-name{font-size:13px;font-weight:600;line-height:16px;color:${ctx.accent}}
.lh-addr{font-size:${ctx.spec.smallPx}px;line-height:${ctx.spec.lhSmall}px;color:#555}
.later-head{display:flex;justify-content:space-between;border-bottom:0.75px solid ${ctx.accent};padding-bottom:3px;font-size:${ctx.spec.smallPx}px;color:#555}
.later-head b{color:${ctx.accent};font-weight:600}
table.lines thead th{border-bottom:1px solid ${ctx.accent};color:${ctx.accent}}
table.lines tbody td{border-bottom:0.5px solid #d6d6d6}
h1.subject{color:#1a1a1a}
.foot{border-top:0.75px solid ${ctx.accent}}
`,
  letterhead: (ctx) => {
    const lines = businessAddressLines(ctx).join(', ');
    const logo = ctx.logo ? `<img class="logo" src="${ctx.logo}" alt="">` : '';
    return `<div class="abs lh${ctx.model.layout.logoRight ? ' right' : ''}" style="top:${mm(12)}px;left:${ctx.geo.marginLeft}px;width:${ctx.geo.contentWidth}px">${logo}<div><div class="lh-name">${esc(ctx.model.business.name)}</div><div class="lh-addr">${esc(lines)}</div></div></div>`;
  },
  laterHead: (ctx) =>
    `<div class="abs later-head" style="top:${mm(12)}px;left:${ctx.geo.marginLeft}px;width:${ctx.geo.contentWidth}px"><span>${esc(ctx.model.business.name)}</span><b>${esc(subjectOf(ctx))}</b></div>`,
};

