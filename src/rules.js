/**
 * 仕訳スクリーニングのルール群。
 *
 * どのルールも「不正を見つける」ものではない。母集団のうち、
 * 先に人間が目を通すべき束を絞り込むためのものになる。
 * 検出された仕訳が正当な処理であることは普通にある。
 */

import { benfordAnalysis } from './benford.js';
import { japaneseHolidayName } from './holidays.js';

const SEVERITY_SCORE = { high: 10, medium: 5, low: 2 };

/** 重複仕訳の検出に添える、相方の伝票番号の上限。 */
const SIBLING_IDS_LIMIT = 20;

const DEFAULT_OPTIONS = {
  businessHours: [9, 18],
  holidays: [],
  japaneseHolidays: true,
  exemptMonthEnd: true,
  approvalThresholds: [],
  thresholdMarginRatio: 0.05,
  fiscalYearEnd: null,
  periodEndWindowDays: 5,
  largeAmountPercentile: 0.95,
  roundAmountUnit: 100000,
  roundAmountMinimum: 100000,
  rareAccountPairMaxCount: 2,
  rarePairMinSampleSize: 50,
  backdatedDaysThreshold: 30,
  reversalWindowDays: 30,
  descriptionKeywords: ['修正', '訂正', '取消', '調整', '仮計上', '不明'],
  voucherGapMaxMissingRatio: 0.5,
};

function resolveOptions(options = {}) {
  return { ...DEFAULT_OPTIONS, ...options };
}

function finding(rule, severity, entry, message, detail = {}) {
  return {
    rule,
    severity,
    score: SEVERITY_SCORE[severity],
    entryId: entry ? entry.id : null,
    entryIndex: entry ? entry.index : null,
    date: entry ? entry.date : null,
    amount: entry ? entry.amount : null,
    message,
    detail,
  };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** 決算日 MM-DD から、その仕訳が属する期の期末日を返す。 */
function fiscalYearEndFor(dateObj, mmdd) {
  const [mm, dd] = mmdd.split('-').map(Number);
  const y = dateObj.getUTCFullYear();
  const sameYear = new Date(Date.UTC(y, mm - 1, dd));
  return dateObj <= sameYear ? sameYear : new Date(Date.UTC(y + 1, mm - 1, dd));
}

/** その日が月末日か。翌日が別の月になるかで見る（うるう年は2月29日が月末になる）。 */
function isMonthEnd(dateObj) {
  return new Date(dateObj.getTime() + 86400000).getUTCMonth() !== dateObj.getUTCMonth();
}

/** 借方・貸方それぞれの科目を並べ替えて返す。明細の行の順番だけで結果が変わらないようにするため。 */
function accountSides(e) {
  return [[...e.debitAccounts].sort().join('/'), [...e.creditAccounts].sort().join('/')];
}

/** 重複仕訳の判定キー。計上日・金額・借方科目・貸方科目が同じものを同じとみなす。 */
function duplicateKey(e) {
  return [e.date, e.amount, ...accountSides(e)].join('|');
}

const RULES = [
  {
    id: 'unbalanced',
    title: '貸借不一致',
    severity: 'high',
    rationale:
      '借方合計と貸方合計が一致しない仕訳。システム経由では通常起きないため、手入力・取込不良・改変のいずれかを示す。',
    run(entries) {
      return entries
        .filter((e) => e.debitTotal !== e.creditTotal)
        .map((e) =>
          finding(
            'unbalanced',
            'high',
            e,
            `借方 ${e.debitTotal.toLocaleString()} と貸方 ${e.creditTotal.toLocaleString()} が一致しません`,
            {
              debitTotal: e.debitTotal,
              creditTotal: e.creditTotal,
              difference: e.debitTotal - e.creditTotal,
            }
          )
        );
    },
  },

  {
    id: 'self_approval',
    title: '起票者と承認者が同一',
    severity: 'high',
    rationale:
      '職務分掌が効いていない状態を示す。統制の設計不備か、運用上の例外処理のいずれか。',
    run(entries) {
      return entries
        .filter((e) => e.createdBy && e.approvedBy && e.createdBy === e.approvedBy)
        .map((e) =>
          finding('self_approval', 'high', e, `起票と承認がいずれも ${e.createdBy} です`, {
            user: e.createdBy,
          })
        );
    },
  },

  {
    id: 'threshold_avoidance',
    title: '承認限度額の直下',
    severity: 'high',
    rationale:
      '上位承認が必要になる金額のすぐ下に金額が張り付く現象。分割計上による承認回避の典型的な形。',
    run(entries, o) {
      if (!o.approvalThresholds.length) return [];
      const out = [];
      for (const e of entries) {
        for (const t of o.approvalThresholds) {
          const floor = t * (1 - o.thresholdMarginRatio);
          if (e.amount < t && e.amount >= floor) {
            out.push(
              finding(
                'threshold_avoidance',
                'high',
                e,
                `承認限度額 ${t.toLocaleString()} の直下（${e.amount.toLocaleString()}）です`,
                { threshold: t, gap: t - e.amount, marginRatio: o.thresholdMarginRatio }
              )
            );
            break;
          }
        }
      }
      return out;
    },
  },

  {
    id: 'duplicate',
    title: '重複仕訳',
    severity: 'medium',
    rationale:
      '日付・金額・勘定科目の組み合わせが完全に一致する仕訳。二重計上か、正当な繰り返し取引のいずれか。',
    run(entries) {
      const groups = new Map();
      for (const e of entries) {
        const key = duplicateKey(e);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      const out = [];
      for (const [key, group] of groups) {
        if (group.length < 2) continue;
        // 相方の伝票番号は先頭から SIBLING_IDS_LIMIT 件まで。同じ仕訳が数百件並ぶ元帳で、1件ごとに全員の番号を持たせると応答が膨らむ
        const head = group.slice(0, SIBLING_IDS_LIMIT + 1).map((g) => g.id);
        for (const e of group) {
          out.push(
            finding('duplicate', 'medium', e, `同一条件の仕訳が ${group.length} 件あります`, {
              key,
              groupSize: group.length,
              siblingIds: head.filter((id) => id !== e.id).slice(0, SIBLING_IDS_LIMIT),
            })
          );
        }
      }
      return out;
    },
  },

  {
    id: 'reversal',
    title: '取消・訂正仕訳',
    severity: 'medium',
    rationale:
      '同じ金額で借方と貸方を入れ替えた仕訳が、近い日付にある組。誤りの取消か訂正で、期末をまたぐ組は期間帰属の確認につながる。期首の洗替仕訳もこの形になるため、期末をまたいでも重要度は上げない。',
    run(entries, o) {
      const keyOf = (amount, dr, cr) => `${amount}|${dr}|${cr}`;
      const byKey = new Map();
      for (const e of entries) {
        const [dr, cr] = accountSides(e);
        if (e.amount <= 0 || dr === cr) continue;
        const key = keyOf(e.amount, dr, cr);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(e);
      }

      // 日付順に見て、貸借を入れ替えた同額の仕訳のうち、期間内でいちばん近い前のものと組にする。1件は1組にしか入れない
      const paired = new Set();
      const out = [];
      const chronological = [...entries].sort((a, b) => a.dateObj - b.dateObj || a.index - b.index);
      for (const later of chronological) {
        if (paired.has(later.index)) continue;
        const [dr, cr] = accountSides(later);
        if (later.amount <= 0 || dr === cr) continue;
        let original = null;
        let originalLag = Infinity;
        for (const c of byKey.get(keyOf(later.amount, cr, dr)) ?? []) {
          if (paired.has(c.index)) continue;
          const lag = daysBetween(c.dateObj, later.dateObj);
          if (lag < 0 || lag > o.reversalWindowDays || (lag === 0 && c.index > later.index)) continue;
          if (lag < originalLag || (lag === originalLag && c.index > original.index)) {
            original = c;
            originalLag = lag;
          }
        }
        if (!original) continue;
        paired.add(original.index);
        paired.add(later.index);

        let crossing = null;
        if (o.fiscalYearEnd) {
          const fye = fiscalYearEndFor(original.dateObj, o.fiscalYearEnd);
          if (later.dateObj > fye) crossing = fye.toISOString().slice(0, 10);
        }
        const note = crossing ? `（期末 ${crossing} をまたいでいます）` : '';
        const detail = { lagDays: originalLag, crossesPeriodEnd: crossing !== null, periodEnd: crossing };
        out.push(
          finding(
            'reversal',
            'medium',
            original,
            `${originalLag} 日後の ${later.id} で、同じ金額の貸借を入れ替えた仕訳があります${note}`,
            { ...detail, pairId: later.id, role: 'original' }
          ),
          finding(
            'reversal',
            'medium',
            later,
            `${originalLag} 日前の ${original.id} と同じ金額で、借方と貸方が入れ替わっています${note}`,
            { ...detail, pairId: original.id, role: 'reversal' }
          )
        );
      }
      return out;
    },
  },

  {
    id: 'backdated',
    title: '計上日と入力日の乖離',
    severity: 'medium',
    rationale: '入力が計上日より大きく遅れている仕訳。期間帰属の誤りか、事後的な遡及計上。',
    run(entries, o) {
      const out = [];
      for (const e of entries) {
        if (!e.enteredAt) continue;
        const entered = new Date(`${e.enteredAt.date}T00:00:00Z`);
        const lag = daysBetween(e.dateObj, entered);
        if (lag > o.backdatedDaysThreshold) {
          out.push(
            finding('backdated', 'medium', e, `計上日から ${lag} 日後に入力されています`, {
              enteredAt: e.enteredAt.raw,
              lagDays: lag,
              thresholdDays: o.backdatedDaysThreshold,
            })
          );
        }
      }
      return out;
    },
  },

  {
    id: 'post_period_entry',
    title: '期末後の入力',
    severity: 'medium',
    rationale:
      '期末日より後に入力された、期末日以前の日付の仕訳。決算整理と締めたあとの修正がここに集まり、経営者による内部統制の無効化が現れやすい。計上日と入力日の乖離（既定30日）より短い遅れも拾う。',
    run(entries, o) {
      if (!o.fiscalYearEnd) return [];
      const out = [];
      for (const e of entries) {
        if (!e.enteredAt) continue;
        const fye = fiscalYearEndFor(e.dateObj, o.fiscalYearEnd);
        const after = daysBetween(fye, new Date(`${e.enteredAt.date}T00:00:00Z`));
        if (after <= 0) continue;
        const periodEnd = fye.toISOString().slice(0, 10);
        out.push(
          finding(
            'post_period_entry',
            'medium',
            e,
            `期末 ${periodEnd} の ${after} 日後（${e.enteredAt.date}）に入力された、${e.date} 付の仕訳です`,
            { periodEnd, enteredDate: e.enteredAt.date, daysAfterPeriodEnd: after }
          )
        );
      }
      return out;
    },
  },

  {
    id: 'period_end_large',
    title: '期末直前の大口計上',
    severity: 'medium',
    rationale: '期末に寄った大口の仕訳。利益調整が行われるとすれば、まずこの窓に現れる。',
    run(entries, o) {
      if (!o.fiscalYearEnd) return [];
      const sorted = entries.map((e) => e.amount).sort((a, b) => a - b);
      const cutoff = percentile(sorted, o.largeAmountPercentile);
      const pct = Math.round((1 - o.largeAmountPercentile) * 100);
      const out = [];
      for (const e of entries) {
        if (e.amount < cutoff) continue;
        const fye = fiscalYearEndFor(e.dateObj, o.fiscalYearEnd);
        const daysToEnd = daysBetween(e.dateObj, fye);
        if (daysToEnd >= 0 && daysToEnd <= o.periodEndWindowDays) {
          out.push(
            finding(
              'period_end_large',
              'medium',
              e,
              `期末の ${daysToEnd} 日前に、上位 ${pct}% の金額が計上されています`,
              {
                fiscalYearEnd: fye.toISOString().slice(0, 10),
                daysToPeriodEnd: daysToEnd,
                amountCutoff: cutoff,
              }
            )
          );
        }
      }
      return out;
    },
  },

  {
    id: 'rare_account_pair',
    title: '稀な勘定科目の組み合わせ',
    severity: 'medium',
    rationale:
      '母集団のなかでほとんど現れない借方・貸方の組み合わせ。通常の取引フローから外れた処理を示す。',
    run(entries, o) {
      if (entries.length < o.rarePairMinSampleSize) return [];
      const keyOf = (e) => accountSides(e).join(' / ');
      const counts = new Map();
      for (const e of entries) counts.set(keyOf(e), (counts.get(keyOf(e)) ?? 0) + 1);
      return entries
        .filter((e) => counts.get(keyOf(e)) <= o.rareAccountPairMaxCount)
        .map((e) =>
          finding(
            'rare_account_pair',
            'medium',
            e,
            `この組み合わせは母集団で ${counts.get(keyOf(e))} 件しかありません: ${keyOf(e)}`,
            { pair: keyOf(e), occurrences: counts.get(keyOf(e)), sampleSize: entries.length }
          )
        );
    },
  },

  {
    id: 'weekend_or_holiday',
    title: '休日の計上',
    severity: 'low',
    rationale:
      '土日・日本の祝日（振替休日と国民の休日を含む）・指定された休日に計上された仕訳。通常の業務サイクルの外で処理されている。月末日付の仕訳は既定で対象から外す（月次・期末の整理仕訳は、土日でも月末の日付で計上されることが多いため）。',
    run(entries, o) {
      const holidays = new Set(o.holidays);
      const out = [];
      for (const e of entries) {
        const dow = e.dateObj.getUTCDay();
        const isWeekend = dow === 0 || dow === 6;
        const holidayName = o.japaneseHolidays ? japaneseHolidayName(e.date) : null;
        const isHoliday = holidays.has(e.date) || holidayName !== null;
        if (!isWeekend && !isHoliday) continue;
        // 3月31日が日曜の年でも、決算整理仕訳は3月31日付で入る。これを休日の計上として数えると、期末の整理が全部当たる。
        if (o.exemptMonthEnd && isMonthEnd(e.dateObj)) continue;
        let label = `${dow === 0 ? '日曜' : '土曜'}の計上です`;
        if (holidayName) label = `祝日（${holidayName}・${e.date}）の計上です`;
        else if (isHoliday) label = `休日（${e.date}）の計上です`;
        out.push(
          finding('weekend_or_holiday', 'low', e, label, { dayOfWeek: dow, isWeekend, isHoliday, holidayName })
        );
      }
      return out;
    },
  },

  {
    id: 'after_hours',
    title: '営業時間外の入力',
    severity: 'low',
    rationale:
      '始業前・終業後に入力された仕訳。単独では意味が薄いが、他のルールと重なると見る順番が上がる。',
    run(entries, o) {
      const [open, close] = o.businessHours;
      return entries
        .filter((e) => e.enteredAt?.hour != null && (e.enteredAt.hour < open || e.enteredAt.hour >= close))
        .map((e) => {
          const hh = String(e.enteredAt.hour).padStart(2, '0');
          const mm = String(e.enteredAt.minute).padStart(2, '0');
          return finding(
            'after_hours',
            'low',
            e,
            `${hh}:${mm} に入力されています（業務時間 ${open}:00-${close}:00）`,
            { enteredAt: e.enteredAt.raw, hour: e.enteredAt.hour, businessHours: [open, close] }
          );
        });
    },
  },

  {
    id: 'round_amount',
    title: 'キリのよい金額',
    severity: 'low',
    rationale:
      '実際の取引から生まれた金額は端数を持つことが多い。見積・概算・付け替えは丸い金額になりやすい。',
    run(entries, o) {
      return entries
        .filter((e) => e.amount >= o.roundAmountMinimum && e.amount % o.roundAmountUnit === 0)
        .map((e) =>
          finding(
            'round_amount',
            'low',
            e,
            `${o.roundAmountUnit.toLocaleString()} 単位でちょうどの金額です（${e.amount.toLocaleString()}）`,
            { unit: o.roundAmountUnit }
          )
        );
    },
  },

  {
    id: 'missing_description',
    title: '摘要が空',
    severity: 'low',
    rationale:
      '摘要のない仕訳は、後から誰も内容を再現できない。監査証跡としての品質の問題になる。',
    run(entries) {
      return entries
        .filter((e) => e.description.trim() === '')
        .map((e) => finding('missing_description', 'low', e, '摘要が入力されていません'));
    },
  },

  {
    id: 'description_keyword',
    title: '摘要のキーワード',
    severity: 'low',
    rationale:
      '摘要に「修正」「訂正」「取消」「調整」「仮計上」「不明」などの語を含む仕訳。事後の手直しや、内容の定まっていない計上を示す。語は descriptionKeywords で差し替えられる。',
    run(entries, o) {
      const words = o.descriptionKeywords.filter((w) => typeof w === 'string' && w !== '');
      if (!words.length) return [];
      const out = [];
      for (const e of entries) {
        const hit = words.filter((w) => e.description.includes(w));
        if (hit.length === 0) continue;
        out.push(
          finding('description_keyword', 'low', e, `摘要に「${hit.join('」「')}」が含まれます`, { keywords: hit })
        );
      }
      return out;
    },
  },

  {
    id: 'voucher_gap',
    title: '伝票番号の欠番',
    severity: 'low',
    rationale:
      '伝票番号の連番が途切れている箇所。削除・取消された伝票か、出力の漏れを示す。欠けているのは仕訳そのものなので、前後の仕訳のスコアには入れず、欠番の一覧として返す。',
    run(entries, o) {
      // 伝票番号を「頭の文字」と「末尾の数字」に分け、頭の文字ごとに連番を見る（JV-0382 → JV- と 382）
      const groups = new Map();
      for (const e of entries) {
        if (!e.hasId) continue;
        const m = e.id.match(/^(.*?)(\d+)$/);
        if (!m) continue;
        const [, prefix, digits] = m;
        if (!groups.has(prefix)) groups.set(prefix, new Map());
        groups.get(prefix).set(Number(digits), digits.length);
      }

      const out = [];
      for (const [prefix, widths] of groups) {
        const numbers = [...widths.keys()].sort((a, b) => a - b);
        if (numbers.length < 2) continue;
        const span = numbers[numbers.length - 1] - numbers[0] + 1;
        // 範囲の半分以上が欠けているなら、連番で振った番号ではないとみなして見ない
        if ((span - numbers.length) / span > o.voucherGapMaxMissingRatio) continue;
        for (let i = 1; i < numbers.length; i += 1) {
          const prev = numbers[i - 1];
          const next = numbers[i];
          if (next - prev <= 1) continue;
          const width = widths.get(prev);
          const label = (n) => `${prefix}${String(n).padStart(width, '0')}`;
          const missing = next - prev - 1;
          out.push(
            finding('voucher_gap', 'low', null, `伝票番号 ${label(prev)} の次が ${label(next)} です（${missing} 件欠番）`, {
              prefix,
              after: label(prev),
              before: label(next),
              missingCount: missing,
              missingFrom: label(prev + 1),
              missingTo: label(next - 1),
            })
          );
        }
      }
      return out;
    },
  },
];

const RULE_INDEX = new Map(RULES.map((r) => [r.id, r]));

/** 全ルールを適用して、仕訳ごとにスコアを集計する。 */
function screen(entries, options = {}) {
  const o = resolveOptions(options);
  const selected = options.rules?.length ? RULES.filter((r) => options.rules.includes(r.id)) : RULES;

  const findings = selected.flatMap((r) => r.run(entries, o));

  // 読めない仕訳を除外したときは、配列の位置と入力の「何件目」がずれる。index で引き直す。
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const byEntry = new Map();
  for (const f of findings) {
    if (f.entryIndex === null) continue;
    if (!byEntry.has(f.entryIndex)) byEntry.set(f.entryIndex, { score: 0, rules: [] });
    const bucket = byEntry.get(f.entryIndex);
    bucket.score += f.score;
    bucket.rules.push(f.rule);
  }

  const ranked = [...byEntry.entries()]
    .map(([index, v]) => {
      const e = byIndex.get(index);
      return {
        entryId: e.id,
        entryIndex: index,
        date: e.date,
        amount: e.amount,
        description: e.description,
        riskScore: v.score,
        hitRules: [...new Set(v.rules)],
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore || a.entryIndex - b.entryIndex);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byRule = {};
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }

  return {
    summary: {
      entryCount: entries.length,
      findingCount: findings.length,
      flaggedEntryCount: ranked.length,
      bySeverity,
      byRule,
      rulesApplied: selected.map((r) => r.id),
    },
    ranked,
    findings,
    benford: benfordAnalysis(entries.map((e) => e.amount), 1),
  };
}

export {
  RULES,
  RULE_INDEX,
  screen,
  resolveOptions,
  DEFAULT_OPTIONS,
  SEVERITY_SCORE,
  fiscalYearEndFor,
  accountSides,
  duplicateKey,
};
