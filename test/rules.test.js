import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeJournals } from '../src/journal.js';
import { screen, RULES, fiscalYearEndFor } from '../src/rules.js';

const base = {
  date: '2026-01-14', // 水曜
  entered_at: '2026-01-14T14:00:00+09:00',
  debit_account: '仕入高',
  credit_account: '買掛金',
  amount: 123456,
  description: '通常取引',
  created_by: 'acc01',
  approved_by: 'mgr01',
};

/** 指定したルールに当たった仕訳IDを返す。 */
function hits(journals, ruleId, options = {}) {
  const entries = normalizeJournals(journals);
  const result = screen(entries, { ...options, rules: [ruleId] });
  return result.findings.map((f) => f.entryId);
}

test('全ルールに id・title・severity・rationale がある', () => {
  for (const r of RULES) {
    assert.ok(r.id && r.title && r.severity && r.rationale, `${r.id} の定義が欠けています`);
    assert.ok(['high', 'medium', 'low'].includes(r.severity));
    assert.equal(typeof r.run, 'function');
  }
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, 'ルールIDが重複しています');
});

test('unbalanced: 貸借が合わない仕訳だけを拾う', () => {
  const found = hits(
    [
      { ...base, id: 'OK' },
      { id: 'NG', date: '2026-01-14', lines: [{ account: 'A', debit: 100 }, { account: 'B', credit: 90 }] },
    ],
    'unbalanced'
  );
  assert.deepEqual(found, ['NG']);
});

test('self_approval: 起票者と承認者が同じものを拾う', () => {
  const found = hits(
    [
      { ...base, id: 'OK' },
      { ...base, id: 'NG', created_by: 'acc01', approved_by: 'acc01' },
      { ...base, id: 'NOAPP', approved_by: undefined },
    ],
    'self_approval'
  );
  assert.deepEqual(found, ['NG']);
});

test('threshold_avoidance: 限度額の直下だけを拾い、限度額ちょうどは拾わない', () => {
  const found = hits(
    [
      { ...base, id: 'UNDER', amount: 960000 },
      { ...base, id: 'JUST', amount: 1000000 },
      { ...base, id: 'OVER', amount: 1200000 },
      { ...base, id: 'FAR', amount: 500000 },
    ],
    'threshold_avoidance',
    { approvalThresholds: [1000000] }
  );
  assert.deepEqual(found, ['UNDER']);
});

test('threshold_avoidance: 限度額が未設定なら何も出ない', () => {
  assert.deepEqual(hits([{ ...base, amount: 990000 }], 'threshold_avoidance'), []);
});

test('duplicate: 同一条件のものを全件、相方のIDつきで返す', () => {
  const entries = normalizeJournals([
    { ...base, id: 'D1' },
    { ...base, id: 'D2' },
    { ...base, id: 'U1', amount: 999 },
  ]);
  const result = screen(entries, { rules: ['duplicate'] });
  assert.deepEqual(result.findings.map((f) => f.entryId), ['D1', 'D2']);
  assert.deepEqual(result.findings[0].detail.siblingIds, ['D2']);
});

test('backdated: 既定の30日を超えた入力だけを拾う', () => {
  const found = hits(
    [
      { ...base, id: 'FAST', date: '2026-01-14', entered_at: '2026-01-16T10:00:00+09:00' },
      { ...base, id: 'SLOW', date: '2026-01-14', entered_at: '2026-03-01T10:00:00+09:00' },
    ],
    'backdated'
  );
  assert.deepEqual(found, ['SLOW']);
});

test('period_end_large: 期末の窓に入った大口だけを拾う', () => {
  const journals = [];
  for (let i = 0; i < 40; i += 1) {
    journals.push({ ...base, id: `S${i}`, date: '2025-08-20', amount: 10000 + i });
  }
  journals.push({ ...base, id: 'BIG_END', date: '2026-03-30', amount: 90000000 });
  journals.push({ ...base, id: 'BIG_MID', date: '2025-09-10', amount: 89000000 });

  const found = hits(journals, 'period_end_large', { fiscalYearEnd: '03-31' });
  assert.deepEqual(found, ['BIG_END']);
});

test('period_end_large: 決算日が未設定なら何も出ない', () => {
  assert.deepEqual(hits([{ ...base, date: '2026-03-30', amount: 9e7 }], 'period_end_large'), []);
});

test('weekend_or_holiday: 土日と、指定した休日を拾う', () => {
  const found = hits(
    [
      { ...base, id: 'WED', date: '2026-01-14' },
      { ...base, id: 'SAT', date: '2026-01-17' },
      { ...base, id: 'SUN', date: '2026-01-18' },
      { ...base, id: 'NYD', date: '2026-01-01' },
    ],
    'weekend_or_holiday',
    { holidays: ['2026-01-01'] }
  );
  assert.deepEqual(found, ['SAT', 'SUN', 'NYD']);
});

// 月末かどうかの境い目を並べる。2032年はうるう年で、2月28日（土）は月末ではなく、2月29日（日）が月末になる。
const monthEndCases = [
  { ...base, id: 'FYE_SUN', date: '2024-03-31' }, // 日曜・期末
  { ...base, id: 'PREV_SAT', date: '2024-03-30' }, // 土曜・月末ではない
  { ...base, id: 'HALF_SAT', date: '2023-09-30' }, // 土曜・中間期末
  { ...base, id: 'FEB_SAT', date: '2026-02-28' }, // 土曜・平年の月末
  { ...base, id: 'LEAP28_SAT', date: '2032-02-28' }, // 土曜・うるう年なので月末ではない
  { ...base, id: 'LEAP29_SUN', date: '2032-02-29' }, // 日曜・うるう年の月末
  { ...base, id: 'HOL_END', date: '2026-04-30' }, // 休日に指定した月末
  { ...base, id: 'HOL_MID', date: '2026-04-29' }, // 休日に指定した月の途中
];

test('weekend_or_holiday: 月末日付の仕訳は既定で拾わない', () => {
  const found = hits(monthEndCases, 'weekend_or_holiday', { holidays: ['2026-04-29', '2026-04-30'] });
  assert.deepEqual(found, ['PREV_SAT', 'LEAP28_SAT', 'HOL_MID']);
});

test('weekend_or_holiday: exemptMonthEnd を false にすると月末も拾う', () => {
  const found = hits(monthEndCases, 'weekend_or_holiday', {
    holidays: ['2026-04-29', '2026-04-30'],
    exemptMonthEnd: false,
  });
  assert.deepEqual(found, ['FYE_SUN', 'PREV_SAT', 'HALF_SAT', 'FEB_SAT', 'LEAP28_SAT', 'LEAP29_SUN', 'HOL_END', 'HOL_MID']);
});

test('after_hours: 業務時間の外で入力されたものを拾う', () => {
  const found = hits(
    [
      { ...base, id: 'DAY', entered_at: '2026-01-14T14:00:00+09:00' },
      { ...base, id: 'NIGHT', entered_at: '2026-01-14T23:30:00+09:00' },
      { ...base, id: 'EARLY', entered_at: '2026-01-14T06:10:00+09:00' },
    ],
    'after_hours'
  );
  assert.deepEqual(found, ['NIGHT', 'EARLY']);
});

test('round_amount: 単位ちょうどで、かつ下限以上のものを拾う', () => {
  const found = hits(
    [
      { ...base, id: 'ODD', amount: 123456 },
      { ...base, id: 'ROUND', amount: 3000000 },
      { ...base, id: 'SMALL', amount: 50000 },
    ],
    'round_amount'
  );
  assert.deepEqual(found, ['ROUND']);
});

test('missing_description: 摘要が空白だけのものも拾う', () => {
  const found = hits(
    [
      { ...base, id: 'OK' },
      { ...base, id: 'EMPTY', description: '' },
      { ...base, id: 'SPACE', description: '   ' },
    ],
    'missing_description'
  );
  assert.deepEqual(found, ['EMPTY', 'SPACE']);
});

test('rare_account_pair: 母集団が小さいうちは判定しない', () => {
  const journals = [{ ...base, id: 'RARE', debit_account: '役員貸付金', credit_account: '現金' }];
  for (let i = 0; i < 10; i += 1) journals.push({ ...base, id: `N${i}` });
  assert.deepEqual(hits(journals, 'rare_account_pair'), []);
});

test('rare_account_pair: 母集団が十分なら稀な組み合わせを拾う', () => {
  const journals = [{ ...base, id: 'RARE', debit_account: '役員貸付金', credit_account: '現金' }];
  for (let i = 0; i < 60; i += 1) journals.push({ ...base, id: `N${i}` });
  assert.deepEqual(hits(journals, 'rare_account_pair'), ['RARE']);
});

test('スコアは重要度の合計で、高い順に並ぶ', () => {
  const entries = normalizeJournals([
    { ...base, id: 'LOW', description: '' }, // missing_description のみ = 2
    { ...base, id: 'HIGH', created_by: 'x', approved_by: 'x', description: '' }, // 10 + 2
  ]);
  const result = screen(entries, { rules: ['self_approval', 'missing_description'] });
  assert.deepEqual(result.ranked.map((r) => r.entryId), ['HIGH', 'LOW']);
  assert.equal(result.ranked[0].riskScore, 12);
  assert.equal(result.ranked[1].riskScore, 2);
});

test('サマリーの集計が検出件数と一致する', () => {
  const entries = normalizeJournals([
    { ...base, id: 'A', created_by: 'x', approved_by: 'x' },
    { ...base, id: 'B', description: '' },
  ]);
  const result = screen(entries);
  const total = Object.values(result.summary.bySeverity).reduce((a, b) => a + b, 0);
  assert.equal(total, result.summary.findingCount);
  assert.equal(result.findings.length, result.summary.findingCount);
});

test('fiscalYearEndFor は計上日が属する期の期末を返す', () => {
  assert.equal(
    fiscalYearEndFor(new Date('2026-01-14T00:00:00Z'), '03-31').toISOString().slice(0, 10),
    '2026-03-31'
  );
  assert.equal(
    fiscalYearEndFor(new Date('2025-04-01T00:00:00Z'), '03-31').toISOString().slice(0, 10),
    '2026-03-31'
  );
  assert.equal(
    fiscalYearEndFor(new Date('2026-03-31T00:00:00Z'), '03-31').toISOString().slice(0, 10),
    '2026-03-31'
  );
});
