/**
 * 仕訳データの正規化とバリデーション。
 *
 * 入力は2つの形を受ける。
 *   簡易形: { debit_account, credit_account, amount }
 *   明細形: { lines: [{ account, debit, credit }, ...] }
 * どちらも内部では明細形に寄せて扱う。
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class JournalError extends Error {
  constructor(message, index) {
    super(index === undefined ? message : `[${index + 1}件目] ${message}`);
    this.name = 'JournalError';
    this.index = index;
  }
}

function toNumber(value, label, index) {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) throw new JournalError(`${label} が数値として読めません: ${value}`, index);
  if (n < 0) throw new JournalError(`${label} が負です: ${value}`, index);
  return n;
}

/** 計上日を Date として読む。時刻は持たせない。 */
function parseDate(value, index) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new JournalError(`date は YYYY-MM-DD で指定してください: ${value}`, index);
  }
  const d = new Date(`${value}T00:00:00Z`);
  // JS の Date は 2026-02-30 を 3/2 に繰り上げてしまうため、書式だけでは実在判定にならない。
  // 往復させて元の文字列に戻るかどうかで見る。
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new JournalError(`date が実在しません: ${value}`, index);
  }
  return d;
}

/**
 * 入力日時を読む。オフセット付きならその地方時をそのまま採る。
 * 「何時に打ったか」を見たいので、UTC へ寄せずに現地の時刻を保つ。
 */
function parseEnteredAt(value, index) {
  if (value === undefined || value === null || value === '') return null;
  const m = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (!m) throw new JournalError(`entered_at の形式が読めません: ${value}`, index);
  const [, y, mo, d, h, mi, s] = m;
  return {
    raw: String(value),
    date: `${y}-${mo}-${d}`,
    hour: Number(h),
    minute: Number(mi),
    second: Number(s ?? 0),
    dow: new Date(`${y}-${mo}-${d}T00:00:00Z`).getUTCDay(),
  };
}

function normalizeLines(entry, index) {
  if (Array.isArray(entry.lines) && entry.lines.length > 0) {
    return entry.lines.map((line, i) => {
      const account = line.account ?? line.account_name;
      if (typeof account !== 'string' || account.trim() === '') {
        throw new JournalError(`lines[${i}].account が空です`, index);
      }
      return {
        account: account.trim(),
        debit: toNumber(line.debit, `lines[${i}].debit`, index),
        credit: toNumber(line.credit, `lines[${i}].credit`, index),
      };
    });
  }

  const dr = entry.debit_account ?? entry.debit;
  const cr = entry.credit_account ?? entry.credit;
  if (typeof dr !== 'string' || typeof cr !== 'string') {
    throw new JournalError('debit_account / credit_account または lines が必要です', index);
  }
  const amount = toNumber(entry.amount, 'amount', index);
  return [
    { account: dr.trim(), debit: amount, credit: 0 },
    { account: cr.trim(), debit: 0, credit: amount },
  ];
}

function normalizeEntry(entry, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new JournalError('仕訳はオブジェクトで指定してください', index);
  }
  const lines = normalizeLines(entry, index);
  const debitTotal = lines.reduce((a, l) => a + l.debit, 0);
  const creditTotal = lines.reduce((a, l) => a + l.credit, 0);

  return {
    id: String(entry.id ?? entry.voucher_no ?? `#${index + 1}`),
    index,
    date: entry.date,
    dateObj: parseDate(entry.date, index),
    enteredAt: parseEnteredAt(entry.entered_at ?? entry.created_at, index),
    lines,
    debitTotal,
    creditTotal,
    amount: Math.max(debitTotal, creditTotal),
    description: typeof entry.description === 'string' ? entry.description : '',
    createdBy: entry.created_by ?? entry.createdBy ?? null,
    approvedBy: entry.approved_by ?? entry.approvedBy ?? null,
    debitAccounts: lines.filter((l) => l.debit > 0).map((l) => l.account),
    creditAccounts: lines.filter((l) => l.credit > 0).map((l) => l.account),
  };
}

function normalizeJournals(journals) {
  if (!Array.isArray(journals)) throw new JournalError('journals は配列で指定してください');
  if (journals.length === 0) throw new JournalError('journals が空です');
  return journals.map((e, i) => normalizeEntry(e, i));
}

/**
 * 読めない仕訳を除外して、読めたものだけを返す。既定の normalizeJournals は1件でも読めなければ止まる。
 * 除外したものは、入力の何件目か・伝票番号・理由を添えて skipped に返す。
 * 読めた仕訳の index は入力の位置のまま保つので、検出結果の「何件目」は入力と一致する。
 */
function normalizeJournalsSkippingInvalid(journals) {
  if (!Array.isArray(journals)) throw new JournalError('journals は配列で指定してください');
  if (journals.length === 0) throw new JournalError('journals が空です');
  const entries = [];
  const skipped = [];
  journals.forEach((e, i) => {
    try {
      entries.push(normalizeEntry(e, i));
    } catch (err) {
      if (!(err instanceof JournalError)) throw err;
      skipped.push({ index: i, id: e?.id ?? e?.voucher_no ?? null, reason: err.message });
    }
  });
  if (entries.length === 0) {
    throw new JournalError(`読める仕訳が1件もありません（${skipped.length} 件すべてを除外しました。例: ${skipped[0].reason}）`);
  }
  return { entries, skipped };
}

export {
  normalizeJournals,
  normalizeJournalsSkippingInvalid,
  normalizeEntry,
  parseDate,
  parseEnteredAt,
  JournalError,
};
