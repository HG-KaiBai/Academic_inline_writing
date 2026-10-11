'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { version } = require('../package.json');

const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MILLISECONDS = 10000;

class CodexCliError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'CodexCliError';
    this.details = details;
  }
}

function buildExecArgs({ model, reasoningEffort, outputPath }) {
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--output-last-message',
    outputPath
  ];

  if (model) {
    args.push('--model', model);
  }

  if (reasoningEffort && reasoningEffort !== 'default') {
    args.push('--config', `model_reasoning_effort="${reasoningEffort}"`);
  }

  args.push('-');
  return args;
}

function parseModelCatalog(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) {
      throw new CodexCliError('Codex returned an unreadable model catalog.');
    }
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
      throw new CodexCliError('Codex returned invalid model catalog JSON.', error.message);
    }
  }

  const models = parsed?.data ?? parsed?.models;
  if (!Array.isArray(models)) {
    throw new CodexCliError('The Codex model catalog did not include a models list.');
  }

  return models
    .filter((model) => model && model.hidden !== true && model.visibility !== 'hide')
    .filter((model) => typeof (model.model || model.slug || model.id) === 'string')
    .map((model) => ({
      id: model.model || model.slug || model.id,
      label: model.displayName || model.display_name || model.model || model.slug || model.id,
      description: model.description || '',
      reasoningEfforts: (Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .map((level) => level?.reasoningEffort || level?.effort)
        .filter((effort) => typeof effort === 'string' && effort.length > 0)
    }));
}

function appendLimited(current, chunk) {
  if (current.length >= MAX_PROCESS_OUTPUT) {
    return current;
  }
  return (current + chunk.toString()).slice(0, MAX_PROCESS_OUTPUT);
}

function runProcess(command, args, options = {}) {
  const {
    cwd,
    input,
    timeoutMilliseconds = DEFAULT_PROCESS_TIMEOUT_MILLISECONDS,
    signal,
    spawnImplementation = spawn
  } = options;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawnImplementation(command, args, {
      cwd: cwd || undefined,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new CodexCliError('Codex request cancelled.')));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new CodexCliError(
        `Codex timed out after ${timeoutMilliseconds} ms.`,
        stderr
      )));
    }, timeoutMilliseconds);

    child.stdout?.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on('error', (error) => {
      finish(() => reject(new CodexCliError(`Could not start Codex CLI: ${error.message}`)));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new CodexCliError(`Codex exited with code ${code}.`, stderr || stdout));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input || '');
    }
  });
}

function extractAgentMessage(turn) {
  const messages = Array.isArray(turn?.items)
    ? turn.items.filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string')
    : [];
  return messages.at(-1)?.text || '';
}

class CodexAppServerConnection {
  constructor(cliPath, log = () => {}, spawnImplementation = spawn) {
    this.cliPath = cliPath;
    this.log = log;
    this.spawnImplementation = spawnImplementation;
    this.child = undefined;
    this.buffer = '';
    this.stderr = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.initializePromise = undefined;
  }

  async initialize(timeoutMilliseconds = DEFAULT_PROCESS_TIMEOUT_MILLISECONDS, signal) {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.initializePromise = this.start(timeoutMilliseconds, signal).catch((error) => {
      this.dispose();
      this.initializePromise = undefined;
      throw error;
    });
    return this.initializePromise;
  }

  async start(timeoutMilliseconds, signal) {
    this.child = this.spawnImplementation(this.cliPath, ['app-server'], {
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout?.on('data', (chunk) => this.consume(chunk));
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = appendLimited(this.stderr, chunk);
    });
    this.child.on('error', (error) => this.failAll(
      new CodexCliError(`Could not start Codex app server: ${error.message}`)
    ));
    this.child.on('close', (code) => {
      if (this.child) {
        this.failAll(new CodexCliError(`Codex app server exited with code ${code}.`));
      }
      this.child = undefined;
      this.initializePromise = undefined;
    });
    this.child.stdin?.on('error', (error) => this.failAll(
      new CodexCliError(`Could not write to Codex app server: ${error.message}`)
    ));

    await this.request('initialize', {
      clientInfo: {
        name: 'academic-inline-vscode',
        title: 'Academic Inline',
        version
      },
      capabilities: {
        optOutNotificationMethods: [
          'thread/started',
          'turn/started',
          'item/started',
          'item/completed',
          'thread/status/changed',
          'thread/tokenUsage/updated'
        ]
      }
    }, timeoutMilliseconds, signal);
    this.write({ method: 'initialized' });
    this.log('Codex app server is ready.');
  }

  consume(chunk) {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          // Ignore non-protocol startup notices.
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  handleMessage(message) {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort);
      if (message.error) {
        pending.reject(new CodexCliError(
          message.error.message || 'Codex app server request failed.'
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params || {};
    const active = this.turns.get(params.threadId);
    if (!active) {
      return;
    }
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      active.text += params.delta;
      return;
    }
    if (message.method === 'turn/completed') {
      this.turns.delete(params.threadId);
      clearTimeout(active.timer);
      active.signal?.removeEventListener('abort', active.abort);
      const status = params.turn?.status;
      if (status === 'failed') {
        active.reject(new CodexCliError(
          params.turn?.error?.message || 'Codex could not complete the writing request.'
        ));
      } else if (status === 'interrupted') {
        active.reject(new CodexCliError('Codex request cancelled.'));
      } else {
        active.resolve(active.text || extractAgentMessage(params.turn));
      }
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) {
      throw new CodexCliError('Codex app server is not available.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMilliseconds, signal) {
    if (signal?.aborted) {
      return Promise.reject(new CodexCliError('Codex request cancelled.'));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new CodexCliError('Codex request cancelled.'));
      };
      const timer = timeoutMilliseconds > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          signal?.removeEventListener('abort', abort);
          reject(new CodexCliError(`Codex timed out after ${timeoutMilliseconds} ms.`));
        }, timeoutMilliseconds)
        : undefined;

      this.pending.set(id, { resolve, reject, timer, signal, abort });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(error);
      }
    });
  }

  waitForTurn(threadId, timeoutMilliseconds, signal) {
    if (signal?.aborted) {
      return Promise.reject(new CodexCliError('Codex request cancelled.'));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const active = this.turns.get(threadId);
        if (!active) {
          return;
        }
        this.turns.delete(threadId);
        clearTimeout(active.timer);
        this.interrupt(threadId, active.turnId);
        reject(new CodexCliError('Codex request cancelled.'));
      };
      const timer = timeoutMilliseconds > 0
        ? setTimeout(() => {
          const active = this.turns.get(threadId);
          this.turns.delete(threadId);
          signal?.removeEventListener('abort', abort);
          this.interrupt(threadId, active?.turnId);
          if (active?.text?.trim()) {
            resolve(active.text);
          } else {
            reject(new CodexCliError(`Codex timed out after ${timeoutMilliseconds} ms.`));
          }
        }, timeoutMilliseconds)
        : undefined;

      this.turns.set(threadId, { resolve, reject, timer, signal, abort, text: '' });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  setTurnId(threadId, turnId) {
    const active = this.turns.get(threadId);
    if (active) {
      active.turnId = turnId;
    }
  }

  interrupt(threadId, turnId) {
    if (!threadId || !turnId || !this.child) {
      return;
    }
    void this.request('turn/interrupt', { threadId, turnId }, 250).catch(() => {});
  }

  cancelTurnWait(threadId) {
    const active = this.turns.get(threadId);
    if (!active) {
      return;
    }
    this.turns.delete(threadId);
    clearTimeout(active.timer);
    active.signal?.removeEventListener('abort', active.abort);
    active.reject(new CodexCliError('Codex request cancelled.'));
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort);
      pending.reject(error);
    }
    this.pending.clear();
    for (const active of this.turns.values()) {
      clearTimeout(active.timer);
      active.signal?.removeEventListener('abort', active.abort);
      active.reject(error);
    }
    this.turns.clear();
  }

  dispose() {
    const child = this.child;
    this.child = undefined;
    this.initializePromise = undefined;
    this.failAll(new CodexCliError('Codex app server stopped.'));
    child?.kill();
  }
}

class CodexCliClient {
  constructor(log = () => {}) {
    this.log = log;
    this.connection = undefined;
  }

  getConnection(cliPath) {
    if (!this.connection || this.connection.cliPath !== cliPath) {
      this.connection?.dispose();
      this.connection = new CodexAppServerConnection(cliPath, this.log);
    }
    return this.connection;
  }

  async complete({
    cliPath,
    cwd,
    model,
    reasoningEffort,
    prompt,
    timeoutMilliseconds = 0,
    signal,
    allowWorkspaceRead = false
  }) {
    const startedAt = Date.now();
    const isolatedDirectory = allowWorkspaceRead
      ? undefined
      : await fs.mkdtemp(path.join(os.tmpdir(), 'academic-inline-context-'));
    const connection = this.getConnection(cliPath);
    let threadId;
    let turnId;
    let turnPromise;

    try {
      await connection.initialize(timeoutMilliseconds, signal);
      const threadResult = await connection.request('thread/start', {
        model: model || null,
        cwd: isolatedDirectory || cwd || os.tmpdir(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        baseInstructions: 'Return only the requested writing text. Do not use tools or run commands.'
      }, timeoutMilliseconds, signal);
      threadId = threadResult?.thread?.id;
      if (!threadId) {
        throw new CodexCliError('Codex app server did not start a writing thread.');
      }

      turnPromise = connection.waitForTurn(threadId, timeoutMilliseconds, signal);
      const turnResult = await connection.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        model: model || null,
        effort: reasoningEffort && reasoningEffort !== 'default' ? reasoningEffort : null,
        cwd: isolatedDirectory || cwd || os.tmpdir(),
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' }
      }, timeoutMilliseconds, signal);
      turnId = turnResult?.turn?.id;
      connection.setTurnId(threadId, turnId);
      const completion = await turnPromise;
      this.log(`Codex completion finished in ${Date.now() - startedAt} ms.`);
      return completion;
    } catch (error) {
      connection.interrupt(threadId, turnId);
      if (!turnId && threadId) {
        turnPromise?.catch(() => {});
        connection.cancelTurnWait(threadId);
      }
      throw error;
    } finally {
      if (isolatedDirectory) {
        await fs.rm(isolatedDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async listModels({ cliPath, timeoutMilliseconds = 10000 }) {
    const connection = this.getConnection(cliPath);
    await connection.initialize(timeoutMilliseconds);
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const result = await connection.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {})
      }, timeoutMilliseconds);
      for (const model of parseModelCatalog(result)) {
        if (!models.has(model.id)) {
          models.set(model.id, model);
        }
      }
      cursor = result.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) {
        throw new CodexCliError('Codex returned an invalid model catalog cursor.');
      }
      cursors.add(cursor);
    } while (cursor);
    this.log(`Found ${models.size} models from Codex app server (${cliPath}).`);
    return [...models.values()];
  }

  async version({ cliPath, timeoutMilliseconds = 10000 }) {
    const result = await runProcess(cliPath, ['--version'], { timeoutMilliseconds });
    return result.stdout.trim();
  }

  dispose() {
    this.connection?.dispose();
    this.connection = undefined;
  }
}

module.exports = {
  CodexAppServerConnection,
  CodexCliClient,
  CodexCliError,
  buildExecArgs,
  extractAgentMessage,
  parseModelCatalog,
  runProcess
};
