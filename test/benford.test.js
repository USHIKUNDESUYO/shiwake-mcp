import test from 'node:test';
import assert from 'node:assert/strict';

import { benfordAnalysis, expectedFirstDigit, leadingDigits } from '../src/benford.js';

test('先頭桁の期待比率は log10(1 + 1/d)', () => {
  assert.ok(Math.abs(expectedFirstDigit(1) - 0.30103) < 1e-5);
  assert.ok(Math.abs(expectedFirstDigit(9) - 0.045757) < 1e-5);
  const total = [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((a, d) => a + expectedFirstDigit(d), 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
});

test('先頭桁の切り出しは桁数によらず正しい', () => {
  assert.equal(leadingDigits(12345, 1), 1);
  assert.equal(leadingDigits(12345, 2), 12);
  assert.equal(leadingDigits(9, 1), 9);
  assert.equal(leadingDigits(0.00432, 1), 4);
  assert.equal(leadingDigits(0, 1), null);
  assert.equal(leadingDigits(999999, 2), 99);
});

test('対数一様な金額はベンフォードに適合する', () => {
  // 3桁ぶんを等間隔に刻むと、理屈のうえでは先頭桁が分布どおりに出る。
  const amounts = [];
  for (let i = 0; i < 6000; i += 1) amounts.push(10 ** (3 + (i / 6000) * 3));
  const r = benfordAnalysis(amounts, 1);
  assert.equal(r.sampleSize, 6000);
  assert.ok(r.mad < 0.006, `MAD が大きすぎます: ${r.mad}`);
  assert.equal(r.conformity, 'close conformity');
});

test('先頭桁が1に偏ったデータは不適合になる', () => {
  const amounts = Array.from({ length: 1000 }, (_, i) => 1000 + i);
  const r = benfordAnalysis(amounts, 1);
  assert.equal(r.conformity, 'nonconformity');
  assert.ok(r.chiSquareExceeded);
});

test('0 と非数は判定から外し、件数を報告する', () => {
  const r = benfordAnalysis([0, NaN, 123, 456], 1);
  assert.equal(r.sampleSize, 2);
  assert.equal(r.skipped, 2);
});

test('サンプルが小さいときは注記が付く', () => {
  const r = benfordAnalysis([123, 234, 345], 1);
  assert.match(r.note, /300件未満/);
});

test('判定できる金額がなければ空の結果を返す', () => {
  const r = benfordAnalysis([0, 0], 1);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.mad, null);
});

test('先頭2桁は10から99までを集計する', () => {
  const amounts = [];
  for (let i = 0; i < 9000; i += 1) amounts.push(10 ** (3 + (i / 9000) * 3));
  const r = benfordAnalysis(amounts, 2);
  assert.equal(r.distribution.length, 90);
  assert.equal(r.distribution[0].digit, 10);
  assert.equal(r.distribution.at(-1).digit, 99);
});

test('digits に 1 と 2 以外を渡すと落ちる', () => {
  assert.throws(() => benfordAnalysis([123], 3), /digits/);
});
