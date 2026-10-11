'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const {
  CodexAppServerConnection,
  CodexCliClient,
  parseModelCatalog
} = require('../src/codexClient');

function createModelServer(t, handleRequest) {
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      messages.push(message);
      if (message.id !== undefined) {
        const response = message.method === 'initialize'
          ? { result: {} }
          : handleRequest(message);
        queueMicrotask(() => {
          const line = `${JSON.stringify({ id: message.id, ...response })}\n`;
          // Exercise the stream framing as well as the catalog request.
          child.stdout.write(line.slice(0, 12));
          child.stdout.write(line.slice(12));
        });
      }
      callback();
    }
  });
  child.kill = () => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit('close', 0);
    return true;
  };
  let spawns = 0;
  const client = new CodexCliClient();
  client.connection = new CodexAppServerConnection('test-codex', () => {}, (command, args) => {
    assert.equal(command, 'test-codex');
    assert.deepEqual(args, ['app-server']);
    spawns += 1;
    return child;
  });
  t.after(() => client.dispose());
  return { client, messages, spawnCount: () => spawns };
}

test('discovers new models across live catalog pages and preserves their reasoning efforts', async (t) => {
  const server = createModelServer(t, ({ method, params }) => {
    assert.equal(method, 'model/list');
    assert.equal(params.includeHidden, false);
    assert.equal(params.limit, 100);
    if (!params.cursor) {
      return { result: {
        data: [{
          id: 'picker-entry',
          model: 'gpt-6.1-sol',
          displayName: 'GPT-6.1 Sol',
          description: 'Latest Sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }
          ]
        }, { model: 'hidden-model', hidden: true }],
        nextCursor: 'second-page'
      } };
    }
    assert.equal(params.cursor, 'second-page');
    return { result: {
      data: [{ model: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }],
      nextCursor: null
    } };
  });

  const models = await server.client.listModels({ cliPath: 'test-codex' });
  assert.deepEqual(models, [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: 'Latest Sol', reasoningEfforts: ['low', 'ultra'] },
    { id: 'gpt-6-luna', label: 'gpt-6-luna', description: '', reasoningEfforts: [] }
  ]);
  assert.deepEqual(server.messages.map(({ method }) => method), [
    'initialize', 'initialized', 'model/list', 'model/list'
  ]);
});

test('reopening the model picker requests the catalog again on the same connection', async (t) => {
  let requests = 0;
  const server = createModelServer(t, () => ({ result: {
    data: [{ model: ++requests === 1 ? 'existing-model' : 'newly-released-model' }],
    nextCursor: null
  } }));

  assert.equal((await server.client.listModels({ cliPath: 'test-codex' }))[0].id, 'existing-model');
  assert.equal((await server.client.listModels({ cliPath: 'test-codex' }))[0].id, 'newly-released-model');
  assert.equal(server.spawnCount(), 1);
  assert.equal(server.messages.filter(({ method }) => method === 'initialize').length, 1);
});

test('reports catalog errors so the picker can use its configured fallback', async (t) => {
  const server = createModelServer(t, () => ({ error: { message: 'Catalog unavailable' } }));
  await assert.rejects(server.client.listModels({ cliPath: 'test-codex' }), /Catalog unavailable/);
});

test('rejects repeated pagination cursors instead of hanging the model picker', async (t) => {
  const server = createModelServer(t, () => ({ result: { data: [], nextCursor: 'repeated' } }));
  await assert.rejects(server.client.listModels({ cliPath: 'test-codex' }), /invalid model catalog cursor/);
  assert.equal(server.messages.filter(({ method }) => method === 'model/list').length, 2);
});

test('rejects malformed catalogs and accepts an empty live model list', () => {
  assert.throws(() => parseModelCatalog({}), /did not include a models list/);
  assert.throws(() => parseModelCatalog(null), /did not include a models list/);
  assert.deepEqual(parseModelCatalog({ data: [] }), []);
  assert.deepEqual(parseModelCatalog({ data: [null, {}, { model: 42 }] }), []);
});
