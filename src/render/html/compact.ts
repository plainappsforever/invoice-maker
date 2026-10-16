// Compact template: smaller type, tight rows and a short letterhead — more lines on page 1 (D23). The address
// block sits higher (34 mm) and is no DIN 5008 window layout.
import { mm } from './din5008';
import { esc, subjectOf, businessAddressLines } from './shared';
import type { TemplateDef } from './template';

export const compact: TemplateDef = {
  spec: {
    id: 'compact',
    fontPx: 8.5,
    smallPx: 7,
    lh: 11,
    lhSmall: 9.5,
    cellPadV: 2,
    letterheadTopMm: 10,
    addressTopMm: 34,
    addressHeightMm: 30,
    infoTopMm: 36,
    infoLeftMm: 125,
    subjectTopMm: 70,
    laterHeadTopMm: 10,
    laterBodyTopMm: 24,
    foldMarks: false,
  },
  css: (ctx) => `
.lh{display:flex;align-items:center;gap:10px;border-bottom:1.5px solid ${ctx.accent};padding-bottom:4px}
.lh.right{flex-direction:row-reverse;justify-content:space-between}
.lh .logo{max-height:${mm(12)}px;max-width:${mm(40)}px;display:block}
.lh-name{font-size:12px;font-weight:600;line-height:15px;color:${ctx.accent}}
.lh-addr{font-size:${ctx.spec.smallPx}px;line-height:${ctx.spec.lhSmall}px;color:#555}
.later-head{display:flex;justify-content:space-between;border-bottom:0.75px solid ${ctx.accent};padding-bottom:2px;font-size:${ctx.spec.smallPx}px;color:#555}
table.lines thead th{border-bottom:1px solid #333}
table.lines tbody td{border-bottom:0.5px solid #ddd}
h1.subject{font-size:13px}
.foot{border-top:0.5px solid #888}
`,
  letterhead: (ctx) => {
    const lines = businessAddressLines(ctx).join(', ');
    const logo = ctx.logo ? `<img class="logo" src="${ctx.logo}" alt="">` : '';
    return `<div class="abs lh${ctx.model.layout.logoRight ? ' right' : ''}" style="top:${mm(10)}px;left:${ctx.geo.marginLeft}px;width:${ctx.geo.contentWidth}px">${logo}<div><div class="lh-name">${esc(ctx.model.business.name)}</div><div class="lh-addr">${esc(lines)}</div></div></div>`;
  },
  laterHead: (ctx) =>
    `<div class="abs later-head" style="top:${mm(10)}px;left:${ctx.geo.marginLeft}px;width:${ctx.geo.contentWidth}px"><span>${esc(ctx.model.business.name)}</span><b>${esc(subjectOf(ctx))}</b></div>`,
};
