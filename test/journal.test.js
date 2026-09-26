import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeJournals, normalizeJournalsSkippingInvalid, JournalError } from '../src/journal.js';

test('簡易形は借方1行・貸方1行に展開される', () => {
  const [e] = normalizeJournals([
    { date: '2026-03-31', debit_account: '売掛金', credit_account: '売上高', amount: 100000 },
  ]);
  assert.equal(e.lines.length, 2);
  assert.equal(e.debitTotal, 100000);
  assert.equal(e.creditTotal, 100000);
  assert.deepEqual(e.debitAccounts, ['売掛金']);
  assert.deepEqual(e.creditAccounts, ['売上高']);
});

test('明細形は複数行のまま合計される', () => {
  const [e] = normalizeJournals([
    {
      date: '2026-03-31',
      lines: [
        { account: '外注費', debit: 1000000 },
        { account: '仮払消費税', debit: 100000 },
        { account: '買掛金', credit: 1100000 },
      ],
    },
  ]);
  assert.equal(e.debitTotal, 1100000);
  assert.equal(e.creditTotal, 1100000);
  assert.deepEqual(e.debitAccounts, ['外注費', '仮払消費税']);
});

test('貸借が合わない明細もそのまま保持する（判定はルール側の仕事）', () => {
  const [e] = normalizeJournals([
    { date: '2026-03-31', lines: [{ account: 'A', debit: 100 }, { account: 'B', credit: 90 }] },
  ]);
  assert.equal(e.debitTotal, 100);
  assert.equal(e.creditTotal, 90);
});

test('カンマ区切りの金額を読む', () => {
  const [e] = normalizeJournals([
    { date: '2026-03-31', debit_account: 'A', credit_account: 'B', amount: '1,234,567' },
  ]);
  assert.equal(e.amount, 1234567);
});

test('idを省略すると連番が振られる', () => {
  const entries = normalizeJournals([
    { date: '2026-03-31', debit_account: 'A', credit_account: 'B', amount: 1 },
    { date: '2026-03-31', debit_account: 'A', credit_account: 'B', amount: 2 },
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['#1', '#2']);
});

test('entered_at のオフセットは現地時刻として読む', () => {
  const [e] = normalizeJournals([
    {
      date: '2026-03-31',
      entered_at: '2026-04-02T23:41:00+09:00',
      debit_account: 'A',
      credit_account: 'B',
      amount: 1,
    },
  ]);
  assert.equal(e.enteredAt.hour, 23);
  assert.equal(e.enteredAt.date, '2026-04-02');
});

test('日付の書式が違えば落とす', () => {
  assert.throws(
    () => normalizeJournals([{ date: '2026/03/31', debit_account: 'A', credit_account: 'B', amount: 1 }]),
    JournalError
  );
});

test('実在しない日付は落とす', () => {
  assert.throws(
    () => normalizeJournals([{ date: '2026-02-30', debit_account: 'A', credit_account: 'B', amount: 1 }]),
    JournalError
  );
});

test('負の金額は落とす', () => {
  assert.throws(
    () => normalizeJournals([{ date: '2026-03-31', debit_account: 'A', credit_account: 'B', amount: -1 }]),
    JournalError
  );
});

test('科目が欠けていれば何件目かを添えて落とす', () => {
  try {
    normalizeJournals([
      { date: '2026-03-31', debit_account: 'A', credit_account: 'B', amount: 1 },
      { date: '2026-03-31', amount: 1 },
    ]);
    assert.fail('例外が投げられていません');
  } catch (err) {
    assert.ok(err instanceof JournalError);
    assert.match(err.message, /2件目/);
  }
});

test('空配列は落とす', () => {
  assert.throws(() => normalizeJournals([]), JournalError);
});

test('除外モードでは読めない行だけを外し、何件目か・伝票番号・理由を返す', () => {
  const { entries, skipped } = normalizeJournalsSkippingInvalid([
    { id: 'OK1', date: '2026-01-14', debit_account: 'A', credit_account: 'B', amount: 100 },
    { id: 'NEG', date: '2026-01-14', debit_account: 'A', credit_account: 'B', amount: -5 },
    { id: 'SLASH', date: '2026/01/14', debit_account: 'A', credit_account: 'B', amount: 100 },
    { id: 'OK2', date: '2026-01-15', debit_account: 'A', credit_account: 'B', amount: 200 },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.id, e.index]),
    [
      ['OK1', 0],
      ['OK2', 3],
    ]
  );
  assert.deepEqual(
    skipped.map((s) => [s.id, s.index]),
    [
      ['NEG', 1],
      ['SLASH', 2],
    ]
  );
  assert.match(skipped[0].reason, /2件目.*負/);
});

test('除外モードでも、1件も読めなければ落とす', () => {
  assert.throws(() => normalizeJournalsSkippingInvalid([{ date: '2026/01/14' }]), JournalError);
  assert.throws(() => normalizeJournalsSkippingInvalid([]), JournalError);
});
