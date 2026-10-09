import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../src/server.js', import.meta.url));
const cases = [null, false, 17, 'not-a-request', [], {},
  {jsonrpc:'1.0',id:1,method:'ping'}, {jsonrpc:'2.0',id:2,method:3},
  {jsonrpc:'2.0',id:true,method:'ping'}, {jsonrpc:'2.0',id:null,method:'ping'},
  {jsonrpc:'2.0',id:3,method:'ping',params:null}, {jsonrpc:'2.0',id:4,method:'ping',params:[]}];

for (const [index, invalid] of cases.entries()) {
  test(`invalid envelope ${index + 1} returns an error and preserves the following request`, () => {
    const ping = {jsonrpc:'2.0',id:100+index,method:'ping'};
    const env = {...process.env};
    delete env.SHIWAKE_DATA_DIR; delete env.SHIWAKE_MCP_START;
    const child = spawnSync(process.execPath,[server],{input:JSON.stringify(invalid)+'\n'+JSON.stringify(ping)+'\n',
      encoding:'utf8',timeout:10000,env});
    assert.equal(child.status,0,child.stderr);
    const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.length,2);
    assert.equal(replies[0].error.code,-32600);
    assert.deepEqual(replies[1],{jsonrpc:'2.0',id:100+index,result:{}});
  });
}
