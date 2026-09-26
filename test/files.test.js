import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { dataDirsFrom, resolveAllowedFile, readJournalFile, FileAccessError } from '../src/files.js';

// 「日付,借方勘定科目,貸方勘定科目,金額,摘要」の見出しと、仕訳1行（現金／売上高 1000 店頭売上）を Shift_JIS で書いたもの
const SJIS_CSV = Buffer.from(
  '93fa95742c8ed895fb8aa892e889c896da2c91dd95fb8aa892e889c896da2c8be08a7a2c934597760d0a323032362f30312f31342c8cbb8be02c94848fe38d822c313030302c935893aa94848fe30d0a',
  'hex'
);

/** 許可するフォルダと、その外のフォルダを一時ディレクトリに作る。 */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'shiwake-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  writeFileSync(
    join(allowed, 'ok.json'),
    JSON.stringify([{ date: '2026-01-14', debit_account: '現金', credit_account: '売上高', amount: 1000 }])
  );
  writeFileSync(join(allowed, 'notes.txt'), 'x');
  writeFileSync(join(outside, 'secret.json'), '[]');
  return { allowed, outside };
}

test('--data-dir と SHIWAKE_DATA_DIR の両方から、読んでよいフォルダを集める', () => {
  assert.deepEqual(
    dataDirsFrom(['--data-dir', 'A', '--other', '--data-dir', 'B'], { SHIWAKE_DATA_DIR: `C${delimiter}D` }),
    ['A', 'B', 'C', 'D']
  );
  assert.deepEqual(dataDirsFrom([], {}), []);
});

test('許可したフォルダの中は相対パスでも絶対パスでも読み、外は読まない', (t) => {
  const { allowed, outside } = sandbox(t);
  assert.equal(readJournalFile(resolveAllowedFile('ok.json', [allowed])).journals.length, 1);
  assert.equal(readJournalFile(resolveAllowedFile(join(allowed, 'ok.json'), [allowed])).journals.length, 1);
  assert.throws(() => resolveAllowedFile(join(outside, 'secret.json'), [allowed]), FileAccessError);
  assert.throws(() => resolveAllowedFile(join('..', 'outside', 'secret.json'), [allowed]), FileAccessError);
  assert.throws(() => resolveAllowedFile(allowed, [allowed]), FileAccessError); // フォルダそのもの
});

test('許可フォルダの中から、リンクで外のフォルダを指しても読まない', (t) => {
  const { allowed, outside } = sandbox(t);
  // Windows は管理者権限なしでもジャンクションなら作れる。POSIX では 'junction' は無視され、普通のシンボリックリンクになる
  symlinkSync(outside, join(allowed, 'linkdir'), 'junction');
  assert.throws(() => resolveAllowedFile(join('linkdir', 'secret.json'), [allowed]), /外にあるファイルは読みません/);
});

test('許可フォルダの指定が無い・見つからないときは、起動時の指定を案内する', () => {
  assert.throws(() => resolveAllowedFile('ok.json', []), /--data-dir/);
  assert.throws(() => resolveAllowedFile('ok.json', [join(tmpdir(), 'shiwake-no-such-dir-xyz')]), /見つかりません/);
});

test('.json と .csv 以外は読まない', (t) => {
  const { allowed } = sandbox(t);
  assert.throws(() => readJournalFile(resolveAllowedFile('notes.txt', [allowed])), /\.json と \.csv/);
});

test('Shift_JIS の CSV を読む', (t) => {
  const { allowed } = sandbox(t);
  writeFileSync(join(allowed, 'sjis.csv'), SJIS_CSV);
  const loaded = readJournalFile(resolveAllowedFile('sjis.csv', [allowed]));
  assert.equal(loaded.format, 'csv');
  assert.equal(loaded.columnsUsed.debit_account, '借方勘定科目');
  assert.deepEqual(
    loaded.journals[0].lines.map((l) => l.account),
    ['現金', '売上高']
  );
  assert.equal(loaded.journals[0].description, '店頭売上');
});

test('UTF-8 の BOM 付き CSV を読む', (t) => {
  const { allowed } = sandbox(t);
  writeFileSync(join(allowed, 'bom.csv'), '﻿日付,借方科目,貸方科目,金額\n2026/01/14,現金,売上高,1000\n');
  assert.equal(readJournalFile(resolveAllowedFile('bom.csv', [allowed])).columnsUsed.date, '日付');
});

test('列が当たらない CSV は、ファイルの読み込みエラーとして返す', (t) => {
  const { allowed } = sandbox(t);
  writeFileSync(join(allowed, 'odd.csv'), 'a,b,c\n1,2,3\n');
  assert.throws(() => readJournalFile(resolveAllowedFile('odd.csv', [allowed])), FileAccessError);
});
