#!/usr/bin/env node
/**
 * MCP を介さずに、そのまま叩けるCLI。
 * サーバーを立てる前に、手元のデータで挙動を確かめるために置いている。
 *
 *   node bin/shiwake.js <journals.json> [--fiscal-year-end 03-31] [--approval-threshold 1000000] [--json]
 */

import { readFileSync } from 'node:fs';

import { normalizeJournals, JournalError } from '../src/journal.js';
import { screen, RULE_INDEX } from '../src/rules.js';

const USAGE = `
使い方: shiwake <journals.json> [オプション]

オプション:
  --fiscal-year-end <MM-DD>      決算日。期末直前の大口計上を見る場合に指定する。
  --approval-threshold <金額>    承認限度額。複数回の指定ができる。
  --business-hours <開始-終了>   業務時間。既定は 9-18。
  --top <件数>                   表示件数。既定は 20。
  --rules <id,id,...>            適用するルールを絞る。
  --json                         結果を JSON でそのまま出す。
  --help                         この表示。
`.trim();

function parseArgs(argv) {
  const opts = { approvalThresholds: [], top: 20 };
  let file = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case '--help':
      case '-h':
        return { help: true };
      case '--fiscal-year-end':
        opts.fiscalYearEnd = next();
        break;
      case '--approval-threshold':
        opts.approvalThresholds.push(Number(next()));
        break;
      case '--business-hours': {
        const [open, close] = next().split('-').map(Number);
        opts.businessHours = [open, close];
        break;
      }
      case '--top':
        opts.top = Number(next());
        break;
      case '--rules':
        opts.rules = next().split(',').map((s) => s.trim());
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`未知のオプションです: ${a}`);
        file = a;
    }
  }
  return { file, opts };
}

const SEVERITY_MARK = { high: '!!', medium: '! ', low: '  ' };

function render(result, top) {
  const s = result.summary;
  const lines = [];

  lines.push('');
  lines.push(`検査対象   ${s.entryCount} 件`);
  lines.push(`検出       ${s.findingCount} 件 / 対象仕訳 ${s.flaggedEntryCount} 件`);
  lines.push(`重要度     high ${s.bySeverity.high} / medium ${s.bySeverity.medium} / low ${s.bySeverity.low}`);

  const b = result.benford;
  if (b.sampleSize > 0) {
    lines.push(`ベンフォード  MAD ${b.mad} → ${b.conformityJa}（n=${b.sampleSize}）`);
  }

  lines.push('');
  lines.push('ルール別:');
  for (const [id, count] of Object.entries(s.byRule).sort((a, b2) => b2[1] - a[1])) {
    const rule = RULE_INDEX.get(id);
    lines.push(`  ${SEVERITY_MARK[rule.severity]} ${rule.title.padEnd(14, '　')} ${String(count).padStart(5)} 件`);
  }

  lines.push('');
  lines.push(`確認の優先順位（上位 ${Math.min(top, result.ranked.length)} 件）:`);
  for (const r of result.ranked.slice(0, top)) {
    lines.push(
      `  [${String(r.riskScore).padStart(3)}] ${r.entryId.padEnd(10)} ${r.date}  ${String(r.amount).padStart(12)}  ${r.hitRules.join(', ')}`
    );
    if (r.description) lines.push(`        ${r.description}`);
  }

  lines.push('');
  lines.push('検出は不正の証拠ではありません。見る順番を決めるための材料として扱ってください。');
  lines.push('');
  return lines.join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (parsed.help || !parsed.file) {
    console.log(USAGE);
    process.exit(parsed.help ? 0 : 2);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(parsed.file, 'utf8'));
  } catch (err) {
    console.error(`ファイルを読めませんでした: ${err.message}`);
    process.exit(1);
  }

  const journals = Array.isArray(raw) ? raw : raw.journals;

  try {
    const entries = normalizeJournals(journals);
    const result = screen(entries, parsed.opts);
    if (parsed.opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(render(result, parsed.opts.top));
    }
  } catch (err) {
    if (err instanceof JournalError) {
      console.error(`入力データを読めませんでした。${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
