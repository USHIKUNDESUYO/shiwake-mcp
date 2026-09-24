import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', 'src', 'server.js');

/**
 * サーバーを子プロセスとして起こし、JSON-RPC を行区切りで投げて応答を集める。
 * MCP クライアントが実際にやることと同じ経路を通す。
 */
function callServer(messages, { expect = messages.length } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  assert.equal(responses[2].id, 3, '後続のリクエストが処理されていません');
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
