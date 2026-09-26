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

test('duplicate: 同じ仕訳が大量に並んでも、相方の伝票番号は20件までにする', () => {
  const journals = [];
  for (let i = 0; i < 30; i += 1) journals.push({ ...base, id: `D${i}` });
  const result = screen(normalizeJournals(journals), { rules: ['duplicate'] });
  assert.equal(result.findings.length, 30);
  assert.equal(result.findings[0].detail.groupSize, 30);
  assert.equal(result.findings[0].detail.siblingIds.length, 20);
  assert.ok(!result.findings[0].detail.siblingIds.includes('D0'));
});

test('duplicate: 明細の行の順番だけが違う同じ仕訳も重複として拾う', () => {
  const lines = [
    { account: '外注費', debit: 1000000 },
    { account: '仮払消費税', debit: 100000 },
    { account: '買掛金', credit: 1100000 },
  ];
  const found = hits(
    [
      { id: 'A', date: '2026-02-10', lines },
      { id: 'B', date: '2026-02-10', lines: [lines[1], lines[0], lines[2]] },
    ],
    'duplicate'
  );
  assert.deepEqual(found, ['A', 'B']);
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

test('weekend_or_holiday: 休日を渡さなくても日本の祝日を拾い、祝日名を添える', () => {
  const entries = normalizeJournals([
    { ...base, id: 'WED', date: '2026-01-14' },
    { ...base, id: 'COMING_OF_AGE', date: '2026-01-12' }, // 成人の日（月曜）
    { ...base, id: 'CITIZENS', date: '2026-09-22' }, // 国民の休日（火曜）
  ]);
  const result = screen(entries, { rules: ['weekend_or_holiday'] });
  assert.deepEqual(result.findings.map((f) => f.entryId), ['COMING_OF_AGE', 'CITIZENS']);
  assert.equal(result.findings[0].detail.holidayName, '成人の日');
  assert.match(result.findings[0].message, /祝日（成人の日・2026-01-12）/);
});

test('weekend_or_holiday: japaneseHolidays を false にすると祝日は見ない', () => {
  const found = hits([{ ...base, id: 'COMING_OF_AGE', date: '2026-01-12' }], 'weekend_or_holiday', {
    japaneseHolidays: false,
  });
  assert.deepEqual(found, []);
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

test('rare_account_pair: 明細の行の順番が違っても同じ組み合わせとして数える', () => {
  const lines = [
    { account: '外注費', debit: 100000 },
    { account: '仮払消費税', debit: 10000 },
    { account: '買掛金', credit: 110000 },
  ];
  // 1件だけ行の順番を変える。順番で組み合わせを数えると、この1件が「稀」になってしまう
  const journals = [];
  for (let i = 0; i < 60; i += 1) {
    const ordered = i === 0 ? [lines[1], lines[0], lines[2]] : lines;
    journals.push({ ...base, id: `N${i}`, lines: ordered });
  }
  assert.deepEqual(hits(journals, 'rare_account_pair'), []);
});

test('読めない仕訳を除外して index が飛んでも、上位の一覧は入力の仕訳を指す', () => {
  const [first, , third] = normalizeJournals([
    { ...base, id: 'KEEP1', description: '' },
    { ...base, id: 'DROPPED' },
    { ...base, id: 'KEEP2', created_by: 'x', approved_by: 'x' },
  ]);
  const result = screen([first, third], { rules: ['self_approval', 'missing_description'] });
  assert.deepEqual(
    result.ranked.map((r) => [r.entryId, r.entryIndex]),
    [
      ['KEEP2', 2],
      ['KEEP1', 0],
    ]
  );
});

test('reversal: 同じ金額で貸借が逆の組を、両方に相手の伝票番号を添えて拾う', () => {
  const entries = normalizeJournals([
    { ...base, id: 'SALE', date: '2026-01-10', debit_account: '売掛金', credit_account: '売上高', amount: 2350000 },
    { ...base, id: 'CANCEL', date: '2026-01-24', debit_account: '売上高', credit_account: '売掛金', amount: 2350000 },
    { ...base, id: 'OTHER', date: '2026-01-24', debit_account: '売上高', credit_account: '売掛金', amount: 999 },
  ]);
  const result = screen(entries, { rules: ['reversal'] });
  assert.deepEqual(
    result.findings.map((f) => [f.entryId, f.detail.pairId, f.detail.lagDays, f.detail.role]),
    [
      ['SALE', 'CANCEL', 14, 'original'],
      ['CANCEL', 'SALE', 14, 'reversal'],
    ]
  );
});

test('reversal: 期間を超えた組は拾わず、期末をまたぐ組は重要度を変えずに理由へ書き添える', () => {
  const found = (journals, options) => screen(normalizeJournals(journals), { rules: ['reversal'], ...options }).findings;
  const far = found([
    { ...base, id: 'A', date: '2026-01-01', debit_account: '売掛金', credit_account: '売上高', amount: 5000 },
    { ...base, id: 'B', date: '2026-03-01', debit_account: '売上高', credit_account: '売掛金', amount: 5000 },
  ]);
  assert.equal(far.length, 0);

  const crossing = found(
    [
      { ...base, id: 'A', date: '2026-03-27', debit_account: '売掛金', credit_account: '売上高', amount: 5000 },
      { ...base, id: 'B', date: '2026-04-03', debit_account: '売上高', credit_account: '売掛金', amount: 5000 },
    ],
    { fiscalYearEnd: '03-31' }
  );
  assert.equal(crossing.length, 2);
  assert.equal(crossing[0].detail.crossesPeriodEnd, true);
  assert.equal(crossing[0].severity, 'medium');
  assert.match(crossing[1].message, /期末 2026-03-31 をまたいでいます/);
});

test('reversal: 1件は1組にしか入れず、同じ向きの重複どうしは組にしない', () => {
  // R1 は近いほうの A2 と組になる。R2 は A2 がもう組になっているので、残った A1 と組になる
  const found = hits(
    [
      { ...base, id: 'A1', date: '2026-01-10', debit_account: '売掛金', credit_account: '売上高', amount: 700 },
      { ...base, id: 'A2', date: '2026-01-10', debit_account: '売掛金', credit_account: '売上高', amount: 700 },
      { ...base, id: 'R1', date: '2026-01-12', debit_account: '売上高', credit_account: '売掛金', amount: 700 },
      { ...base, id: 'R2', date: '2026-01-14', debit_account: '売上高', credit_account: '売掛金', amount: 700 },
    ],
    'reversal'
  );
  assert.deepEqual(found, ['A2', 'R1', 'A1', 'R2']);
});

test('description_keyword: 既定の語を拾い、descriptionKeywords で差し替え、空の配列なら止まる', () => {
  const journals = [
    { ...base, id: 'FIX', description: '前月分の売上修正' },
    { ...base, id: 'TEMP', description: '仮払金精算' }, // 「仮」1文字は既定の語に入れていない
    { ...base, id: 'PLAIN', description: '通常取引' },
  ];
  assert.deepEqual(hits(journals, 'description_keyword'), ['FIX']);
  assert.deepEqual(hits(journals, 'description_keyword', { descriptionKeywords: ['精算'] }), ['TEMP']);
  assert.deepEqual(hits(journals, 'description_keyword', { descriptionKeywords: [] }), []);
});

test('voucher_gap: 頭の文字ごとに連番の飛びを拾い、仕訳のスコアには入れない', () => {
  const journals = ['JV-0001', 'JV-0002', 'JV-0005', 'JV-0006', 'AP-10', 'AP-11'].map((id) => ({ ...base, id }));
  const result = screen(normalizeJournals(journals), { rules: ['voucher_gap'] });
  assert.equal(result.findings.length, 1);
  const [gap] = result.findings;
  assert.equal(gap.entryId, null);
  assert.deepEqual(
    [gap.detail.after, gap.detail.before, gap.detail.missingCount, gap.detail.missingFrom, gap.detail.missingTo],
    ['JV-0002', 'JV-0005', 2, 'JV-0003', 'JV-0004']
  );
  assert.equal(result.ranked.length, 0);
  assert.equal(result.summary.byRule.voucher_gap, 1);
});

test('voucher_gap: 連番でない番号（範囲の半分以上が欠ける）と、伝票番号の無い仕訳は見ない', () => {
  const sparse = ['X-1', 'X-50', 'X-99'].map((id) => ({ ...base, id }));
  assert.equal(screen(normalizeJournals(sparse), { rules: ['voucher_gap'] }).findings.length, 0);

  // 伝票番号が無い仕訳には #1, #2… を振るが、これは欠番の判定に混ぜない
  const [first, , third] = normalizeJournals([{ ...base }, { ...base }, { ...base }]);
  assert.equal(screen([first, third], { rules: ['voucher_gap'] }).findings.length, 0);
});

test('入力日時が日付だけの仕訳は、営業時間外としては拾わず、遡及入力としては拾う', () => {
  const journals = [{ ...base, id: 'DATEONLY', date: '2026-01-14', entered_at: '2026-03-01' }];
  assert.deepEqual(hits(journals, 'after_hours'), []);
  assert.deepEqual(hits(journals, 'backdated'), ['DATEONLY']);
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
