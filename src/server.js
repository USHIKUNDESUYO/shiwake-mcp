#!/usr/bin/env node
/**
 * shiwake-mcp — 仕訳スクリーニングの MCP サーバー。
 *
 * stdio 上の JSON-RPC 2.0 を、依存ライブラリなしで実装している。
 * 会計データを扱う道具に外部依存を足さないための判断で、
 * node_modules を1つも持たないことが、そのまま監査上の説明になる。
 */

import { pathToFileURL } from 'node:url';

import { normalizeJournals, JournalError } from './journal.js';
import { screen, RULES } from './rules.js';
import { benfordAnalysis } from './benford.js';

const SERVER_INFO = { name: 'shiwake-mcp', version: '0.1.1' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/* ---------------------------------------------------------------- 入力スキーマ */

const journalsSchema = {
  type: 'array',
  minItems: 1,
  description:
    '仕訳の配列。簡易形 { date, debit_account, credit_account, amount } か、明細形 { date, lines: [{ account, debit, credit }] } のどちらでも受ける。',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '伝票番号。省略時は連番を振る。' },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '計上日 (YYYY-MM-DD)' },
      entered_at: { type: 'string', description: '入力日時 (ISO 8601)。営業時間外・遡及入力の判定に使う。' },
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
    holidays: { type: 'array', items: { type: 'string' }, description: '休日の配列 (YYYY-MM-DD)。土日は自動で判定するため、それ以外を渡す。' },
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
    rules: {
      type: 'array',
      items: { type: 'string', enum: RULES.map((r) => r.id) },
      description: '適用するルールを絞る場合に指定する。省略時は全ルール。',
    },
  },
};

const TOOLS = [
  {
    name: 'screen_journals',
    description:
      '仕訳データに全ルールを適用し、リスクスコアの高い順に並べ替えて返す。先に人間が見るべき束を絞り込むための一次スクリーニング。検出は不正の証拠ではない。',
    inputSchema: {
      type: 'object',
      properties: { journals: journalsSchema, options: optionsSchema, top: { type: 'number', description: '上位何件を返すか。既定は 50。' } },
      required: ['journals'],
    },
  },
  {
    name: 'check_balance',
    description: '貸借が一致しない仕訳だけを返す。取込不良と手入力の混入を最初に落とすために使う。',
    inputSchema: {
      type: 'object',
      properties: { journals: journalsSchema },
      required: ['journals'],
    },
  },
  {
    name: 'benford_analysis',
    description:
      '金額の先頭桁の分布をベンフォードの法則と比較し、MAD と χ² を返す。母集団の性質を見るための道具で、個別仕訳の判定には使えない。',
    inputSchema: {
      type: 'object',
      properties: {
        journals: journalsSchema,
        amounts: { type: 'array', items: { type: 'number' }, description: 'journals の代わりに金額だけを渡す場合。' },
        digits: { type: 'number', enum: [1, 2], description: '1 = 先頭1桁、2 = 先頭2桁。既定は 1。' },
      },
    },
  },
  {
    name: 'detect_duplicates',
    description: '計上日・金額・借方科目・貸方科目が完全に一致する仕訳をグループにして返す。',
    inputSchema: {
      type: 'object',
      properties: { journals: journalsSchema },
      required: ['journals'],
    },
  },
  {
    name: 'list_rules',
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

const HANDLERS = {
  screen_journals(args) {
    const entries = normalizeJournals(args.journals);
    const result = screen(entries, args.options ?? {});
    const top = args.top ?? 50;
    const s = result.summary;
    const summary = [
      `${s.entryCount} 件を検査し、${s.flaggedEntryCount} 件に ${s.findingCount} 件の検出がありました。`,
      `重要度の内訳: high ${s.bySeverity.high} / medium ${s.bySeverity.medium} / low ${s.bySeverity.low}`,
      `ベンフォード適合度: ${result.benford.conformityJa ?? '判定不能'} (MAD ${result.benford.mad ?? '-'})`,
      '検出は不正の証拠ではありません。確認の順番を決めるための材料として扱ってください。',
    ].join('\n');

    return textResult(summary, {
      summary: s,
      ranked: result.ranked.slice(0, top),
      findings: result.findings,
      benford: result.benford,
    });
  },

  check_balance(args) {
    const entries = normalizeJournals(args.journals);
    const unbalanced = entries
      .filter((e) => e.debitTotal !== e.creditTotal)
      .map((e) => ({
        entryId: e.id,
        date: e.date,
        debitTotal: e.debitTotal,
        creditTotal: e.creditTotal,
        difference: e.debitTotal - e.creditTotal,
        description: e.description,
      }));

    const summary =
      unbalanced.length === 0
        ? `${entries.length} 件すべてで貸借が一致しています。`
        : `${entries.length} 件のうち ${unbalanced.length} 件で貸借が一致しません。`;

    return textResult(summary, { entryCount: entries.length, unbalancedCount: unbalanced.length, unbalanced });
  },

  benford_analysis(args) {
    let amounts;
    if (Array.isArray(args.amounts) && args.amounts.length > 0) {
      amounts = args.amounts;
    } else if (args.journals) {
      amounts = normalizeJournals(args.journals).map((e) => e.amount);
    } else {
      throw new JournalError('journals または amounts のどちらかが必要です');
    }

    const result = benfordAnalysis(amounts, args.digits ?? 1);
    const summary = [
      `${result.sampleSize} 件を判定しました（除外 ${result.skipped} 件）。`,
      `MAD ${result.mad} → ${result.conformityJa}`,
      `χ² ${result.chiSquare}（5%点 ${result.chiSquareCritical5pct}、${result.chiSquareExceeded ? '超過' : '範囲内'}）`,
      result.note,
    ]
      .filter(Boolean)
      .join('\n');

    return textResult(summary, result);
  },

  detect_duplicates(args) {
    const entries = normalizeJournals(args.journals);
    const groups = new Map();
    for (const e of entries) {
      const key = [e.date, e.amount, e.debitAccounts.join('/'), e.creditAccounts.join('/')].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const duplicates = [...groups.entries()]
      .filter(([, g]) => g.length >= 2)
      .map(([key, g]) => ({
        key,
        count: g.length,
        date: g[0].date,
        amount: g[0].amount,
        debit: g[0].debitAccounts.join('/'),
        credit: g[0].creditAccounts.join('/'),
        entryIds: g.map((e) => e.id),
      }))
      .sort((a, b) => b.count - a.count);

    const affected = duplicates.reduce((a, d) => a + d.count, 0);
    const summary =
      duplicates.length === 0
        ? '完全に一致する仕訳はありませんでした。'
        : `${duplicates.length} グループ・計 ${affected} 件が重複しています。定期計上の正当な繰り返しが含まれます。`;

    return textResult(summary, { entryCount: entries.length, groupCount: duplicates.length, duplicates });
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
          respond(id, errorResult(`入力データを読めませんでした。${err.message}`));
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
