'use strict';

function currentParagraphLength(prefix) {
  const paragraph = prefix.split(/\r?\n[ \t]*\r?\n/).at(-1) || '';
  return paragraph.replace(/\s/g, '').length;
}

function hasEnoughContext(prefix, minimumCharacters) {
  return currentParagraphLength(prefix) >= minimumCharacters;
}

function isInLatexComment(linePrefix) {
  for (let index = 0; index < linePrefix.length; index += 1) {
    if (linePrefix[index] !== '%') {
      continue;
    }

    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && linePrefix[cursor] === '\\'; cursor -= 1) {
      slashCount += 1;
    }

    if (slashCount % 2 === 0) {
      return true;
    }
  }

  return false;
}

function stripCodeFence(value) {
  const match = value.match(/^\s*```(?:[\w+-]+)?\r?\n([\s\S]*?)\r?\n```\s*$/);
  return match ? match[1] : value;
}

function removeDuplicatedPrefix(completion, prefix) {
  const prefixTail = prefix.slice(-240);
  const candidates = prefixTail
    .split(/(?<=[.!?;:]\s|\r?\n)/)
    .map((candidate) => candidate.trimStart())
    .filter((candidate) => candidate.length >= 12)
    .sort((left, right) => right.length - left.length);

  for (const candidate of candidates) {
    if (completion.startsWith(candidate)) {
      return completion.slice(candidate.length);
    }
  }

  return completion;
}

function removeSuffixOverlap(completion, suffix) {
  const maximum = Math.min(completion.length, suffix.length, 240);
  for (let length = maximum; length >= 3; length -= 1) {
    if (completion.endsWith(suffix.slice(0, length))) {
      return completion.slice(0, -length);
    }
  }

  return completion;
}

function truncateAtWord(value, maximumCharacters) {
  if (value.length <= maximumCharacters) {
    return value;
  }

  const shortened = value.slice(0, maximumCharacters);
  if (/\s/.test(value[maximumCharacters] || '')) {
    return shortened.trimEnd();
  }

  const boundary = Math.max(
    shortened.lastIndexOf('. '),
    shortened.lastIndexOf('? '),
    shortened.lastIndexOf('! '),
    shortened.lastIndexOf('; '),
    shortened.lastIndexOf(' '),
    shortened.lastIndexOf('\n')
  );

  return (boundary >= maximumCharacters * 0.6 ? shortened.slice(0, boundary + 1) : shortened).trimEnd();
}

function truncateAtWords(value, maximumWords) {
  if (!Number.isFinite(maximumWords) || maximumWords <= 0) {
    return value;
  }

  const words = Array.from(value.matchAll(/\S+/g));
  if (words.length <= maximumWords) {
    return value;
  }

  const lastWord = words[maximumWords - 1];
  return value.slice(0, lastWord.index + lastWord[0].length).trimEnd();
}

function cleanCompletion(
  rawCompletion,
  prefix,
  suffix,
  maximumCharacters = 2400,
  maximumWords = Number.POSITIVE_INFINITY
) {
  if (typeof rawCompletion !== 'string') {
    return '';
  }

  let completion = rawCompletion.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  completion = stripCodeFence(completion);
  completion = completion.replace(/^\s*(?:Completion|Suggestion)\s*:\s*/i, '');
  completion = completion.trimEnd();
  completion = removeDuplicatedPrefix(completion, prefix);
  completion = removeSuffixOverlap(completion, suffix);
  completion = truncateAtWord(completion, maximumCharacters);
  completion = truncateAtWords(completion, maximumWords);

  if (!completion.trim()) {
    return '';
  }

  return completion;
}

function cleanRewrite(rawRewrite) {
  if (typeof rawRewrite !== 'string') {
    return '';
  }

  let rewrite = rawRewrite.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  rewrite = stripCodeFence(rewrite);
  rewrite = rewrite.replace(/^\s*(?:Rewrite|Rewritten text|Replacement)\s*:\s*/i, '');
  return rewrite.trim();
}

module.exports = {
  cleanCompletion,
  cleanRewrite,
  currentParagraphLength,
  hasEnoughContext,
  isInLatexComment,
  removeSuffixOverlap,
  truncateAtWord,
  truncateAtWords
};
