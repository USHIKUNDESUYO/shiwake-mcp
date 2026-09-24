#!/usr/bin/env node
/**
 * デモ用の仕訳データを作る。
 *
 * 実在のデータは使えないので、通常の取引に既知の異常を混ぜた合成データを置く。
 * 乱数は固定シードで回すため、何度実行しても同じファイルになる。
 *
 *   node examples/generate.js > examples/journals.sample.json
 */

/** mulberry32。結果を再現させるためだけの簡易PRNG。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260924);

const PATTERNS = [
  { debit: '仕入高', credit: '買掛金', desc: '原材料仕入' },
  { debit: '売掛金', credit: '売上高', desc: '製品売上' },
  { debit: '買掛金', credit: '普通預金', desc: '仕入先支払' },
  { debit: '普通預金', credit: '売掛金', desc: '売掛金回収' },
  { debit: '旅費交通費', credit: '未払金', desc: '出張精算' },
  { debit: '消耗品費', credit: '未払金', desc: '事務用品購入' },
  { debit: '外注費', credit: '買掛金', desc: '業務委託' },
  { debit: '支払手数料', credit: '普通預金', desc: '振込手数料' },
  { debit: '給料手当', credit: '未払費用', desc: '給与計上' },
  { debit: '地代家賃', credit: '普通預金', desc: '事務所家賃' },
];

const USERS = ['acc01', 'acc02', 'acc03', 'acc04'];
const APPROVERS = ['mgr01', 'mgr02'];

/**
 * 対数スケールで散らす。ちょうど3桁ぶんの一様分布にすると、
 * 先頭桁はベンフォードの形にほぼ乗る。異常を混ぜる前の土台として使う。
 */
function naturalAmount() {
  return Math.round(10 ** (3 + rand() * 3));
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function dateOf(dayOffset) {
  const base = Date.UTC(2025, 3, 1); // 2025-04-01 スタートの3月決算
  const d = new Date(base + dayOffset * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * 通常の取引は平日に寄せる。土日に均等に散らすと休日ルールが母集団の
 * 4分の1を拾ってしまい、実際の総勘定元帳と形が変わってしまう。
 */
function businessDateOf(dayOffset) {
  for (let i = 0; i < 7; i += 1) {
    const date = dateOf(dayOffset + i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return date;
  }
  return dateOf(dayOffset);
}

function enteredAt(date, hour, lagDays = 0) {
  const d = new Date(`${date}T00:00:00Z`);
  const e = new Date(d.getTime() + lagDays * 86400000);
  return `${e.getUTCFullYear()}-${pad(e.getUTCMonth() + 1)}-${pad(e.getUTCDate())}T${pad(hour)}:${pad(Math.floor(rand() * 60))}:00+09:00`;
}

const journals = [];
let seq = 0;

function push(entry) {
  seq += 1;
  journals.push({ id: `JV-${pad(seq, 4)}`, ...entry });
}

// --- 通常の取引を360件 -------------------------------------------------------
for (let i = 0; i < 360; i += 1) {
  const p = PATTERNS[Math.floor(rand() * PATTERNS.length)];
  const day = Math.floor(rand() * 364);
  const date = businessDateOf(day);
  push({
    date,
    entered_at: enteredAt(date, 9 + Math.floor(rand() * 9), Math.floor(rand() * 3)),
    debit_account: p.debit,
    credit_account: p.credit,
    amount: naturalAmount(),
    description: `${p.desc} ${pad(Math.floor(rand() * 28) + 1)}日分`,
    created_by: USERS[Math.floor(rand() * USERS.length)],
    approved_by: APPROVERS[Math.floor(rand() * APPROVERS.length)],
  });
}

// --- 以下、既知の異常を意図的に混ぜる ----------------------------------------

// 貸借不一致 2件
push({
  date: '2025-11-14',
  entered_at: '2025-11-14T15:20:00+09:00',
  lines: [
    { account: '仕入高', debit: 480000, credit: 0 },
    { account: '買掛金', debit: 0, credit: 448000 },
  ],
  description: '原材料仕入（取込時に金額欠落）',
  created_by: 'acc02',
  approved_by: 'mgr01',
});
push({
  date: '2026-01-22',
  entered_at: '2026-01-22T11:05:00+09:00',
  lines: [
    { account: '外注費', debit: 1200000, credit: 0 },
    { account: '買掛金', debit: 0, credit: 1000000 },
    { account: '仮払消費税', debit: 0, credit: 120000 },
  ],
  description: '業務委託費計上',
  created_by: 'acc03',
  approved_by: 'mgr02',
});

// 起票者と承認者が同一 3件
for (const [date, amount, user] of [
  ['2025-08-29', 2840000, 'acc01'],
  ['2025-12-26', 5120000, 'acc03'],
  ['2026-03-30', 8900000, 'acc01'],
]) {
  push({
    date,
    entered_at: enteredAt(date, 20, 0),
    debit_account: '外注費',
    credit_account: '未払金',
    amount,
    description: '開発委託費',
    created_by: user,
    approved_by: user,
  });
}

// 承認限度額（1,000,000）の直下 5件
for (const [date, amount] of [
  ['2025-06-18', 987000],
  ['2025-06-19', 992000],
  ['2025-06-20', 975000],
  ['2025-09-11', 998000],
  ['2025-09-12', 981000],
]) {
  push({
    date,
    entered_at: enteredAt(date, 17, 0),
    debit_account: '消耗品費',
    credit_account: '未払金',
    amount,
    description: '備品購入',
    created_by: 'acc04',
    approved_by: 'mgr01',
  });
}

// 完全重複 2グループ
for (let i = 0; i < 2; i += 1) {
  push({
    date: '2025-10-31',
    entered_at: '2025-10-31T16:40:00+09:00',
    debit_account: '支払手数料',
    credit_account: '普通預金',
    amount: 330000,
    description: '10月分手数料',
    created_by: 'acc02',
    approved_by: 'mgr02',
  });
}
for (let i = 0; i < 3; i += 1) {
  push({
    date: '2026-02-27',
    entered_at: '2026-02-27T10:15:00+09:00',
    debit_account: '地代家賃',
    credit_account: '普通預金',
    amount: 1450000,
    description: '2月分家賃',
    created_by: 'acc01',
    approved_by: 'mgr01',
  });
}

// 計上日から大きく遅れた入力 3件
for (const [date, lag, amount] of [
  ['2025-07-15', 68, 3400000],
  ['2025-12-05', 45, 1870000],
  ['2026-02-10', 52, 6200000],
]) {
  push({
    date,
    entered_at: enteredAt(date, 22, lag),
    debit_account: '売掛金',
    credit_account: '売上高',
    amount,
    description: '売上計上（遡及）',
    created_by: 'acc03',
    approved_by: 'mgr02',
  });
}

// 期末直前の大口 3件
for (const [date, amount] of [
  ['2026-03-30', 48000000],
  ['2026-03-31', 52000000],
  ['2026-03-29', 39000000],
]) {
  push({
    date,
    entered_at: enteredAt(date, 21, 0),
    debit_account: '売掛金',
    credit_account: '売上高',
    amount,
    description: '期末大口売上',
    created_by: 'acc01',
    approved_by: 'mgr01',
  });
}

// 稀な科目の組み合わせ 2件
push({
  date: '2025-09-06',
  entered_at: '2025-09-06T23:50:00+09:00',
  debit_account: '役員貸付金',
  credit_account: '現金',
  amount: 3000000,
  description: '',
  created_by: 'acc01',
  approved_by: 'acc01',
});
push({
  date: '2026-01-04',
  entered_at: '2026-01-04T08:12:00+09:00',
  debit_account: '雑損失',
  credit_account: '仮払金',
  amount: 1700000,
  description: '',
  created_by: 'acc04',
  approved_by: 'mgr02',
});

process.stdout.write(`${JSON.stringify(journals, null, 2)}\n`);
