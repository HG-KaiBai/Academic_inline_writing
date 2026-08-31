'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExecArgs,
  extractAgentMessage,
  parseModelCatalog,
  runProcess
} = require('../src/codexClient');

test('builds a read-only ephemeral Codex invocation', () => {
  const args = buildExecArgs({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
    outputPath: 'C:\\Temp\\completion.txt'
  });

  assert.deepEqual(args.slice(0, 7), [
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--skip-git-repo-check'
  ]);
  assert.ok(args.includes('--output-last-message'));
  assert.deepEqual(args.slice(-5), [
    '--model',
    'gpt-5.6-luna',
    '--config',
    'model_reasoning_effort="low"',
    '-'
  ]);
});

test('uses the Codex configured model and effort when requested', () => {
  const args = buildExecArgs({
    model: '',
    reasoningEffort: 'default',
    outputPath: 'result.txt'
  });
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--config'), false);
});

test('parses visible models and reasoning levels from the local catalog', () => {
  const raw = `warning\n${JSON.stringify({
    models: [
      {
        slug: 'academic-fast',
        display_name: 'Academic Fast',
        description: 'Fast model',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
      },
      { slug: 'hidden-model', visibility: 'hide' }
    ]
  })}\nnotice`;

  assert.deepEqual(parseModelCatalog(raw), [
    {
      id: 'academic-fast',
      label: 'Academic Fast',
      description: 'Fast model',
      reasoningEfforts: ['low', 'high']
    }
  ]);
});

test('passes prompt text to a child process over stdin', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', "process.stdin.on('data', value => process.stdout.write(value.toString().toUpperCase()))"],
    { input: 'academic text', timeoutMilliseconds: 2000 }
  );

  assert.equal(result.stdout, 'ACADEMIC TEXT');
});

test('terminates a child process after the configured timeout', async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMilliseconds: 50 }
    ),
    /timed out after 50 ms/
  );
});

test('extracts the final agent message from an app-server turn', () => {
  assert.equal(extractAgentMessage({
    items: [
      { type: 'agentMessage', text: 'First draft' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'agentMessage', text: 'Final draft' }
    ]
  }), 'Final draft');
});
