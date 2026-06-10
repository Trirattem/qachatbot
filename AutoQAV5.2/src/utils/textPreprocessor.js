/**
 * src/utils/textPreprocessor.js
 * Utility functions for cleaning questions, answers, and normalizing text
 */

export function cleanQuestion(text) {
  if (!text) return '';
  return text
    // Remove leading numbering like "1.", "2.", "-", "•"
    .replace(/^[\d\.\-\•\s]+/, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanAnswer(text) {
  if (!text) return '';
  return text
    // Remove typical UI artifacts like "Bot Name", "timestamp", "Like/Dislike"
    .replace(/^(Bot:|Assistant:|AI:)\s*/i, '')
    // Remove generic footer text if any
    .replace(/(👍|👎|Copy|Share)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function thaiNumberNormalize(text) {
  if (!text) return '';
  const thMap = {
    'ศูนย์': '0', 'หนึ่ง': '1', 'สอง': '2', 'สาม': '3', 'สี่': '4',
    'ห้า': '5', 'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9',
    'สิบ': '10'
  };
  let result = text;
  for (const [th, num] of Object.entries(thMap)) {
    const reg = new RegExp(th, 'g');
    result = result.replace(reg, num);
  }
  return result;
}

export function detectLanguage(text) {
  if (!text) return 'unknown';
  const thaiPattern = /[\u0e00-\u0e7f]/;
  const englishPattern = /[a-zA-Z]/;
  
  const hasThai = thaiPattern.test(text);
  const hasEnglish = englishPattern.test(text);
  
  if (hasThai && hasEnglish) return 'mixed';
  if (hasThai) return 'th';
  if (hasEnglish) return 'en';
  return 'unknown';
}
