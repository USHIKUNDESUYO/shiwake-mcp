import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', 'src', 'server.js');

/**
 * サーバーを子プロセスとして起こし、JSON-RPC を行区切りで投げて応答を集める。
 * MCP クライアントが実際にやることと同じ経路を通す。
 */
function callServer(messages, { expect = messages.length, args = [], env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const responses = [];
    let buffer = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`応答がありません。受信 ${responses.length} 件 / stderr: ${stderr}`));
    }, 10000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === '') continue;
        responses.push(JSON.parse(line));
        if (responses.length >= expect) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(responses);
          return;
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);

    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

const sample = [
  { id: 'A', date: '2026-01-14', debit_account: '仕入高', credit_account: '買掛金', amount: 123456, description: '通常', created_by: 'acc01', approved_by: 'mgr01' },
  { id: 'B', date: '2026-01-14', lines: [{ account: '外注費', debit: 100000 }, { account: '買掛金', credit: 90000 }], description: '不一致' },
];

test('initialize がプロトコル版とサーバー情報を返す', async () => {
  const [res] = await callServer([init], { expect: 1 });
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.equal(res.result.serverInfo.name, 'shiwake-mcp');
  assert.ok(res.result.capabilities.tools);
});

test('initialize が名乗る版は package.json・server.json と一致する', async () => {
  // 版は4か所に書いてある。1か所でも上げ忘れると、npm・レジストリ・クライアントで版が食い違う。
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(join(here, '..', 'server.json'), 'utf8'));
  const [res] = await callServer([init], { expect: 1 });
  assert.equal(res.result.serverInfo.version, pkg.version);
  assert.equal(registry.version, pkg.version);
  for (const p of registry.packages) assert.equal(p.version, pkg.version);
});

test('未対応のプロトコル版を要求されたら、対応している最新を返す', async () => {
  const [res] = await callServer(
    [{ ...init, params: { ...init.params, protocolVersion: '1999-01-01' } }],
    { expect: 1 }
  );
  assert.equal(res.result.protocolVersion, '2025-06-18');
});

test('tools/list が5つのツールをスキーマつきで返す', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
    { expect: 2 }
  );
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['benford_analysis', 'check_balance', 'detect_duplicates', 'list_rules', 'screen_journals']);
  for (const t of res.result.tools) {
    assert.ok(t.description, `${t.name} に説明がありません`);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('tools/list はどのツールにも「読み取り専用・外部に触れない」の注釈を付ける', async () => {
  const [, res] = await callServer([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { expect: 2 });
  for (const tool of res.result.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} に readOnlyHint がありません`);
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} に openWorldHint がありません`);
    assert.ok(tool.annotations?.title, `${tool.name} に title がありません`);
  }
});

test('notifications/initialized には応答しない', async () => {
  const responses = await callServer(
    [
      init,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ],
    { expect: 2 }
  );
  assert.deepEqual(responses.map((r) => r.id), [1, 3]);
});

test('screen_journals が貸借不一致を最上位で返す', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_journals', arguments: { journals: sample } } }],
    { expect: 2 }
  );
  assert.ok(!res.result.isError);
  const payload = JSON.parse(res.result.content[1].text);
  assert.equal(payload.summary.entryCount, 2);
  assert.equal(payload.ranked[0].entryId, 'B');
  assert.ok(payload.ranked[0].hitRules.includes('unbalanced'));
});

test('check_balance が差額を返す', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_balance', arguments: { journals: sample } } }],
    { expect: 2 }
  );
  const payload = JSON.parse(res.result.content[1].text);
  assert.equal(payload.unbalancedCount, 1);
  assert.equal(payload.unbalanced[0].entryId, 'B');
  assert.equal(payload.unbalanced[0].difference, 10000);
});

test('list_rules が引数なしで動く', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_rules' } }],
    { expect: 2 }
  );
  const payload = JSON.parse(res.result.content[1].text);
  assert.ok(payload.rules.length >= 10);
});

test('壊れた入力は isError で返し、プロセスは落ちない', async () => {
  const responses = await callServer(
    [
      init,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_journals', arguments: { journals: [{ date: '2026/01/14' }] } } },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ],
    { expect: 3 }
  );
  assert.equal(responses[1].result.isError, true);
  assert.match(responses[1].result.content[0].text, /読めませんでした/);
  assert.match(responses[1].result.content[0].text, /skipInvalid: true/);
  assert.equal(responses[2].id, 3, '後続のリクエストが処理されていません');
});

const withBadRow = [...sample, { id: 'NEG', date: '2026-01-14', debit_account: '売上高', credit_account: '売掛金', amount: -5000 }];

test('skipInvalid を渡すと、読めない行を除外して続け、除外した行を返す', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_journals', arguments: { journals: withBadRow, skipInvalid: true } } }],
    { expect: 2 }
  );
  assert.ok(!res.result.isError);
  assert.match(res.result.content[0].text, /読めない 1 件を除外しました/);
  const payload = JSON.parse(res.result.content[1].text);
  assert.equal(payload.summary.entryCount, 2);
  assert.equal(payload.invalidRowCount, 1);
  assert.deepEqual(payload.invalidRows.map((r) => [r.id, r.index]), [['NEG', 2]]);
});

const toolCall = (name, args) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });

test('file で許可フォルダの CSV を読み、読み込み元・列の当て方・CSV の行番号を返す', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shiwake-srv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'ledger.csv'),
    ['伝票番号,日付,借方科目,貸方科目,金額,摘要', 'V-1,2026/01/14,仕入高,買掛金,123456,通常', 'V-2,2026/01/14,現金,売上高,-5,マイナス'].join('\n')
  );
  const [, res] = await callServer([init, toolCall('screen_journals', { file: 'ledger.csv', skipInvalid: true })], {
    expect: 2,
    args: ['--data-dir', dir],
  });
  assert.ok(!res.result.isError, res.result.content[0].text);
  assert.match(res.result.content[0].text, /ファイル ledger\.csv を読みました（CSV 2 行 → 仕訳 2 件）/);
  const payload = JSON.parse(res.result.content[1].text);
  assert.equal(payload.source.columnsUsed.date, '日付');
  assert.equal(payload.summary.entryCount, 1);
  assert.equal(payload.invalidRows[0].csvRow, 3);
});

test('許可フォルダの外と、許可フォルダの指定が無いときは読まない', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shiwake-srv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outsideFile = join(here, '..', 'package.json');

  const [, outside] = await callServer([init, toolCall('check_balance', { file: outsideFile })], {
    expect: 2,
    args: ['--data-dir', dir],
  });
  assert.equal(outside.result.isError, true);
  assert.match(outside.result.content[0].text, /外にあるファイルは読みません/);

  const [, noDir] = await callServer([init, toolCall('check_balance', { file: 'ledger.csv' })], {
    expect: 2,
    env: { ...process.env, SHIWAKE_DATA_DIR: '' },
  });
  assert.equal(noDir.result.isError, true);
  assert.match(noDir.result.content[0].text, /--data-dir/);
});

test('journals と file を両方渡すと止める', async () => {
  const [, res] = await callServer([init, toolCall('check_balance', { journals: sample, file: 'x.csv' })], { expect: 2 });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /どちらか一方/);
});

test('screen_journals は既定で上位の仕訳に関わる検出だけを返し、allFindings で全件を返す', async () => {
  const journals = [];
  for (let i = 0; i < 5; i += 1) {
    journals.push({ id: `E${i}`, date: '2026-01-14', debit_account: '仕入高', credit_account: '買掛金', amount: 1000 + i, description: '' });
  }
  const [, capped] = await callServer([init, toolCall('screen_journals', { journals, top: 2 })], { expect: 2 });
  const payload = JSON.parse(capped.result.content[1].text);
  assert.equal(payload.summary.findingCount, 5);
  assert.equal(payload.findings.length, 2);
  assert.equal(payload.findingsOmitted, 3);
  assert.match(capped.result.content[0].text, /allFindings: true/);

  const [, all] = await callServer([init, toolCall('screen_journals', { journals, top: 2, allFindings: true })], { expect: 2 });
  assert.equal(JSON.parse(all.result.content[1].text).findings.length, 5);
});

test('benford_analysis の skipped（判定できない金額の件数）は、除外した行の一覧と混ざらない', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'benford_analysis', arguments: { journals: withBadRow, skipInvalid: true } } }],
    { expect: 2 }
  );
  assert.ok(!res.result.isError);
  const payload = JSON.parse(res.result.content[1].text);
  assert.equal(typeof payload.skipped, 'number');
  assert.equal(payload.invalidRowCount, 1);
});

test('未知のツール名は JSON-RPC エラーを返す', async () => {
  const [, res] = await callServer(
    [init, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } }],
    { expect: 2 }
  );
  assert.equal(res.error.code, -32602);
});

test('JSON として読めない行を送ってもプロセスは生きている', async () => {
  const responses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length >= 2) { clearTimeout(timer); child.kill(); resolve(out); return; }
      }
    });
    child.stdin.write('{ this is not json\n');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}\n`);
  });

  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 9);
});
