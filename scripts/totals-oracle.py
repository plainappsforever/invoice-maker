#!/usr/bin/env python3
"""Independent oracle for the totals engine (SPEC §5 steps 1-8), P3.5.

Written from the SPEC text alone with Python integers/Fractions; it shares no code with
src/engine/totals.ts and is NOT generated from the engine. It writes
src/engine/__fixtures__/oracle-cases.json: inputs in the engine's TotalsInput shape plus the expected
amounts. Jest (totals.test.ts) checks computeTotals against every case.

Run: python3 scripts/totals-oracle.py   (deterministic: fixed seed)
"""
import json
import random
from fractions import Fraction
from pathlib import Path

SEED = 20261001
CASES = 500
NEGATED_EVERY = 10  # every 10th case is the cancellation (all quantities negated) of the case before
CATEGORY_ORDER = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O']
MAX_ABS_CENTS = 99_999_999_999


def rnd(x: Fraction) -> int:
    """Round half away from zero to an integer (SPEC: round)."""
    sign = -1 if x < 0 else 1
    a = abs(x)
    whole = a.numerator // a.denominator
    if a - whole >= Fraction(1, 2):
        whole += 1
    return sign * whole


def line_amounts(line):
    base = rnd(Fraction(line['qtyMilli'] * line['priceE4'], 100_000))  # step 1
    d = line['discount']
    if d['kind'] == 'percent':
        ld = rnd(Fraction(base * d['value'], 10_000))  # step 2
    elif d['kind'] == 'amount':
        ld = min(d['value'], base)
    else:
        ld = 0
    return base, ld, base - ld


def rate_of(line):
    return line['rateBp'] if line['category'] == 'S' else 0  # step 3: no-VAT categories have rate 0


def totals(inp):
    lines = [line_amounts(l) for l in inp['lines']]
    groups = {}
    for l, (_, _, net) in zip(inp['lines'], lines):
        key = (l['category'], rate_of(l))
        groups[key] = groups.get(key, 0) + net
    keys = list(groups)
    total_g = sum(groups.values())

    d = inp['discount']  # step 4
    if d['kind'] == 'percent':
        D = rnd(Fraction(total_g * d['value'], 10_000))
    elif d['kind'] == 'amount':
        D = min(d['value'], total_g)
    else:
        D = 0
    shares = {k: 0 for k in keys}
    if D != 0 and total_g != 0:
        raw = {k: Fraction(D * groups[k], total_g) for k in keys}
        floors = {k: raw[k].numerator // raw[k].denominator for k in keys}
        rest = D - sum(floors.values())
        # remaining cents to the largest fractional parts; ties: higher rate first, then category order
        order = sorted(keys, key=lambda k: (-(raw[k] - floors[k]), -k[1], CATEGORY_ORDER.index(k[0])))
        for k in order[:rest]:
            floors[k] += 1
        shares = floors

    out_groups = []
    for k in keys:
        cat, r = k
        if inp['pricesIncludeVat']:  # step 6
            h = groups[k] - shares[k]
            v = rnd(Fraction(h * r, 10_000 + r))
            t = h - v
        else:  # step 5
            t = groups[k] - shares[k]
            v = rnd(Fraction(t * r, 10_000))
        out_groups.append({'category': cat, 'rateBp': r, 'amount': groups[k], 'discount': shares[k], 'taxable': t, 'tax': v, 'gross': t + v})
    net = sum(g['taxable'] for g in out_groups)
    tax = sum(g['tax'] for g in out_groups)
    return {
        'lines': [{'base': b, 'discount': ld, 'net': n} for b, ld, n in lines],
        'groups': sorted(out_groups, key=lambda g: (CATEGORY_ORDER.index(g['category']), -g['rateBp'])),
        'lineTotal': total_g,
        'discount': D,
        'net': net,
        'tax': tax,
        'gross': net + tax,
    }


RATES = [('S', 1900)] * 4 + [('S', 700)] * 3 + [('S', 550), ('S', 2000), ('S', 2500), ('Z', 0), ('E', 0), ('AE', 0), ('K', 0), ('G', 0), ('O', 0)]


def gen_line(r: random.Random):
    cat, rate = r.choice(RATES)
    qty = r.choice([1000, 1000, 2000, 3000, 500, 250, 1, 333, 12_500, r.randint(1, 999_999)])
    price = r.choice([r.randint(0, 99_999), r.randint(0, 9_999_999), r.randint(0, 9_999_999_999), 50, 5_000, 3_333, 850_000])
    k = r.choice(['none', 'none', 'percent', 'amount'])
    if k == 'percent':
        disc = {'kind': 'percent', 'value': r.choice([1000, 333, 5000, 10_000, r.randint(1, 10_000)])}
    elif k == 'amount':
        disc = {'kind': 'amount', 'value': r.randint(1, 2_000_000)}
    else:
        disc = {'kind': 'none', 'value': 0}
    return {'qtyMilli': qty, 'priceE4': price, 'category': cat, 'rateBp': rate, 'discount': disc}


def gen_case(r: random.Random):
    k = r.choice(['none', 'none', 'percent', 'amount'])
    if k == 'percent':
        disc = {'kind': 'percent', 'value': r.choice([1000, 333, 250, r.randint(1, 10_000)])}
    elif k == 'amount':
        disc = {'kind': 'amount', 'value': r.choice([1, 2, 3, 100, r.randint(1, 50_000_000)])}
    else:
        disc = {'kind': 'none', 'value': 0}
    return {'lines': [gen_line(r) for _ in range(r.randint(1, 5))], 'pricesIncludeVat': r.random() < 0.35, 'discount': disc, 'payments': []}


def negate(inp):
    return {**inp, 'lines': [{**l, 'qtyMilli': -l['qtyMilli']} for l in inp['lines']]}


def negate_expected(e):
    neg = lambda x: 0 - x  # noqa: E731
    return {
        'lines': [{k: neg(v) for k, v in l.items()} for l in e['lines']],
        'groups': [{**g, 'amount': neg(g['amount']), 'discount': neg(g['discount']), 'taxable': neg(g['taxable']), 'tax': neg(g['tax']), 'gross': neg(g['gross'])} for g in e['groups']],
        **{k: neg(e[k]) for k in ['lineTotal', 'discount', 'net', 'tax', 'gross']},
    }


def main():
    r = random.Random(SEED)
    cases = []
    while len(cases) < CASES:
        if len(cases) % NEGATED_EVERY == NEGATED_EVERY - 1:
            prev = cases[-1]
            # SPEC step 8: a cancellation (all quantities negated) is the exact negative of the original.
            cases.append({'input': negate(prev['input']), 'expected': negate_expected(prev['expected']), 'negated': True})
            continue
        inp = gen_case(r)
        exp = totals(inp)
        if any(abs(exp[k]) > MAX_ABS_CENTS for k in ['lineTotal', 'gross']):
            continue
        cases.append({'input': inp, 'expected': exp})
    out = Path(__file__).resolve().parent.parent / 'src' / 'engine' / '__fixtures__' / 'oracle-cases.json'
    out.write_text(json.dumps({'source': 'scripts/totals-oracle.py (independent reading of SPEC §5)', 'seed': SEED, 'cases': cases}, separators=(',', ':')) + '\n')
    print(f'{len(cases)} cases -> {out} ({out.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
