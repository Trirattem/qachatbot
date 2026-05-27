/**
 * src/modules/classifier.js
 * ─────────────────────────────────────────────────────────────
 * Classifies a chatbot response as PASS / PARTIAL / FAIL.
 *
 * Algorithm:
 *  1. Clean actual text (strip non-Thai/non-ASCII garbage chars)
 *  2. Pre-screen for FAIL keywords
 *  3. Dice coefficient similarity
 *  4. Jaccard word-overlap
 *  5. Containment bonus (expected found inside actual)
 *  6. Key-number bonus (numbers in expected all appear in actual)
 *  7. Blend → PASS / PARTIAL / FAIL
 */

import stringSimilarity from 'string-similarity';
import config from '../config/index.js';
import logger from '../utils/logger.js';

export const STATUS = Object.freeze({
  PASS:    'PASS',
  PARTIAL: 'PARTIAL',
  FAIL:    'FAIL',
});

// ── Strip garbage / non-linguistic characters ─────────────────
// Keep: Thai (\u0e00-\u0e7f), Latin, digits, spaces, common punct
function cleanText(text) {
  return (text ?? '')
    .replace(/[^\u0e00-\u0e7f\u0020-\u007e\u00a0-\u00ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Normalise for comparison ──────────────────────────────────
function normalise(text) {
  return cleanText(text)
    .toLowerCase()
    // normalise Thai year ranges: 2566-2569 == 2566 - 2569
    .replace(/(\d)\s*[-–]\s*(\d)/g, '$1-$2')
    .trim();
}

// ── Extract all numbers from text ─────────────────────────────
function extractNumbers(text) {
  return (text.match(/\d+/g) ?? []);
}

// ── Main classifier ───────────────────────────────────────────
export function classify(expected, actual) {
  if (!actual || actual.trim() === '') {
    return { status: STATUS.FAIL, similarity: 0, reason: 'Empty response' };
  }

  const normExpected = normalise(expected);
  const normActual   = normalise(actual);

  // ── 1. FAIL keywords ─────────────────────────────────────────
  for (const keyword of config.classification.failKeywords) {
    if (normActual.includes(keyword.toLowerCase())) {
      logger.debug(`FAIL keyword: "${keyword}"`);
      return { status: STATUS.FAIL, similarity: 0, reason: `Fail keyword: "${keyword}"` };
    }
  }

  // ── 2. Dice coefficient ───────────────────────────────────────
  const diceSimilarity = stringSimilarity.compareTwoStrings(normExpected, normActual);

  // ── 3. Containment bonus ──────────────────────────────────────
  // Full phrase match
  const containmentBonus = normActual.includes(normExpected) ? 0.25 : 0;

  // ── 4. Jaccard word-overlap ───────────────────────────────────
  const expectedWords = new Set(normExpected.split(/\s+/).filter(Boolean));
  const actualWords   = new Set(normActual.split(/\s+/).filter(Boolean));
  const intersection  = [...expectedWords].filter(w => actualWords.has(w)).length;
  const union         = new Set([...expectedWords, ...actualWords]).size;
  const jaccardScore  = union > 0 ? intersection / union : 0;

  // ── 5. Key-number bonus ───────────────────────────────────────
  // If all numbers in expected appear in actual, that's a strong signal
  // e.g. expected "2566 - 2569" → numbers [2566, 2569] both in actual → bonus
  const expectedNums = extractNumbers(normExpected);
  let numberBonus = 0;
  if (expectedNums.length > 0) {
    const allPresent = expectedNums.every(n => normActual.includes(n));
    numberBonus = allPresent ? 0.2 : 0;
  }

  // ── 6. Blend ──────────────────────────────────────────────────
  // Weights: Dice 40% + Jaccard 20% + containment 25% + number bonus 20%
  const blendedScore = Math.min(
    1,
    diceSimilarity * 0.40 +
    jaccardScore   * 0.20 +
    containmentBonus +
    numberBonus
  );

  // ── 7. Thresholds ─────────────────────────────────────────────
  const { passThreshold, partialThreshold } = config.classification;

  let status, reason;

  if (blendedScore >= passThreshold) {
    status = STATUS.PASS;
    reason = `Similarity ${(blendedScore * 100).toFixed(1)}% ≥ ${(passThreshold * 100).toFixed(0)}%`;
  } else if (blendedScore >= partialThreshold) {
    status = STATUS.PARTIAL;
    reason = `Similarity ${(blendedScore * 100).toFixed(1)}% is partial`;
  } else {
    status = STATUS.FAIL;
    reason = `Similarity ${(blendedScore * 100).toFixed(1)}% < ${(partialThreshold * 100).toFixed(0)}%`;
  }

  logger.debug('Classification', {
    dice:            diceSimilarity.toFixed(3),
    jaccard:         jaccardScore.toFixed(3),
    containment:     containmentBonus,
    numberBonus,
    blended:         blendedScore.toFixed(3),
    status,
    expectedNums,
  });

  return { status, similarity: parseFloat(blendedScore.toFixed(4)), reason };
}

export function classifyFailure(errorType = 'ERROR') {
  return { status: STATUS.FAIL, similarity: 0, reason: errorType };
}