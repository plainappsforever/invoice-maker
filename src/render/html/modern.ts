// Modern template: accent colour band with the logo and business name, accent table header (D23). The
// address field keeps the DIN 5008 position, so it still works with window envelopes.
import { mm } from './din5008';
import { esc, subjectOf, businessAddressLines } from './shared';
import type { TemplateDef } from './template';

export const modern: TemplateDef = {
  spec: {
    id: 'modern',
    fontPx: 9,
    smallPx: 7.5,
    lh: 12.5,
    lhSmall: 10,
    cellPadV: 4,
    letterheadTopMm: 0,
    addressTopMm: 45,
    addressHeightMm: 45,
    infoTopMm: 50,
    infoLeftMm: 125,
    subjectTopMm: 98.5,
    laterHeadTopMm: 0,
    laterBodyTopMm: 26,
    foldMarks: false,
  },
  css: (ctx) => `
.band{background:${ctx.accent};color:#fff;left:0;top:0;width:${ctx.geo.w}px;height:${mm(30)}px;padding:${mm(8)}px ${ctx.geo.marginRight}px 0 ${ctx.geo.marginLeft}px}
.band .lh{display:flex;align-items:center;gap:10px}
.band .lh.right{flex-direction:row-reverse;justify-content:space-between}
.band .logo-box{background:#fff;padding:3px;border-radius:3px}
.band .logo{max-height:${mm(14)}px;max-width:${mm(45)}px;display:block}
.band .lh-name{font-size:15px;font-weight:600;line-height:18px}
.band .lh-addr{font-size:${ctx.spec.smallPx}px;line-height:${ctx.spec.lhSmall}px;opacity:0.9}
.band-slim{background:${ctx.accent};color:#fff;left:0;top:0;width:${ctx.geo.w}px;height:${mm(14)}px;padding:${mm(5)}px ${ctx.geo.marginRight}px 0 ${ctx.geo.marginLeft}px;display:flex;justify-content:space-between;font-size:${ctx.spec.smallPx}px}
h1.subject{color:${ctx.accent}}
table.lines thead th{background:${ctx.accent};color:#fff;padding-top:3px;padding-bottom:3px}
table.lines tbody td{border-bottom:0.5px solid #e2e2e2}
table.lines tbody tr:nth-child(even) td{background:#f6f8fa}
.foot{border-top:2px solid ${ctx.accent}}
`,
  letterhead: (ctx) => {
    const lines = businessAddressLines(ctx).join(', ');
    const logo = ctx.logo ? `<span class="logo-box"><img class="logo" src="${ctx.logo}" alt=""></span>` : '';
    return `<div class="abs band"><div class="lh${ctx.model.layout.logoRight ? ' right' : ''}">${logo}<div><div class="lh-name">${esc(ctx.model.business.name)}</div><div class="lh-addr">${esc(lines)}</div></div></div></div>`;
  },
  laterHead: (ctx) => `<div class="abs band-slim"><span>${esc(ctx.model.business.name)}</span><b>${esc(subjectOf(ctx))}</b></div>`,
};
