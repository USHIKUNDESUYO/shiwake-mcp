/**
 * 日本の祝日（国民の祝日・振替休日・国民の休日）。
 *
 * 内閣府の一覧を取り込むと、毎年の差し替えと、外から持ってきたデータの出どころの説明が要る。
 * 祝日法の規定から計算すれば、このファイルの中で閉じる。
 * 春分の日・秋分の日は前年の官報で告示される日付で、ここでは広く使われている近似式で求める。
 * 近似式が使えるのは 2000〜2099 年なので、それ以外の年は祝日なしとして扱う。
 */

const FIRST_YEAR = 2000;
const LAST_YEAR = 2099;
const DAY = 86400000;

const cache = new Map();

function iso(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function shift(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function dayOfWeek(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** その月の第 n 月曜日が何日か。成人の日・海の日・敬老の日・体育の日（ハッピーマンデー）に使う。 */
function nthMonday(year, month, n) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((8 - firstDow) % 7) + (n - 1) * 7;
}

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 国民の祝日（祝日法2条）。振替休日と国民の休日は、これをもとに後から足す。 */
function nationalHolidays(year) {
  const h = new Map();
  const add = (month, day, name) => h.set(iso(year, month, day), name);

  add(1, 1, '元日');
  add(1, nthMonday(year, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (year >= 2020) add(2, 23, '天皇誕生日');
  add(3, vernalEquinoxDay(year), '春分の日');
  add(4, 29, year >= 2007 ? '昭和の日' : 'みどりの日');
  add(5, 3, '憲法記念日');
  if (year >= 2007) add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  // 東京オリンピック・パラリンピックの特別措置法で、2020年と2021年は3つの祝日が夏へ移った
  if (year === 2020) {
    add(7, 23, '海の日');
    add(7, 24, 'スポーツの日');
    add(8, 10, '山の日');
  } else if (year === 2021) {
    add(7, 22, '海の日');
    add(7, 23, 'スポーツの日');
    add(8, 8, '山の日');
  } else {
    add(7, year >= 2003 ? nthMonday(year, 7, 3) : 20, '海の日');
    if (year >= 2016) add(8, 11, '山の日');
    add(10, nthMonday(year, 10, 2), year >= 2020 ? 'スポーツの日' : '体育の日');
  }
  add(9, year >= 2003 ? nthMonday(year, 9, 3) : 15, '敬老の日');
  add(9, autumnalEquinoxDay(year), '秋分の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (year <= 2018) add(12, 23, '天皇誕生日');
  // 天皇の即位に伴い、2019年に限って祝日とされた2日
  if (year === 2019) {
    add(5, 1, '天皇の即位の日');
    add(10, 22, '即位礼正殿の儀');
  }
  return h;
}

function build(year) {
  const national = nationalHolidays(year);
  const all = new Map(national);

  // 振替休日：祝日が日曜なら、2007年以降は「その日後の最も近い祝日でない日」、それより前は翌日
  for (const date of national.keys()) {
    if (dayOfWeek(date) !== 0) continue;
    let d = shift(date, 1);
    if (year >= 2007) while (national.has(d)) d = shift(d, 1);
    if (!national.has(d)) all.set(d, '振替休日');
  }

  // 国民の休日：前日と翌日がどちらも国民の祝日である日（2006年までは日曜を除く）
  for (const date of national.keys()) {
    const d = shift(date, 1);
    if (national.has(d) || all.has(d) || !national.has(shift(d, 1))) continue;
    if (year < 2007 && dayOfWeek(d) === 0) continue;
    all.set(d, '国民の休日');
  }

  return all;
}

function holidaysOf(year) {
  if (!cache.has(year)) {
    cache.set(year, year >= FIRST_YEAR && year <= LAST_YEAR ? build(year) : new Map());
  }
  return cache.get(year);
}

/** YYYY-MM-DD が日本の祝日なら、その名前を返す。祝日でなければ null。 */
function japaneseHolidayName(date) {
  return holidaysOf(Number(date.slice(0, 4))).get(date) ?? null;
}

export { japaneseHolidayName, FIRST_YEAR, LAST_YEAR };
