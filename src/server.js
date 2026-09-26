#!/usr/bin/env node
/**
 * shiwake-mcp — 仕訳スクリーニングの MCP サーバー。
 *
 * stdio 上の JSON-RPC 2.0 を、依存ライブラリなしで実装している。
 * 会計データを扱う道具に外部依存を足さないための判断で、
 * node_modules を1つも持たないことが、そのまま監査上の説明になる。
 *
 * ネットワークには出ない。読むのは stdin と、起動時に --data-dir で許可したフォルダの中のファイルだけ。
 */

import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeJournals, normalizeJournalsSkippingInvalid, JournalError } from './journal.js';
import { screen, RULES, accountSides, duplicateKey } from './rules.js';
import { benfordAnalysis } from './benford.js';
import { dataDirsFrom, resolveAllowedFile, readJournalFile, FileAccessError } from './files.js';

const SERVER_INFO = { name: 'shiwake-mcp', version: '0.3.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/** file で読んでよいフォルダ。起動引数の --data-dir と環境変数 SHIWAKE_DATA_DIR で決まる。 */
const DATA_DIRS = dataDirsFrom(process.argv.slice(2), process.env);

/** 仕訳に紐づかない検出（伝票番号の欠番）は、allFindings を指定しない限りこの件数までを返す。 */
const ENTRYLESS_FINDINGS_LIMIT = 100;

/** check_balance・detect_duplicates の一覧の既定の件数。 */
const DEFAULT_LIST_LIMIT = 200;

/** detect_duplicates で、1つのグループに添える伝票番号の上限。 */
const ENTRY_IDS_LIMIT = 50;

/* ---------------------------------------------------------------- 入力スキーマ */

const journalsSchema = {
  type: 'array',
  minItems: 1,
  description:
    '仕訳の配列。簡易形 { date, debit_account, credit_account, amount } か、明細形 { date, lines: [{ account, debit, credit }] } のどちらでも受ける。数百件を超える元帳は、ここに並べずに file で渡す。',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '伝票番号。省略時は連番を振る。' },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '計上日 (YYYY-MM-DD)' },
      entered_at: {
        type: 'string',
        description: '入力日時 (ISO 8601)。営業時間外・遡及入力の判定に使う。日付だけでもよい（そのときは営業時間外の判定に使わない）。',
      },
      debit_account: { type: 'string', description: '借方科目（簡易形）' },
      credit_account: { type: 'string', description: '貸方科目（簡易形）' },
      amount: { type: 'number', description: '金額（簡易形）' },
      lines: {
        type: 'array',
        description: '明細形の仕訳行',
        items: {
          type: 'object',
          properties: {
            account: { type: 'string' },
            debit: { type: 'number' },
            credit: { type: 'number' },
          },
          required: ['account'],
        },
      },
      description: { type: 'string', description: '摘要' },
      created_by: { type: 'string', description: '起票者ID' },
      approved_by: { type: 'string', description: '承認者ID' },
    },
    required: ['date'],
  },
};

const skipInvalidSchema = {
  type: 'boolean',
  description:
    '読めない仕訳（日付の形式違い・負の金額など）を除外して続ける。既定は false で、1件でも読めなければ全体を止める。除外した行は invalidRows に返す。',
};

const fileSchema = {
  type: 'string',
  description:
    '仕訳のファイル（.json か .csv）のパス。journals の代わりに使う。読めるのは、サーバーの起動時に --data-dir（または環境変数 SHIWAKE_DATA_DIR）で許可したフォルダの中だけ。相対パスは最初に許可したフォルダを起点にする。CSV は UTF-8 と Shift_JIS を読み、列名は日本語の表記ゆれごと自動で当てる。',
};

const columnsSchema = {
  type: 'object',
  description:
    'CSV の列名が自動で当たらないときに、項目ごとに列名を指定する（例: { "date": "伝票日付", "amount": "金額(税込)" }）。項目は id・date・entered_at・debit_account・credit_account・debit_amount・credit_amount・amount・description・created_by・approved_by。',
  additionalProperties: { type: 'string' },
};

const journalInputProperties = { journals: journalsSchema, file: fileSchema, columns: columnsSchema, skipInvalid: skipInvalidSchema };

const optionsSchema = {
  type: 'object',
  description: 'スクリーニングの前提条件。監査対象の実態に合わせて渡す。',
  properties: {
    fiscalYearEnd: { type: 'string', description: '決算日 MM-DD 形式（例: "03-31"）。期末直前の大口計上の判定に使う。' },
    businessHours: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: '業務時間 [開始時, 終了時]。既定は [9, 18]。',
    },
    holidays: {
      type: 'array',
      items: { type: 'string' },
      description: '休日の配列 (YYYY-MM-DD)。土日と日本の祝日は自動で判定するため、会社独自の休日（年末年始など）を渡す。',
    },
    japaneseHolidays: {
      type: 'boolean',
      description: '日本の祝日（振替休日・国民の休日を含む、2000〜2099年）を休日として扱う。既定は true。',
    },
    exemptMonthEnd: {
      type: 'boolean',
      description: '月末日付の仕訳を「休日の計上」から外す。既定は true。月次・期末の整理仕訳は、土日でも月末の日付で計上されることが多いため。',
    },
    approvalThresholds: { type: 'array', items: { type: 'number' }, description: '承認限度額の配列。この直下に張り付く仕訳を検出する。' },
    thresholdMarginRatio: { type: 'number', description: '限度額の何割下までを「直下」とみなすか。既定は 0.05。' },
    periodEndWindowDays: { type: 'number', description: '期末の何日前までを対象にするか。既定は 5。' },
    largeAmountPercentile: { type: 'number', description: '大口とみなす分位点。既定は 0.95。' },
    roundAmountUnit: { type: 'number', description: 'キリのよい金額の単位。既定は 100000。' },
    backdatedDaysThreshold: { type: 'number', description: '計上日と入力日の乖離を問題にする日数。既定は 30。' },
    reversalWindowDays: {
      type: 'number',
      description: '取消・訂正仕訳とみなす、元の仕訳からの日数の上限。既定は 30。',
    },
    descriptionKeywords: {
      type: 'array',
      items: { type: 'string' },
      description: '摘要のキーワード。既定は ["修正", "訂正", "取消", "調整", "仮計上", "不明"]。渡すと既定を置き換える。空の配列でこのルールを止める。',
    },
    rules: {
      type: 'array',
      items: { type: 'string', enum: RULES.map((r) => r.id) },
      description: '適用するルールを絞る場合に指定する。省略時は全ルール。',
    },
  },
};

/**
 * どのツールも読むだけで、何も書き換えず、外部のサービスにも触れない。MCP のツール注釈でそれを宣言する。
 * 対応するクライアントは、書き換えを伴わない道具として扱える。
 */
const readOnly = (title) => ({ title, readOnlyHint: true, openWorldHint: false });

const TOOLS = [
  {
    name: 'screen_journals',
    annotations: readOnly('仕訳のスクリーニング'),
    description:
      '仕訳データに全ルールを適用し、リスクスコアの高い順に並べ替えて返す。先に人間が見るべき束を絞り込むための一次スクリーニング。検出は不正の証拠ではない。',
    inputSchema: {
      type: 'object',
      properties: {
        ...journalInputProperties,
        options: optionsSchema,
        top: { type: 'number', description: '上位何件を返すか。既定は 50。' },
        allFindings: {
          type: 'boolean',
          description:
            '個々の検出を全件返す。既定は false で、上位 top 件の仕訳に関わる検出と、仕訳に紐づかない検出（伝票番号の欠番）100件までを返す。件数の集計は常に全件。',
        },
      },
    },
  },
  {
    name: 'check_balance',
    annotations: readOnly('貸借の一致の確認'),
    description: '貸借が一致しない仕訳だけを返す。取込不良と手入力の混入を最初に落とすために使う。',
    inputSchema: {
      type: 'object',
      properties: {
        ...journalInputProperties,
        top: { type: 'number', description: '差額の大きい順に何件を返すか。既定は 200。件数は常に全件を数える。' },
      },
    },
  },
  {
    name: 'benford_analysis',
    annotations: readOnly('ベンフォード分析'),
    description:
      '金額の先頭桁の分布をベンフォードの法則と比較し、MAD と χ² を返す。母集団の性質を見るための道具で、個別仕訳の判定には使えない。',
    inputSchema: {
      type: 'object',
      properties: {
        ...journalInputProperties,
        amounts: { type: 'array', items: { type: 'number' }, description: 'journals の代わりに金額だけを渡す場合。' },
        digits: { type: 'number', enum: [1, 2], description: '1 = 先頭1桁、2 = 先頭2桁。既定は 1。' },
      },
    },
  },
  {
    name: 'detect_duplicates',
    annotations: readOnly('重複仕訳の検出'),
    description: '計上日・金額・借方科目・貸方科目が完全に一致する仕訳をグループにして返す。明細の行の順番は問わない。',
    inputSchema: {
      type: 'object',
      properties: {
        ...journalInputProperties,
        top: { type: 'number', description: '件数の多いグループから何グループを返すか。既定は 200。グループ数は常に全件を数える。' },
      },
    },
  },
  {
    name: 'list_rules',
    annotations: readOnly('ルールの一覧'),
    description: '実装されているスクリーニングルールの一覧と、それぞれが何を示すかの説明を返す。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ---------------------------------------------------------------- ツール実装 */

function textResult(summary, payload) {
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 除外した行の一覧は、この件数までを返す。読めない行が大量にあっても応答が膨らまないようにする。 */
const SKIPPED_LIST_LIMIT = 50;

/**
 * 仕訳を読む。journals か file のどちらか一方から読む。
 * skipInvalid のときは読めない行を除外し、除外した分を skipped に分けて返す。
 * CSV から読んだときは、エラーと除外の位置に CSV の行番号を添える。
 */
function readJournals(args) {
  const hasJournals = args.journals !== undefined;
  const hasFile = args.file !== undefined;
  if (hasJournals && hasFile) throw new JournalError('journals と file は、どちらか一方だけを渡してください');
  if (!hasJournals && !hasFile) throw new JournalError('journals か file のどちらかが必要です');

  let journals = args.journals;
  let source = null;
  let rowOf = null;
  if (hasFile) {
    const loaded = readJournalFile(resolveAllowedFile(args.file, DATA_DIRS), { columns: args.columns });
    journals = loaded.journals;
    rowOf = loaded.rowOf;
    source = {
      file: args.file,
      format: loaded.format,
      rowCount: loaded.rowCount,
      journalCount: journals.length,
      columnsUsed: loaded.columnsUsed,
      layout: loaded.layout ?? null,
    };
  }

  try {
    const read = args.skipInvalid
      ? normalizeJournalsSkippingInvalid(journals)
      : { entries: normalizeJournals(journals), skipped: [] };
    if (rowOf) for (const s of read.skipped) s.csvRow = rowOf[s.index];
    return { ...read, source };
  } catch (err) {
    if (err instanceof JournalError && rowOf && err.index !== undefined) err.message += `（CSV の ${rowOf[err.index]} 行目）`;
    throw err;
  }
}

/**
 * 要約の1行目のあとに注記（読み込み元・除外・一覧の打ち切り）を差し込み、応答に読み込み元と除外の一覧を足す。
 * ベンフォード分析の結果はすでに skipped（判定できなかった金額の件数）を持つので、除外した行は invalidRows という名前にする。
 */
function finish(summaryLines, payload, { skipped = [], source = null, notes = [] } = {}) {
  const extra = [];
  const out = { ...payload };
  if (source) {
    const what =
      source.format === 'csv'
        ? `CSV${source.layout === 'yayoi' ? '（弥生インポート形式）' : ''} ${source.rowCount} 行 → 仕訳 ${source.journalCount} 件`
        : `仕訳 ${source.journalCount} 件`;
    extra.push(`ファイル ${basename(source.file)} を読みました（${what}）。`);
    out.source = source;
  }
  if (skipped.length > 0) {
    const where = skipped[0].csvRow ? `（CSV の ${skipped[0].csvRow} 行目）` : '';
    extra.push(`読めない ${skipped.length} 件を除外しました（例: ${skipped[0].reason}${where}）。除外した行は invalidRows にあります。`);
    out.invalidRowCount = skipped.length;
    out.invalidRows = skipped.slice(0, SKIPPED_LIST_LIMIT);
  }
  extra.push(...notes);
  return textResult([summaryLines[0], ...extra, ...summaryLines.slice(1)].join('\n'), out);
}

const HANDLERS = {
  screen_journals(args) {
    const { entries, skipped, source } = readJournals(args);
    const result = screen(entries, args.options ?? {});
    const top = args.top ?? 50;
    const s = result.summary;
    const ranked = result.ranked.slice(0, top);

    // 個々の検出は、上位に出した仕訳の分と、仕訳に紐づかない検出（欠番）だけを返す。元帳が大きいと全件は応答に収まらない
    let findings = result.findings;
    if (!args.allFindings) {
      const shown = new Set(ranked.map((r) => r.entryIndex));
      const entryless = result.findings.filter((f) => f.entryIndex === null).slice(0, ENTRYLESS_FINDINGS_LIMIT);
      findings = [...result.findings.filter((f) => f.entryIndex !== null && shown.has(f.entryIndex)), ...entryless];
    }
    const omitted = result.findings.length - findings.length;

    const summary = [
      `${s.entryCount} 件を検査し、${s.flaggedEntryCount} 件に ${s.findingCount} 件の検出がありました。`,
      `重要度の内訳: high ${s.bySeverity.high} / medium ${s.bySeverity.medium} / low ${s.bySeverity.low}`,
      `ベンフォード適合度: ${result.benford.conformityJa ?? '判定不能'} (MAD ${result.benford.mad ?? '-'})`,
      '検出は不正の証拠ではありません。確認の順番を決めるための材料として扱ってください。',
    ];
    const notes =
      omitted > 0
        ? [
            `個々の検出は、上位 ${ranked.length} 件の仕訳に関わるものを返しています（全 ${result.findings.length} 件のうち ${findings.length} 件）。全件が必要なら allFindings: true を渡してください。`,
          ]
        : [];

    return finish(
      summary,
      { summary: s, ranked, findings, findingsOmitted: omitted, benford: result.benford },
      { skipped, source, notes }
    );
  },

  check_balance(args) {
    const { entries, skipped, source } = readJournals(args);
    const all = entries
      .filter((e) => e.debitTotal !== e.creditTotal)
      .map((e) => ({
        entryId: e.id,
        date: e.date,
        debitTotal: e.debitTotal,
        creditTotal: e.creditTotal,
        difference: e.debitTotal - e.creditTotal,
        description: e.description,
      }))
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    const unbalanced = all.slice(0, args.top ?? DEFAULT_LIST_LIMIT);

    const summary =
      all.length === 0
        ? `${entries.length} 件すべてで貸借が一致しています。`
        : `${entries.length} 件のうち ${all.length} 件で貸借が一致しません。`;
    const notes = all.length > unbalanced.length ? [`一覧は差額の大きい順に ${unbalanced.length} 件です（全 ${all.length} 件）。`] : [];

    return finish(
      [summary],
      { entryCount: entries.length, unbalancedCount: all.length, unbalanced },
      { skipped, source, notes }
    );
  },

  benford_analysis(args) {
    let amounts;
    let read = { skipped: [], source: null };
    if (Array.isArray(args.amounts) && args.amounts.length > 0) {
      amounts = args.amounts;
    } else if (args.journals !== undefined || args.file !== undefined) {
      read = readJournals(args);
      amounts = read.entries.map((e) => e.amount);
    } else {
      throw new JournalError('journals・file・amounts のいずれかが必要です');
    }

    const result = benfordAnalysis(amounts, args.digits ?? 1);
    const summary = [
      `${result.sampleSize} 件を判定しました（除外 ${result.skipped} 件）。`,
      `MAD ${result.mad} → ${result.conformityJa}`,
      `χ² ${result.chiSquare}（5%点 ${result.chiSquareCritical5pct}、${result.chiSquareExceeded ? '超過' : '範囲内'}）`,
      result.note,
    ].filter(Boolean);

    return finish(summary, result, { skipped: read.skipped, source: read.source });
  },

  detect_duplicates(args) {
    const { entries, skipped, source } = readJournals(args);
    const groups = new Map();
    for (const e of entries) {
      const key = duplicateKey(e);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const all = [...groups.entries()]
      .filter(([, g]) => g.length >= 2)
      .map(([key, g]) => {
        const [debit, credit] = accountSides(g[0]);
        return {
          key,
          count: g.length,
          date: g[0].date,
          amount: g[0].amount,
          debit,
          credit,
          // 伝票番号は先頭から ENTRY_IDS_LIMIT 件まで。件数は count にある
          entryIds: g.slice(0, ENTRY_IDS_LIMIT).map((e) => e.id),
        };
      })
      .sort((a, b) => b.count - a.count);
    const duplicates = all.slice(0, args.top ?? DEFAULT_LIST_LIMIT);

    const affected = all.reduce((a, d) => a + d.count, 0);
    const summary =
      all.length === 0
        ? '完全に一致する仕訳はありませんでした。'
        : `${all.length} グループ・計 ${affected} 件が重複しています。定期計上の正当な繰り返しが含まれます。`;
    const notes =
      all.length > duplicates.length ? [`一覧は件数の多い順に ${duplicates.length} グループです（全 ${all.length} グループ）。`] : [];

    return finish(
      [summary],
      { entryCount: entries.length, groupCount: all.length, duplicates },
      { skipped, source, notes }
    );
  },

  list_rules() {
    const rules = RULES.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      rationale: r.rationale,
    }));
    return textResult(`${rules.length} 個のルールが実装されています。`, { rules });
  },
};

/* ---------------------------------------------------------------- JSON-RPC */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
      respond(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      if (!isNotification) respond(id, {});
      return;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) {
        respondError(id, -32602, `未知のツールです: ${name}`);
        return;
      }
      try {
        respond(id, handler(params.arguments ?? {}));
      } catch (err) {
        if (err instanceof JournalError) {
          // 特定の行が読めなかったときだけ、除外して続ける方法を添える
          const hint = err.index === undefined ? '' : '\n読めない行を除外して続ける場合は、skipInvalid: true を渡してください。';
          respond(id, errorResult(`入力データを読めませんでした。${err.message}${hint}`));
        } else if (err instanceof FileAccessError) {
          respond(id, errorResult(`入力ファイルを読めませんでした。${err.message}`));
        } else {
          respond(id, errorResult(`処理中にエラーが発生しました: ${err.message}`));
        }
      }
      return;
    }

    default:
      if (!isNotification) respondError(id, -32601, `未対応のメソッドです: ${method}`);
  }
}

function start(input = process.stdin) {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        respondError(null, -32700, 'JSON として読めませんでした');
        continue;
      }
      handleMessage(msg);
    }
  });
  input.on('end', () => process.exit(0));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain || process.env.SHIWAKE_MCP_START === '1') start();

export { TOOLS, HANDLERS, handleMessage, start, SERVER_INFO, SUPPORTED_PROTOCOLS };
