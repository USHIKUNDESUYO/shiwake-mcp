import test from 'node:test';
import assert from 'node:assert/strict';

import { csvToJournals, parseCsv, normalizeDate, normalizeDateTime, normalizeAmount, CsvError } from '../src/csv.js';
import { normalizeJournals } from '../src/journal.js';

test('引用符の中のカンマ・改行・二重引用符を読み、空の行は捨てる', () => {
  const rows = parseCsv('a,"b,c","d\n e","f""g"\r\n1,2,3,4\r\n\r\n');
  assert.deepEqual(rows, [
    ['a', 'b,c', 'd\n e', 'f"g'],
    ['1', '2', '3', '4'],
  ]);
});

test('日付は西暦・区切りなし・和暦を YYYY-MM-DD にし、時刻は落とす', () => {
  assert.equal(normalizeDate('2026/3/31'), '2026-03-31');
  assert.equal(normalizeDate('2026.03.31'), '2026-03-31');
  assert.equal(normalizeDate('20260331'), '2026-03-31');
  assert.equal(normalizeDate('2026年3月31日'), '2026-03-31');
  assert.equal(normalizeDate('R8.3.31'), '2026-03-31');
  assert.equal(normalizeDate('令和8年3月31日'), '2026-03-31');
  assert.equal(normalizeDate('令和元年5月1日'), '2019-05-01');
  assert.equal(normalizeDate('H31/04/30'), '2019-04-30');
  assert.equal(normalizeDate('2026/03/31 0:00:00'), '2026-03-31');
  assert.equal(normalizeDate('3月31日'), '3月31日'); // 読めない形はそのまま渡し、仕訳の検査で止める
});

test('入力日時は、時刻があれば秒まで、無ければ日付だけにする', () => {
  assert.equal(normalizeDateTime('2026/04/02 9:05'), '2026-04-02T09:05:00');
  assert.equal(normalizeDateTime('2026/04/02 23:41:10'), '2026-04-02T23:41:10');
  assert.equal(normalizeDateTime('2026/04/02'), '2026-04-02');
  assert.equal(normalizeDateTime(''), '');
});

test('金額の桁区切り・円記号を落とし、△と括弧は負の数にする', () => {
  assert.equal(normalizeAmount('1,234,567'), '1234567');
  assert.equal(normalizeAmount('¥12,000'), '12000');
  assert.equal(normalizeAmount('１２，０００円'), '12000');
  assert.equal(normalizeAmount('△5,000'), '-5000');
  assert.equal(normalizeAmount('(5,000)'), '-5000');
});

test('列名は表記ゆれごと自動で当て、どの列を使ったかを返す', () => {
  const csv = [
    '伝票No.,取引日,借方 勘定科目,借方金額(税込),貸方勘定科目,貸方金額（税込）,摘要,入力者',
    'V-1,2026/01/14,現金,"1,000",売上高,"1,000",店頭売上,acc01',
  ].join('\n');
  const { journals, columnsUsed } = csvToJournals(csv);
  assert.deepEqual(columnsUsed, {
    id: '伝票No.',
    date: '取引日',
    debit_account: '借方 勘定科目',
    credit_account: '貸方勘定科目',
    debit_amount: '借方金額(税込)',
    credit_amount: '貸方金額（税込）',
    description: '摘要',
    created_by: '入力者',
  });
  const [e] = normalizeJournals(journals);
  assert.equal(e.id, 'V-1');
  assert.equal(e.date, '2026-01-14');
  assert.equal(e.amount, 1000);
  assert.deepEqual([e.debitAccounts, e.creditAccounts], [['現金'], ['売上高']]);
  assert.equal(e.createdBy, 'acc01');
});

test('伝票番号と日付が同じ行は1つの仕訳にまとめ、諸口は貸借で同額なら取り除く', () => {
  const csv = [
    '伝票番号,日付,借方科目,借方金額,貸方科目,貸方金額,摘要',
    '10,2026/03/31,外注費,1000000,諸口,1000000,業務委託',
    '10,2026/03/31,仮払消費税,100000,諸口,100000,',
    '10,2026/03/31,諸口,1100000,買掛金,1100000,',
    '11,2026/03/31,現金,500,売上高,500,',
  ].join('\n');
  const { journals, rowOf } = csvToJournals(csv);
  assert.equal(journals.length, 2);
  assert.deepEqual(rowOf, [2, 5]);
  const [e] = normalizeJournals(journals);
  assert.deepEqual(e.debitAccounts, ['外注費', '仮払消費税']);
  assert.deepEqual(e.creditAccounts, ['買掛金']);
  assert.equal(e.amount, 1100000);
  assert.equal(e.description, '業務委託');
});

test('諸口が貸借で合わないときは、ずれを隠さないよう残す', () => {
  const csv = [
    '伝票番号,日付,借方科目,借方金額,貸方科目,貸方金額',
    '1,2026/03/31,外注費,1000,諸口,1000',
    '1,2026/03/31,諸口,900,買掛金,900',
  ].join('\n');
  const [e] = normalizeJournals(csvToJournals(csv).journals);
  assert.ok(e.debitAccounts.includes('諸口'));
});

test('伝票番号の列が無ければ1行を1つの仕訳にし、金額の列が1つなら貸借に同じ金額を使う', () => {
  const csv = ['日付,借方科目,貸方科目,金額', '2026/01/14,現金,売上高,"1,000"', '2026/01/15,現金,売上高,2000'].join('\n');
  const entries = normalizeJournals(csvToJournals(csv).journals);
  assert.deepEqual(
    entries.map((e) => [e.debitTotal, e.creditTotal, e.hasId]),
    [
      [1000, 1000, false],
      [2000, 2000, false],
    ]
  );
});

test('見出しの前にある表題の行は飛ばし、行番号は見出しを含めて数える', () => {
  const csv = ['仕訳日記帳', '期間 2026/01/01-2026/01/31', '日付,借方科目,貸方科目,金額', '2026/01/14,現金,売上高,1000'].join('\n');
  const { journals, rowOf, rowCount } = csvToJournals(csv);
  assert.equal(journals.length, 1);
  assert.equal(rowCount, 1);
  assert.deepEqual(rowOf, [4]);
});

test('列が当たらないときは、探した列名と見出しを添えて止め、columns で指定すれば読める', () => {
  const csv = ['伝票日付X,借方,貸方,税込金額', '2026/01/14,現金,売上高,1000'].join('\n');
  assert.throws(
    () => csvToJournals(csv),
    (err) => err instanceof CsvError && /日付/.test(err.message) && /columns/.test(err.message) && /伝票日付X/.test(err.message)
  );
  const { journals } = csvToJournals(csv, {
    date: '伝票日付X',
    debit_account: '借方',
    credit_account: '貸方',
    amount: '税込金額',
  });
  const [e] = normalizeJournals(journals);
  assert.equal(e.date, '2026-01-14');
  assert.equal(e.amount, 1000);
});

test('列が足りないときは、いちばん多く列が当たった行を見出しの候補として示す', () => {
  const csv = ['仕訳日記帳', '伝票番号,伝票日付X,借方科目,貸方科目,金額', '1,2026/01/14,現金,売上高,1000'].join('\n');
  assert.throws(
    () => csvToJournals(csv),
    (err) => err instanceof CsvError && /2 行目/.test(err.message) && /伝票日付X/.test(err.message) && !/借方科目（/.test(err.message)
  );
});

test('columns に無い項目名や、見出しに無い列名は止める', () => {
  const csv = ['日付,借方科目,貸方科目,金額', '2026/01/14,現金,売上高,1000'].join('\n');
  assert.throws(() => csvToJournals(csv, { dates: '日付' }), CsvError);
  assert.throws(() => csvToJournals(csv, { date: '存在しない列' }), CsvError);
});

/** 弥生インポート形式の1行（25項目）を作る。片側だけの行は、もう片側を空にする。 */
function yayoiRow({ flag, id = '', date, dr = '', drAmount = '', cr = '', crAmount = '', memo = '' }) {
  const row = new Array(25).fill('');
  row[0] = flag;
  row[1] = id;
  row[3] = date;
  row[4] = dr;
  row[8] = drAmount;
  row[10] = cr;
  row[14] = crAmount;
  row[16] = memo;
  row[19] = '0';
  row[24] = 'no';
  return row.join(',');
}

test('弥生インポート形式（見出しなし）を、識別フラグで伝票ごとにまとめて読む', () => {
  const csv = [
    yayoiRow({ flag: '2000', id: '1', date: '2026/3/1', dr: '現金', drAmount: '1000', cr: '売上高', crAmount: '1000', memo: '店頭売上' }),
    yayoiRow({ flag: '2110', id: '2', date: 'R08/03/31', dr: '外注費', drAmount: '1000000', memo: '業務委託' }),
    yayoiRow({ flag: '2100', id: '2', date: 'R08/03/31', dr: '仮払消費税', drAmount: '100000' }),
    yayoiRow({ flag: '2101', id: '2', date: 'R08/03/31', cr: '買掛金', crAmount: '1100000' }),
    yayoiRow({ flag: '2111', id: '3', date: '20260331', dr: '支払手数料', drAmount: '660', cr: '普通預金', crAmount: '660' }),
  ].join('\r\n');
  const { journals, rowOf, layout, columnsUsed } = csvToJournals(csv);
  assert.equal(layout, 'yayoi');
  assert.match(columnsUsed.date, /取引日付/);
  assert.deepEqual(rowOf, [1, 2, 5]);

  const entries = normalizeJournals(journals);
  assert.deepEqual(
    entries.map((e) => [e.id, e.date, e.debitTotal, e.creditTotal]),
    [
      ['1', '2026-03-01', 1000, 1000],
      ['2', '2026-03-31', 1100000, 1100000],
      ['3', '2026-03-31', 660, 660],
    ]
  );
  assert.deepEqual(entries[1].debitAccounts, ['外注費', '仮払消費税']);
  assert.equal(entries[1].description, '業務委託');
});

test('見出しのある CSV は、1項目めが数字でも弥生インポート形式とはみなさない', () => {
  const csv = ['伝票番号,日付,借方科目,貸方科目,金額', '2000,2026/01/14,現金,売上高,1000'].join('\n');
  assert.equal(csvToJournals(csv).layout, 'header');
});

test('空の CSV は止める', () => {
  assert.throws(() => csvToJournals('\n\n'), CsvError);
});
