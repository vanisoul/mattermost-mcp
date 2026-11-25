import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionStore } from '../dist/session.js';

const CHANNEL = 'c'.repeat(26);
const OTHER_CHANNEL = 'd'.repeat(26);
const USER = 'u'.repeat(26);
const ROOT = 'r'.repeat(26);
const REPLY = 's'.repeat(26);
const post = (id, rootId = '', channelId = CHANNEL) => ({
  id, root_id: rootId, channel_id: channelId, user_id: USER, message: 'fixture',
  create_at: 1, update_at: 1, delete_at: 0,
});
const decode = (result) => JSON.parse(result.content.find((item) => item.type === 'text').text);

test('訊息 tools 的 stdio MCP 與模擬 HTTP API 整合（env 指定 5 行 50 字）', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-messages-'));
  const posts = new Map([[ROOT, post(ROOT)], [REPLY, post(REPLY, ROOT)]]);
  const requests = [];
  const writes = [];
  let archived = false;
  let writeStatus = 201;
  let disconnectWrite = false;
  const http = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer test-only-token') return send(401, { error: 'no credential' });
    if (req.url === `/api/v4/channels/${CHANNEL}`) return send(200, {
      id: CHANNEL, name: 'test-channel', display_name: 'test-channel', team_id: 't'.repeat(26), type: 'P', delete_at: archived ? 1 : 0,
    });
    if (req.method === 'POST' && req.url === '/api/v4/posts') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const data = JSON.parse(raw);
      writes.push(data);
      if (disconnectWrite) { res.destroy(); return; }
      if (writeStatus !== 201) return send(writeStatus, { error: 'private server error' });
      const id = 'x'.repeat(24) + writes.length.toString(36).padStart(2, '0');
      const created = { ...post(id, data.root_id ?? '', data.channel_id), message: data.message };
      posts.set(id, created);
      return send(201, created);
    }
    const match = req.url.match(/^\/api\/v4\/posts\/([a-z0-9]{26})(\/thread)?$/);
    if (match) {
      const item = posts.get(match[1]);
      if (!item) return send(404, { error: 'not found' });
      if (!match[2]) return send(200, item);
      const root = item.root_id || item.id;
      const thread = [...posts.values()].filter((p) => p.id === root || p.root_id === root);
      return send(200, { order: thread.map((p) => p.id), posts: Object.fromEntries(thread.map((p) => [p.id, p])) });
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  await new SessionStore(origin, directory).save('test-only-token');
  const client = new Client({ name: 'messages-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['dist/server.js'],
    env: {
      ...process.env, MATTERMOST_URL: origin, MATTERMOST_MCP_DATA_DIR: directory,
      MATTERMOST_MAX_MESSAGE_LINES: '5', MATTERMOST_MAX_MESSAGE_LINE_LENGTH: '50',
    },
  }));
  const call = (name, args) => client.callTool({ name: `mattermost_${name}`, arguments: args });

  await t.test('宣告讀取與寫入工具的正確 annotations', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const name of ['create_post', 'reply_to_thread']) {
      const tool = tools.find((item) => item.name === `mattermost_${name}`);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.idempotentHint, false);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.match(tool.description, /TL;DR/);
      assert.match(tool.description, /5 行/);
      assert.match(tool.description, /50 字/);
      assert.match(tool.inputSchema.properties.message.description, /5 行/);
      assert.match(tool.inputSchema.properties.message.description, /50/);
    }
    assert.equal(tools.find((item) => item.name === 'mattermost_get_thread').annotations.readOnlyHint, true);
  });

  await t.test('取得頻道與單則訊息', async () => {
    assert.equal(decode(await call('get_channel', { channelId: CHANNEL })).name, 'test-channel');
    assert.equal(decode(await call('get_post', { postId: ROOT })).id, ROOT);
  });

  let created;
  await t.test('發送新訊息，保留 Markdown 前後空白且不指定 user_id', async () => {
    created = decode(await call('create_post', { channelId: CHANNEL, message: '  **測試訊息**\n' }));
    assert.equal(created.message, '  **測試訊息**\n');
    assert.equal(created.root_id, '');
    assert.equal(created.channel_id, CHANNEL);
    assert.deepEqual(writes.at(-1), { channel_id: CHANNEL, message: '  **測試訊息**\n' });
  });

  await t.test('回覆根訊息並取得同一討論串', async () => {
    const reply = decode(await call('reply_to_thread', { channelId: CHANNEL, postId: created.id, message: '第一則回覆' }));
    assert.equal(reply.root_id, created.id);
    const thread = decode(await call('get_thread', { postId: created.id }));
    assert.deepEqual(new Set(thread.order), new Set([created.id, reply.id]));
  });

  await t.test('回覆既有回覆時使用真正 root_id', async () => {
    const reply = decode(await call('reply_to_thread', { channelId: CHANNEL, postId: REPLY, message: '回覆討論串' }));
    assert.equal(reply.root_id, ROOT);
    assert.equal(writes.at(-1).root_id, ROOT);
  });

  await t.test('拒絕空白、過長訊息及無效 ID，且不呼叫 API', async () => {
    const before = requests.length;
    for (const message of ['', '\n\t', 'a'.repeat(16384)]) {
      assert.equal((await call('create_post', { channelId: CHANNEL, message })).isError, true);
    }
    assert.equal((await call('create_post', { channelId: '../other', message: 'test' })).isError, true);
    assert.equal((await call('reply_to_thread', { channelId: CHANNEL, postId: 'bad', message: 'test' })).isError, true);
    assert.equal(requests.length, before);
  });

  await t.test('發送與回覆都接受每行 50 字、最多 5 行的邊界值', async () => {
    const valid = [
      '中'.repeat(50),
      '😀'.repeat(50),
      Array(5).fill('中'.repeat(50)).join('\n'),
      Array(5).fill('😀'.repeat(50)).join('\r\n'),
      Array(5).fill('重點').join('\r'),
      '結論\n\n重點\n\n下一步',
      '第一行\\n仍是同一行',
    ];
    for (const message of valid) {
      for (const name of ['create_post', 'reply_to_thread']) {
        const args = { channelId: CHANNEL, message, ...(name === 'reply_to_thread' ? { postId: ROOT } : {}) };
        const result = await call(name, args);
        assert.ok(!result.isError, result.content[0].text);
        assert.equal(decode(result).message, message);
      }
    }
  });

  await t.test('發送與回覆都拒絕第 51 字或第 6 行，且不呼叫 API', async () => {
    const invalid = [
      '中'.repeat(51), 'a'.repeat(51), '😀'.repeat(51),
      Array(6).fill('重點').join('\n'),
      Array(6).fill('重點').join('\r\n'),
      Array(6).fill('重點').join('\r'),
      '結論\n\n\n\n\n下一步',
      Array(5).fill('重點').join('\n') + '\n',
      'a'.repeat(49) + '\\n',
      'a'.repeat(49) + '  ',
    ];
    const before = requests.length;
    for (const message of invalid) {
      for (const name of ['create_post', 'reply_to_thread']) {
        const args = { channelId: CHANNEL, message, ...(name === 'reply_to_thread' ? { postId: ROOT } : {}) };
        const result = await call(name, args);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /5 行/);
        assert.match(result.content[0].text, /50 字/);
      }
    }
    assert.equal(requests.length, before);
  });

  await t.test('讀取歷史長訊息不受發送限制影響', async () => {
    const longId = 'z'.repeat(26);
    const message = Array(8).fill('中'.repeat(80)).join('\n');
    posts.set(longId, { ...post(longId), message });
    assert.equal(decode(await call('get_post', { postId: longId })).message, message);
    assert.equal(decode(await call('get_thread', { postId: longId })).posts[longId].message, message);
  });

  await t.test('拒絕封存頻道，不執行 POST', async () => {
    archived = true;
    const before = writes.length;
    try { assert.equal((await call('create_post', { channelId: CHANNEL, message: 'test' })).isError, true); }
    finally { archived = false; }
    assert.equal(writes.length, before);
  });

  await t.test('拒絕跨頻道訊息及已刪除目標，不執行 POST', async () => {
    const before = writes.length;
    for (const target of [{ ...post(REPLY, ROOT), channel_id: OTHER_CHANNEL }, { ...post(REPLY, ROOT), delete_at: 1 }]) {
      posts.set(REPLY, target);
      assert.equal((await call('reply_to_thread', { channelId: CHANNEL, postId: REPLY, message: 'test' })).isError, true);
    }
    posts.set(REPLY, post(REPLY, ROOT));
    assert.equal(writes.length, before);
  });

  await t.test('拒絕跨頻道或已刪除的根訊息，不執行 POST', async () => {
    const before = writes.length;
    for (const root of [{ ...post(ROOT), channel_id: OTHER_CHANNEL }, { ...post(ROOT), delete_at: 1 }]) {
      posts.set(ROOT, root);
      assert.equal((await call('reply_to_thread', { channelId: CHANNEL, postId: REPLY, message: 'test' })).isError, true);
    }
    posts.set(ROOT, post(ROOT));
    assert.equal(writes.length, before);
  });

  await t.test('處理 API 403，錯誤回應不包含 Token', async () => {
    writeStatus = 403;
    const response = await call('create_post', { channelId: CHANNEL, message: 'test' });
    assert.equal(response.isError, true);
    assert.ok(!JSON.stringify(response).includes('test-only-token'));
    writeStatus = 201;
  });

  await t.test('寫入斷線時不重試並提示先確認結果', async () => {
    disconnectWrite = true;
    const before = writes.length;
    const response = await call('create_post', { channelId: CHANNEL, message: 'test' });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /不要直接重送/);
    assert.equal(writes.length, before + 1);
    disconnectWrite = false;
  });
});

async function startMinimalServer(t, extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-limits-'));
  const writes = [];
  const http = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === `/api/v4/channels/${CHANNEL}`) return send(200, {
      id: CHANNEL, name: 'test-channel', display_name: 'test-channel', team_id: 't'.repeat(26), type: 'P', delete_at: 0,
    });
    if (req.method === 'POST' && req.url === '/api/v4/posts') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const data = JSON.parse(raw);
      writes.push(data);
      return send(201, { ...post('x'.repeat(26)), message: data.message });
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  await new SessionStore(origin, directory).save('test-only-token');
  const client = new Client({ name: 'limits-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['dist/server.js'],
    env: { ...process.env, MATTERMOST_URL: origin, MATTERMOST_MCP_DATA_DIR: directory, ...extraEnv },
  }));
  const call = (message) => client.callTool({ name: 'mattermost_create_post', arguments: { channelId: CHANNEL, message } });
  return { client, writes, call };
}

test('未設定 env 時預設為最多 15 行、每行 100 字', async (t) => {
  const { client, writes, call } = await startMinimalServer(t, {
    MATTERMOST_MAX_MESSAGE_LINES: '', MATTERMOST_MAX_MESSAGE_LINE_LENGTH: '',
  });
  const { tools } = await client.listTools();
  for (const name of ['create_post', 'reply_to_thread']) {
    const tool = tools.find((item) => item.name === `mattermost_${name}`);
    assert.match(tool.description, /15 行/);
    assert.match(tool.description, /100 字/);
    assert.match(tool.inputSchema.properties.message.description, /15 行/);
    assert.match(tool.inputSchema.properties.message.description, /100/);
  }
  for (const message of [Array(15).fill('中'.repeat(100)).join('\n'), '😀'.repeat(100)]) {
    const result = await call(message);
    assert.ok(!result.isError, result.content[0].text);
  }
  const before = writes.length;
  for (const message of ['中'.repeat(101), Array(16).fill('重點').join('\n')]) {
    const result = await call(message);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /15 行/);
    assert.match(result.content[0].text, /100 字/);
  }
  assert.equal(writes.length, before);
});

test('env 可分別指定行數與每行字數', async (t) => {
  const { writes, call } = await startMinimalServer(t, {
    MATTERMOST_MAX_MESSAGE_LINES: '2', MATTERMOST_MAX_MESSAGE_LINE_LENGTH: '200',
  });
  assert.ok(!(await call('中'.repeat(200) + '\n' + 'a')).isError);
  const before = writes.length;
  const tooMany = await call('a\nb\nc');
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content[0].text, /2 行/);
  assert.match(tooMany.content[0].text, /200 字/);
  assert.equal((await call('中'.repeat(201))).isError, true);
  assert.equal(writes.length, before);
});

test('env 限制值無效時拒絕啟動', async () => {
  const { messageLimitsFromEnv } = await import('../dist/messages.js');
  assert.deepEqual(messageLimitsFromEnv({}), { maxLines: 15, maxLineLength: 100 });
  assert.deepEqual(messageLimitsFromEnv({ MATTERMOST_MAX_MESSAGE_LINES: ' 3 ', MATTERMOST_MAX_MESSAGE_LINE_LENGTH: '80' }), { maxLines: 3, maxLineLength: 80 });
  for (const value of ['0', '-1', '1.5', 'abc', '1e3', '99999999999999999999']) {
    assert.throws(() => messageLimitsFromEnv({ MATTERMOST_MAX_MESSAGE_LINES: value }), /MATTERMOST_MAX_MESSAGE_LINES 必須是正整數/);
    assert.throws(() => messageLimitsFromEnv({ MATTERMOST_MAX_MESSAGE_LINE_LENGTH: value }), /MATTERMOST_MAX_MESSAGE_LINE_LENGTH 必須是正整數/);
  }
});
