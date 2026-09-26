import test from 'node:test';
import assert from 'node:assert/strict';

import { japaneseHolidayName } from '../src/holidays.js';

// 内閣府の「国民の祝日」一覧（2000〜2027年）と1日ずつ突き合わせて一致を確かめた実装。
// ここには、規定の分岐が効く日だけを並べる。

test('ハッピーマンデーの祝日は月曜に来る', () => {
  assert.equal(japaneseHolidayName('2026-01-12'), '成人の日');
  assert.equal(japaneseHolidayName('2026-07-20'), '海の日');
  assert.equal(japaneseHolidayName('2026-09-21'), '敬老の日');
  assert.equal(japaneseHolidayName('2026-10-12'), 'スポーツの日');
  assert.equal(japaneseHolidayName('2019-10-14'), '体育の日');
});

test('春分の日・秋分の日は年によって日付が動く', () => {
  assert.equal(japaneseHolidayName('2026-03-20'), '春分の日');
  assert.equal(japaneseHolidayName('2025-03-20'), '春分の日');
  assert.equal(japaneseHolidayName('2026-09-23'), '秋分の日');
  assert.equal(japaneseHolidayName('2024-09-22'), '秋分の日');
  assert.equal(japaneseHolidayName('2024-09-23'), '振替休日');
});

test('振替休日：日曜の祝日の後の、最も近い祝日でない日', () => {
  assert.equal(japaneseHolidayName('2025-11-24'), '振替休日'); // 勤労感謝の日が日曜
  assert.equal(japaneseHolidayName('2020-02-24'), '振替休日'); // 天皇誕生日が日曜
  assert.equal(japaneseHolidayName('2019-05-06'), '振替休日'); // こどもの日が日曜
  assert.equal(japaneseHolidayName('2008-05-06'), '振替休日'); // みどりの日が日曜 → 5/5 を飛ばして 5/6
});

test('国民の休日：祝日に挟まれた平日', () => {
  assert.equal(japaneseHolidayName('2026-09-22'), '国民の休日'); // 敬老の日と秋分の日の間
  assert.equal(japaneseHolidayName('2019-04-30'), '国民の休日');
  assert.equal(japaneseHolidayName('2019-05-02'), '国民の休日');
});

test('天皇誕生日は2018年まで12月23日、2019年は無く、2020年から2月23日', () => {
  assert.equal(japaneseHolidayName('2018-12-23'), '天皇誕生日');
  assert.equal(japaneseHolidayName('2019-12-23'), null);
  assert.equal(japaneseHolidayName('2019-02-23'), null);
  assert.equal(japaneseHolidayName('2020-02-23'), '天皇誕生日');
});

test('2019年の即位の祝日と、2020・2021年の東京大会による移動', () => {
  assert.equal(japaneseHolidayName('2019-05-01'), '天皇の即位の日');
  assert.equal(japaneseHolidayName('2019-10-22'), '即位礼正殿の儀');
  assert.equal(japaneseHolidayName('2020-07-24'), 'スポーツの日');
  assert.equal(japaneseHolidayName('2020-10-12'), null);
  assert.equal(japaneseHolidayName('2021-08-08'), '山の日');
  assert.equal(japaneseHolidayName('2021-08-09'), '振替休日');
  assert.equal(japaneseHolidayName('2021-08-11'), null);
});

test('祝日でない日と、対応範囲の外の年は null', () => {
  assert.equal(japaneseHolidayName('2026-01-14'), null);
  assert.equal(japaneseHolidayName('1999-01-01'), null);
  assert.equal(japaneseHolidayName('2100-01-01'), null);
});
