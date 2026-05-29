/**
 * src/utils/dynamicQuestionGenerator.js
 * ─────────────────────────────────────────────────────────────
 * Analyses a chatbot response and extracts location/option names
 * from numbered lists so the test runner can send a randomised
 * follow-up question instead of a static one from the sheet.
 *
 * Supported list patterns (Thai + English):
 *
 *   1. นครราชสีมา: 500 บาทต่อตารางวา
 *   2. สมุทรปราการ: 15,000 บาท
 *   3. กรุงเทพมหานคร: 28,000 บาท
 *
 *   1) District A – details
 *   2) District B – details
 *
 *   • บางรัก
 *   • สาทร
 *
 * The function returns null when no list is detected so the caller
 * knows to fall back to the static question from the sheet.
 */

// ── Regex patterns (ordered by specificity) ──────────────────

/**
 * Matches lines like:
 *   "1. นครราชสีมา:"   →  captures "นครราชสีมา"
 *   "2. สมุทรปราการ:"  →  captures "สมุทรปราการ"
 *   "3. กรุงเทพมหานคร:" → captures "กรุงเทพมหานคร"
 *
 * Also handles:
 *   "1) เขตบางรัก –"   →  captures "เขตบางรัก"
 *   "2. Bang Rak:"     →  captures "Bang Rak"
 */
const NUMBERED_LIST_PATTERN = /^\s*\d+[.)]\s+([\u0e00-\u0e7f\w\s]+?)(?:\s*[:–\-,]|$)/gm;

/**
 * Bullet-point lists:
 *   "• บางรัก"  →  captures "บางรัก"
 *   "- สาทร"   →  captures "สาทร"
 *   "* ลาดพร้าว" → captures "ลาดพร้าว"
 */
const BULLET_LIST_PATTERN = /^\s*[•\-*]\s+([\u0e00-\u0e7f\w\s]+?)(?:\s*[:–\-,]|$)/gm;

// ── Public API ────────────────────────────────────────────────

/**
 * Extract all candidate follow-up items from a bot response.
 *
 * @param {string} responseText  - raw text returned by the chatbot
 * @returns {string[]}           - deduplicated, trimmed candidate names
 *                                  (empty array if nothing found)
 */
export function extractListItems(responseText) {
  if (!responseText) return [];

  const candidates = new Set();

  // Try numbered list first (most common pattern for this chatbot)
  for (const match of responseText.matchAll(NUMBERED_LIST_PATTERN)) {
    const item = match[1].trim();
    if (item.length >= 2) candidates.add(item);
  }

  // If numbered list found nothing, try bullet points
  if (candidates.size === 0) {
    for (const match of responseText.matchAll(BULLET_LIST_PATTERN)) {
      const item = match[1].trim();
      if (item.length >= 2) candidates.add(item);
    }
  }

  return [...candidates];
}

/**
 * Pick one item at random from the candidates list.
 *
 * @param {string[]} items
 * @returns {string|null}  - randomly chosen item, or null if list is empty
 */
export function pickRandom(items) {
  if (!items || items.length === 0) return null;
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}

/**
 * High-level helper used by TestRunner.
 *
 * Given a bot response and a static fallback question, returns:
 *  - A dynamically extracted follow-up question (if list found), OR
 *  - The static fallback question (if no list found and fallback exists), OR
 *  - null (if no list AND no fallback — caller should skip this step)
 *
 * @param {string}      responseText    - previous bot answer to analyse
 * @param {string|null} staticFallback  - Q from the sheet (may be empty)
 * @returns {{ question: string, isDynamic: boolean } | null}
 */
export function resolveNextQuestion(responseText, staticFallback) {
  const items   = extractListItems(responseText);
  const picked  = pickRandom(items);

  if (picked) {
    return { question: picked, isDynamic: true };
  }

  const fallback = (staticFallback ?? '').trim();
  if (fallback) {
    return { question: fallback, isDynamic: false };
  }

  return null; // nothing to send — end conversation here
}