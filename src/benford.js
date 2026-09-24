/**
 * ベンフォードの法則による初桁分析。
 *
 * 自然に発生した金額の集まりでは、先頭の桁は 1 が約30%、9 が約4.6%になる。
 * 人が金額を作ると、この形が崩れる。崩れ方そのものは不正の証拠ではない。
 * 「どの束をさきに見るか」を決めるための道具として使う。
 */

/** 先頭1桁の期待比率。d = 1..9 */
function expectedFirstDigit(d) {
  return Math.log10(1 + 1 / d);
}

/** 先頭2桁の期待比率。d = 10..99 */
function expectedFirstTwoDigits(d) {
  return Math.log10(1 + 1 / d);
}

/**
 * MAD（平均絶対偏差）の判定境界。
 * 出典: Nigrini, M. J. "Benford's Law" (Wiley, 2012), Table 5.1
 * 会計の実務で広く引かれている値で、法令や監査基準が定めたものではない。
 */
const MAD_THRESHOLDS = {
  1: [
    [0.006, 'close conformity'],
    [0.012, 'acceptable conformity'],
    [0.015, 'marginally acceptable conformity'],
    [Infinity, 'nonconformity'],
  ],
  2: [
    [0.0012, 'close conformity'],
    [0.0018, 'acceptable conformity'],
    [0.0022, 'marginally acceptable conformity'],
    [Infinity, 'nonconformity'],
  ],
};

const CONFORMITY_JA = {
  'close conformity': '適合（乖離なし）',
  'acceptable conformity': '許容範囲',
  'marginally acceptable conformity': '許容の限界',
  nonconformity: '不適合（要確認）',
};

/** 自由度8（先頭1桁）の χ² 5%点。先頭2桁は自由度89。 */
const CHI2_CRITICAL_5PCT = { 1: 15.507, 2: 112.022 };

function leadingDigits(value, digits) {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return null;
  const s = abs.toExponential(15).split('e')[0].replace('.', '').replace('-', '');
  if (s.length < digits) return null;
  const n = Number(s.slice(0, digits));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number[]} amounts 金額の配列
 * @param {1|2} digits 1 = 先頭1桁、2 = 先頭2桁
 */
function benfordAnalysis(amounts, digits = 1) {
  if (digits !== 1 && digits !== 2) throw new Error('digits は 1 または 2 を指定してください');

  const lo = digits === 1 ? 1 : 10;
  const hi = digits === 1 ? 9 : 99;
  const expectedFn = digits === 1 ? expectedFirstDigit : expectedFirstTwoDigits;

  const counts = new Map();
  for (let d = lo; d <= hi; d += 1) counts.set(d, 0);

  let sampleSize = 0;
  let skipped = 0;
  for (const a of amounts) {
    const d = leadingDigits(a, digits);
    if (d === null || d < lo || d > hi) {
      skipped += 1;
      continue;
    }
    counts.set(d, counts.get(d) + 1);
    sampleSize += 1;
  }

  if (sampleSize === 0) {
    return { digits, sampleSize: 0, skipped, distribution: [], mad: null, chiSquare: null,
      conformity: null, conformityJa: null, note: '判定可能な金額がありません。' };
  }

  const distribution = [];
  let absDevSum = 0;
  let chiSquare = 0;

  for (let d = lo; d <= hi; d += 1) {
    const observed = counts.get(d);
    const expectedRatio = expectedFn(d);
    const expected = expectedRatio * sampleSize;
    const observedRatio = observed / sampleSize;
    absDevSum += Math.abs(observedRatio - expectedRatio);
    chiSquare += ((observed - expected) ** 2) / expected;
    distribution.push({
      digit: d,
      observed,
      observedRatio: Number(observedRatio.toFixed(5)),
      expectedRatio: Number(expectedRatio.toFixed(5)),
      deviation: Number((observedRatio - expectedRatio).toFixed(5)),
    });
  }

  const mad = absDevSum / (hi - lo + 1);
  const band = MAD_THRESHOLDS[digits].find(([limit]) => mad < limit);
  const conformity = band[1];
  const critical = CHI2_CRITICAL_5PCT[digits];

  return {
    digits,
    sampleSize,
    skipped,
    distribution,
    mad: Number(mad.toFixed(6)),
    conformity,
    conformityJa: CONFORMITY_JA[conformity],
    chiSquare: Number(chiSquare.toFixed(3)),
    chiSquareCritical5pct: critical,
    chiSquareExceeded: chiSquare > critical,
    note:
      sampleSize < 300
        ? 'サンプルが300件未満です。MADの判定境界は大標本を前提にしているため、参考値として扱ってください。'
        : null,
  };
}

export { benfordAnalysis, expectedFirstDigit, expectedFirstTwoDigits, leadingDigits, MAD_THRESHOLDS };
