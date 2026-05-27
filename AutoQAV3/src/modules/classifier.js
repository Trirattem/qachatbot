/**
 * Classifies chatbot answers using QA-friendly rules:
 * - PASS: the bot gives a substantive answer related to the question.
 * - PARTIAL: the bot gives an answer, but it has foreign-language/noise,
 *   missing key data, or looks weak against the expected answer.
 * - FAIL: the bot cannot answer, has no data, or only returns an error/echo.
 */

import stringSimilarity from 'string-similarity';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export const STATUS = Object.freeze({
  PASS: 'PASS',
  PARTIAL: 'PARTIAL',
  FAIL: 'FAIL',
});

const BUILT_IN_FAIL_KEYWORDS = [
  '\u0e44\u0e21\u0e48\u0e21\u0e35\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25',
  '\u0e44\u0e21\u0e48\u0e1e\u0e1a\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25',
  '\u0e44\u0e21\u0e48\u0e2a\u0e32\u0e21\u0e32\u0e23\u0e16\u0e15\u0e2d\u0e1a',
  '\u0e02\u0e2d\u0e2d\u0e20\u0e31\u0e22',
  'no information',
  'not found',
  'sorry',
  "don't know",
  'do not know',
];

function cleanText(text) {
  return (text ?? '')
    .replace(/[^\u0e00-\u0e7f\u0020-\u007e\u00a0-\u00ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalise(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/(\d)\s*[-–]\s*(\d)/g, '$1-$2')
    .trim();
}

function extractNumbers(text) {
  return text.match(/\d+/g) ?? [];
}

function hasForeignNoise(text) {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\ufffd]/.test(text ?? '');
}

function hasSubstantiveAnswer(text) {
  const compact = normalise(text).replace(/\s+/g, '');
  return compact.length >= 12;
}

function isEchoedQuestion(actual, question) {
  if (!question) return false;
  return normalise(actual) === normalise(question);
}

function containsFailKeyword(normActual) {
  const keywords = [
    ...BUILT_IN_FAIL_KEYWORDS,
    ...config.classification.failKeywords,
  ]
    .map(k => normalise(k))
    .filter(Boolean);

  return keywords.find(keyword => normActual.includes(keyword));
}

function scoreAnswer(expected, actual, question = '') {
  const normExpected = normalise(expected);
  const normActual = normalise(actual);
  const normQuestion = normalise(question);

  const expectedDice = normExpected
    ? stringSimilarity.compareTwoStrings(normExpected, normActual)
    : 0;
  const questionDice = normQuestion
    ? stringSimilarity.compareTwoStrings(normQuestion, normActual)
    : 0;

  const expectedWords = new Set(normExpected.split(/\s+/).filter(Boolean));
  const actualWords = new Set(normActual.split(/\s+/).filter(Boolean));
  const intersection = [...expectedWords].filter(w => actualWords.has(w)).length;
  const union = new Set([...expectedWords, ...actualWords]).size;
  const jaccardScore = union > 0 ? intersection / union : 0;

  const containmentBonus = normExpected && normActual.includes(normExpected) ? 0.25 : 0;
  const expectedNums = extractNumbers(normExpected);
  const numbersPresent = expectedNums.every(n => normActual.includes(n));
  const numberBonus = expectedNums.length > 0 && numbersPresent ? 0.2 : 0;

  const blended = Math.min(
    1,
    expectedDice * 0.35 +
    questionDice * 0.25 +
    jaccardScore * 0.20 +
    containmentBonus +
    numberBonus
  );

  return {
    expectedDice,
    questionDice,
    jaccardScore,
    blended,
    expectedNums,
    numbersPresent,
  };
}

export function classify(expected, actual, question = '') {
  const normActual = normalise(actual);

  if (!hasSubstantiveAnswer(actual)) {
    return { status: STATUS.FAIL, similarity: 0, reason: 'Empty or too short response' };
  }

  if (isEchoedQuestion(actual, question)) {
    return { status: STATUS.FAIL, similarity: 0, reason: 'Echoed question, no answer' };
  }

  const failKeyword = containsFailKeyword(normActual);
  if (failKeyword) {
    logger.debug(`FAIL keyword: "${failKeyword}"`);
    return { status: STATUS.FAIL, similarity: 0, reason: `Cannot answer: "${failKeyword}"` };
  }

  const score = scoreAnswer(expected, actual, question);
  const similarity = parseFloat(score.blended.toFixed(4));

  if (hasForeignNoise(actual)) {
    return {
      status: STATUS.PARTIAL,
      similarity,
      reason: 'Answer contains foreign-language/noise characters',
    };
  }

  if (score.expectedNums.length > 0 && !score.numbersPresent) {
    return {
      status: STATUS.PARTIAL,
      similarity,
      reason: 'Answer is related but missing expected number/date',
    };
  }

  if (
    similarity >= 0.12 ||
    score.questionDice >= 0.18 ||
    score.expectedDice >= 0.12
  ) {
    return {
      status: STATUS.PASS,
      similarity,
      reason: 'Bot answered with related content',
    };
  }

  return {
    status: STATUS.PARTIAL,
    similarity,
    reason: 'Bot answered, but content is weak or possibly incorrect',
  };
}

export function classifyFailure(errorType = 'ERROR') {
  return { status: STATUS.FAIL, similarity: 0, reason: errorType };
}
