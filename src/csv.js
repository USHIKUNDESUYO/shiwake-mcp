/**
 * 会計ソフトなどから書き出した CSV を、仕訳の配列にする。
 *
 * 列名は日本語の表記ゆれごと自動で当てる（「取引日」「伝票日付」→ 日付、など）。当たらない列は columns で指定する。
 * 1行が「借方の科目・金額」と「貸方の科目・金額」を持つ形を前提に、伝票番号と日付が同じ行を1つの仕訳にまとめる。
 * 複合仕訳の相手科目に使われる「諸口」は、借方と貸方で同額なら取り除く。
 *
 * 弥生会計の「弥生インポート形式」は見出しの行が無いので、列名ではなく列の位置で読む（yayoiToJournals）。
 *
 * 値の検査（日付の実在、金額が数値か、など）はここではしない。読めない値はそのまま渡し、
 * 仕訳の正規化（journal.js）で「何件目のどこが読めないか」を返す。
 */

class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

/** 項目ごとの列名の候補。見出しは normalizeHeader をかけてから比べる。 */
const FIELDS = {
  id: ['伝票番号', '伝票no', '仕訳番号', '仕訳no', '取引番号', '取引no', 'no', 'id', 'voucher_no'],
  date: ['日付', '取引日', '計上日', '伝票日付', '仕訳日', '発生日', 'date'],
  entered_at: ['入力日時', '登録日時', '作成日時', '入力日', '登録日', '作成日', 'entered_at', 'created_at'],
  debit_account: ['借方勘定科目', '借方科目', '借方勘定', 'debit_account'],
  credit_account: ['貸方勘定科目', '貸方科目', '貸方勘定', 'credit_account'],
  debit_amount: ['借方金額', 'debit_amount'],
  credit_amount: ['貸方金額', 'credit_amount'],
  amount: ['金額', '取引金額', 'amount'],
  description: ['摘要', '摘要文', '内容', 'description'],
  created_by: ['入力者', '起票者', '作成者', '登録者', 'created_by'],
  approved_by: ['承認者', 'approved_by'],
};

const REQUIRED = [
  ['date', '日付'],
  ['debit_account', '借方科目'],
  ['credit_account', '貸方科目'],
];

/** 見出しを比べやすい形にする。全角英数は半角へ、括弧の注記（「(税込)」など）と空白・記号は落とす。 */
function normalizeHeader(h) {
  return String(h)
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s"'.・]/g, '')
    .toLowerCase();
}

/** RFC 4180 の範囲で読む。引用符の中のカンマ・改行・二重引用符（""）に対応する。空の行は捨てる。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else inQuotes = false;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * 日付を YYYY-MM-DD にする。2026/3/31・2026.03.31・20260331・2026年3月31日・和暦（R8.3.31・令和8年3月31日・H31/04/30）を読む。
 * 時刻が付いていれば日付だけを採る。読めない形はそのまま返す。
 */
function normalizeDate(value) {
  const s = String(value).normalize('NFKC').trim().split(/[ T]+/)[0];
  let m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/) ?? s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (m) return ymd(m[1], m[2], m[3]);
  m = s.match(/^(R|H|令和|平成)\.?(\d{1,2}|元)[/.年-](\d{1,2})[/.月-](\d{1,2})日?$/i);
  if (m) {
    const base = /^(r|令和)$/i.test(m[1]) ? 2018 : 1988;
    return ymd(base + (m[2] === '元' ? 1 : Number(m[2])), m[3], m[4]);
  }
  return value;
}

/** 入力日時を YYYY-MM-DDTHH:MM:SS（時刻が無ければ YYYY-MM-DD）にする。読めない形はそのまま返す。 */
function normalizeDateTime(value) {
  const s = String(value).normalize('NFKC').trim();
  if (s === '') return '';
  const [d, t] = s.split(/[ T]+/);
  const date = normalizeDate(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  if (!t) return date;
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? `${date}T${pad2(m[1])}:${m[2]}:${m[3] ?? '00'}` : value;
}

/**
 * 金額の表記をそろえる。桁区切り・円記号を落とし、△・▲・括弧は負の数にする（負の金額は仕訳の検査で止まる）。
 * Shift_JIS の書き出しでは円記号が「\」で読めることがあるので、それも落とす。
 */
function normalizeAmount(value) {
  let s = String(value).normalize('NFKC').replace(/[,\s¥円\\]/g, '');
  if (/^[△▲]/.test(s)) s = `-${s.slice(1)}`;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) s = `-${paren[1]}`;
  return s;
}

/** 見出しの行から、項目ごとに何列目を使うかを決める。columns の指定があればそちらを優先する。 */
function mapColumns(header, columns = {}) {
  const normalized = header.map(normalizeHeader);
  const index = {};
  for (const [field, name] of Object.entries(columns ?? {})) {
    if (!FIELDS[field]) {
      throw new CsvError(`columns に指定できる項目は ${Object.keys(FIELDS).join('・')} です: ${field}`);
    }
    const i = normalized.indexOf(normalizeHeader(name));
    if (i === -1) {
      throw new CsvError(`columns.${field} に指定された列「${name}」が見出しにありません。見出し: ${header.join('、')}`);
    }
    index[field] = i;
  }
  for (const [field, aliases] of Object.entries(FIELDS)) {
    if (index[field] !== undefined) continue;
    for (const alias of aliases) {
      const i = normalized.indexOf(normalizeHeader(alias));
      if (i !== -1) {
        index[field] = i;
        break;
      }
    }
  }
  return index;
}

function missingFields(index) {
  const missing = REQUIRED.filter(([field]) => index[field] === undefined);
  if (index.amount === undefined && index.debit_amount === undefined) missing.push(['amount', '金額']);
  return missing;
}

/**
 * 見出しの前に表題などの行が入っている書き出しがあるので、先頭10行のうち、必要な列がそろう最初の行を見出しとみなす。
 * そろう行が無ければ、いちばん多く列が当たった行を見出しの候補として、足りない列を知らせる。
 */
function findHeader(rows, columns) {
  let firstError = null;
  let best = null;
  for (let h = 0; h < Math.min(10, rows.length); h += 1) {
    try {
      const index = mapColumns(rows[h], columns);
      const missing = missingFields(index);
      if (missing.length === 0) return { h, index };
      const matched = Object.keys(index).length;
      if (!best || matched > best.matched) best = { h, matched, missing };
    } catch (err) {
      if (!(err instanceof CsvError)) throw err;
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
  const missing = best.missing.map(([field, label]) => `${label}（探した列名: ${FIELDS[field].join('・')}）`).join('、');
  throw new CsvError(
    `CSV に次の列が見つかりません: ${missing}。columns で列名を指定してください。見出しとみなした行（${best.h + 1} 行目）: ${rows[best.h].join('、')}`
  );
}

/** 同じ伝票の中で、諸口が借方と貸方で同額なら取り除く。合わないときは貸借のずれを隠さないよう残す。 */
function dropBalancedShokuchi(lines) {
  const shokuchi = lines.filter((l) => l.account === '諸口');
  if (shokuchi.length === 0) return lines;
  const sum = (key) => shokuchi.reduce((a, l) => a + Number(l[key] || 0), 0);
  const debit = sum('debit');
  const credit = sum('credit');
  const rest = lines.filter((l) => l.account !== '諸口');
  return Number.isFinite(debit) && debit === credit && rest.length > 0 ? rest : lines;
}

/**
 * 弥生インポート形式の列の位置（0始まり）。弥生会計サポート情報「仕訳データの項目と記述形式」の表の順で、
 * 1 識別フラグ・2 伝票No.・3 決算・4 取引日付・5〜10 借方（科目・補助・部門・税区分・金額・税金額）・
 * 11〜16 貸方（同）・17 摘要 … 25 調整（27項目の版は後ろに2項目増える）。金額は税込。
 */
const YAYOI = { flag: 0, id: 1, date: 3, debit_account: 4, debit_amount: 8, credit_account: 10, credit_amount: 14, description: 16 };
const YAYOI_FLAGS = new Set(['2000', '2111', '2110', '2100', '2101']);

/** 見出しの行が無く、1行目の1項目めが識別フラグで、25項目以上ある CSV を弥生インポート形式とみなす。 */
function isYayoiFormat(rows) {
  return rows[0].length >= 25 && YAYOI_FLAGS.has(rows[0][YAYOI.flag].trim());
}

/**
 * 弥生インポート形式を仕訳にする。識別フラグで伝票の区切りを見る：
 * 2000（伝票以外）と 2111（1行伝票）は1行で1仕訳、2110 で始まり 2100 が続き 2101 で終わる行が1仕訳。
 * 複数行の伝票は、1行に借方か貸方の片側だけを書いてよい。
 */
function yayoiToJournals(rows) {
  const journals = [];
  const rowOf = [];
  let current = null;
  rows.forEach((row, r) => {
    const cell = (i) => String(row[i] ?? '').trim();
    const flag = cell(YAYOI.flag);
    if (current === null || (flag !== '2100' && flag !== '2101')) {
      const id = cell(YAYOI.id);
      current = { ...(id === '' ? {} : { id }), date: normalizeDate(cell(YAYOI.date)), description: '', lines: [] };
      journals.push(current);
      rowOf.push(r + 1);
    }
    if (current.description === '' && cell(YAYOI.description) !== '') current.description = cell(YAYOI.description);
    if (cell(YAYOI.debit_account) !== '') {
      current.lines.push({ account: cell(YAYOI.debit_account), debit: normalizeAmount(cell(YAYOI.debit_amount)) });
    }
    if (cell(YAYOI.credit_account) !== '') {
      current.lines.push({ account: cell(YAYOI.credit_account), credit: normalizeAmount(cell(YAYOI.credit_amount)) });
    }
    // 2110（1行目）と 2100（途中の行）のあとは、同じ伝票が続く
    if (flag !== '2110' && flag !== '2100') current = null;
  });
  for (const j of journals) j.lines = dropBalancedShokuchi(j.lines);

  const columnsUsed = {
    id: '2列目（伝票No.）',
    date: '4列目（取引日付）',
    debit_account: '5列目（借方勘定科目）',
    debit_amount: '9列目（借方金額）',
    credit_account: '11列目（貸方勘定科目）',
    credit_amount: '15列目（貸方金額）',
    description: '17列目（摘要）',
  };
  return { journals, rowOf, columnsUsed, rowCount: rows.length, layout: 'yayoi' };
}

/**
 * CSV の文字列を、仕訳の配列にする。
 * 戻り値の rowOf[i] は、i 件目の仕訳が CSV の何行目（見出しを含めて数える）から始まるか。エラーの位置を CSV の行で返すために使う。
 * columns の指定が無く、弥生インポート形式に見えるときは、列の位置で読む。
 */
function csvToJournals(text, columns) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvError('CSV が空です');
  const hasOverrides = columns && Object.keys(columns).length > 0;
  if (!hasOverrides && isYayoiFormat(rows)) return yayoiToJournals(rows);
  const { h, index } = findHeader(rows, columns);
  const header = rows[h];
  const cell = (row, field) => (index[field] === undefined ? '' : String(row[index[field]] ?? '').trim());

  const groups = new Map();
  for (let r = h + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const id = cell(row, 'id');
    const date = normalizeDate(cell(row, 'date'));
    // 伝票番号が無い書き出しは、1行を1つの仕訳として扱う
    const key = id === '' ? `#${r}` : `${id}|${date}`;
    if (!groups.has(key)) {
      const enteredAt = normalizeDateTime(cell(row, 'entered_at'));
      groups.set(key, {
        row: r + 1,
        journal: {
          ...(id === '' ? {} : { id }),
          date,
          ...(enteredAt === '' ? {} : { entered_at: enteredAt }),
          description: '',
          created_by: cell(row, 'created_by') || undefined,
          approved_by: cell(row, 'approved_by') || undefined,
          lines: [],
        },
      });
    }
    const { journal } = groups.get(key);
    const description = cell(row, 'description');
    if (journal.description === '' && description !== '') journal.description = description;

    const debitAmount = normalizeAmount(cell(row, index.debit_amount === undefined ? 'amount' : 'debit_amount'));
    const creditAmount = normalizeAmount(
      cell(row, index.credit_amount !== undefined ? 'credit_amount' : index.amount !== undefined ? 'amount' : 'debit_amount')
    );
    const debitAccount = cell(row, 'debit_account');
    const creditAccount = cell(row, 'credit_account');
    if (debitAccount !== '') journal.lines.push({ account: debitAccount, debit: debitAmount });
    if (creditAccount !== '') journal.lines.push({ account: creditAccount, credit: creditAmount });
  }

  const journals = [];
  const rowOf = [];
  for (const { row, journal } of groups.values()) {
    journal.lines = dropBalancedShokuchi(journal.lines);
    journals.push(journal);
    rowOf.push(row);
  }

  const columnsUsed = {};
  for (const [field, i] of Object.entries(index)) columnsUsed[field] = header[i];
  return { journals, rowOf, columnsUsed, rowCount: rows.length - h - 1, layout: 'header' };
}

export { csvToJournals, parseCsv, normalizeDate, normalizeDateTime, normalizeAmount, normalizeHeader, CsvError, FIELDS };
