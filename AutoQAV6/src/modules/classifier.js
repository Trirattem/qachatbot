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

function cleanText(text) {
  return (text ?? '')
    .replace(/[^\u0e00-\u0e7f\u0020-\u007e\u00a0-\u00ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function thaiNumberNormalize(text) {
  if (!text) return text;
  const thMap = {
    'ศูนย์': '0', 'หนึ่ง': '1', 'สอง': '2', 'สาม': '3', 'สี่': '4',
    'ห้า': '5', 'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9',
    'สิบ': '10'
  };
  let result = text;
  for (const [th, num] of Object.entries(thMap)) {
    // replace whole words roughly
    const reg = new RegExp(th, 'g');
    result = result.replace(reg, num);
  }
  return result;
}

function normalise(text) {
  return thaiNumberNormalize(cleanText(text))
    .toLowerCase()
    .replace(/(\d)\s*[-–]\s*(\d)/g, '$1-$2')
    .trim();
}

function extractNumbers(text) {
  return text.match(/\d+/g) ?? [];
}

// Character bigrams of the text with whitespace removed — Thai is not
// space-delimited, so character n-grams compare far better than word tokens.
function bigrams(text) {
  const t = (text ?? '').replace(/\s+/g, '');
  const grams = [];
  for (let i = 0; i < t.length - 1; i++) grams.push(t.slice(i, i + 2));
  return grams;
}

// Fraction of the EXPECTED answer's bigrams that appear in the actual answer.
// This is recall of the ground truth — it does NOT shrink when the bot adds
// extra words, so a correct-but-verbose answer still scores high.
function bigramRecall(expected, actual) {
  const exp = bigrams(expected);
  if (!exp.length) return 0;
  const act = new Set(bigrams(actual));
  return exp.filter(g => act.has(g)).length / exp.length;
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
  const keywords = config.classification.failKeywords
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

  // Token coverage: fraction of the expected's whitespace tokens that appear
  // (as substrings) in the actual — catches exact facts, codes and numbers.
  const expectedTokens = normExpected.split(/\s+/).filter(t => t.length >= 2);
  const tokensCovered = expectedTokens.filter(t => normActual.includes(t)).length;
  const tokenCoverage = expectedTokens.length ? tokensCovered / expectedTokens.length : 0;

  // Recall of the expected answer's content — the primary, length-robust signal.
  const recall = bigramRecall(normExpected, normActual);

  const containmentBonus = normExpected && normActual.includes(normExpected) ? 0.15 : 0;
  const expectedNums = extractNumbers(normExpected);
  const numbersPresent = expectedNums.every(n => normActual.includes(n));
  const numberBonus = expectedNums.length > 0 && numbersPresent ? 0.1 : 0;

  // Coverage-weighted: reward answers that CONTAIN the expected content,
  // rather than answers that are the same LENGTH as it.
  const blended = Math.min(
    1,
    recall * 0.60 +
    tokenCoverage * 0.20 +
    expectedDice * 0.10 +
    containmentBonus +
    numberBonus
  );

  return {
    expectedDice,
    questionDice,
    recall,
    tokenCoverage,
    blended,
    expectedNums,
    numbersPresent,
  };
}

export function classify(expected, actual, question = '') {
  if (config.classification.mode === 'llm') {
    logger.warn('LLM classification mode is not fully implemented yet. Falling back to rule-based.');
  }

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

  // No ground truth to compare against — the bot answered, but we can't score
  // correctness. Flag for manual review rather than calling it a content FAIL.
  if (!normalise(expected)) {
    return { status: STATUS.PARTIAL, similarity: 0, reason: 'No expected answer in sheet — needs manual review' };
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

  if (similarity >= config.classification.passThreshold) {
    return {
      status: STATUS.PASS,
      similarity,
      reason: 'Bot answered with highly related content',
    };
  } else if (similarity >= config.classification.partialThreshold) {
    return {
      status: STATUS.PARTIAL,
      similarity,
      reason: 'Bot answered, but content is weak or partially matched',
    };
  }

  return {
    status: STATUS.FAIL,
    similarity,
    reason: 'Bot answered, but content similarity is below failure threshold',
  };
}

export function classifyFailure(errorType = 'ERROR') {
  return { status: STATUS.FAIL, similarity: 0, reason: errorType };
}
