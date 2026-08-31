'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanCompletion,
  cleanRewrite,
  currentParagraphLength,
  hasEnoughContext,
  isInLatexComment,
  removeSuffixOverlap,
  truncateAtWord,
  truncateAtWords
} = require('../src/context');

test('counts only the current paragraph for automatic triggering', () => {
  const prefix = 'A long previous paragraph.\n  \nShort text';
  assert.equal(currentParagraphLength(prefix), 9);
  assert.equal(hasEnoughContext(prefix, 9), true);
  assert.equal(hasEnoughContext(prefix, 10), false);
});

test('detects unescaped LaTeX comments', () => {
  assert.equal(isInLatexComment('Text % comment'), true);
  assert.equal(isInLatexComment('Text \\% percentage'), false);
  assert.equal(isInLatexComment('Text \\\\% comment'), true);
});

test('cleans fences and labels without losing an intentional leading space', () => {
  assert.equal(
    cleanCompletion('```text\n continues the argument.\n```\n', 'The evidence', ''),
    ' continues the argument.'
  );
  assert.equal(
    cleanCompletion('Suggestion: therefore supports the hypothesis.\n', 'This', ''),
    'therefore supports the hypothesis.'
  );
});

test('removes text that overlaps the existing suffix', () => {
  assert.equal(removeSuffixOverlap(' completes the sentence.', 'sentence. Next'), ' completes the ');
});

test('removes a duplicated prefix from a completion', () => {
  assert.equal(
    cleanCompletion(
      'The proposed method improves calibration by controlling drift.',
      'The proposed method ',
      ''
    ),
    'improves calibration by controlling drift.'
  );
});

test('truncates long completions at a word boundary', () => {
  assert.equal(truncateAtWord('one two three four five six', 18), 'one two three four');
});

test('enforces the configured maximum word count', () => {
  assert.equal(truncateAtWords('one two three four five', 3), 'one two three');
  assert.equal(
    cleanCompletion(' one two three four five', '', '', 100, 4),
    ' one two three four'
  );
});

test('cleans rewrite wrappers while preserving the full replacement', () => {
  assert.equal(
    cleanRewrite('```latex\nThe revised claim \\cite{known}.\n```'),
    'The revised claim \\cite{known}.'
  );
  assert.equal(cleanRewrite('Rewritten text: A clearer paragraph.'), 'A clearer paragraph.');
});
