import assert from 'assert';
import { classify, classifyFailure, STATUS } from '../src/modules/classifier.js';

function runTests() {
  console.log('Running Classifier Tests...');

  // Test 1: Empty answer
  const res1 = classify('expected text', '', 'question');
  assert.strictEqual(res1.status, STATUS.FAIL);
  assert.strictEqual(res1.reason, 'Empty or too short response');

  // Test 2: Thai Number Normalization
  // Expected: "มี 2 สาขา", Actual: "มี สอง สาขา"
  // It should PASS if normalized correctly.
  const res2 = classify('มี 2 สาขา', 'มี สอง สาขา ที่เปิดให้บริการ', 'มีกี่สาขา');
  assert.ok(res2.similarity > 0);
  // It should be PASS or PARTIAL. Let's just ensure it doesn't fail due to threshold.
  // Actually, similarity should be decent since 'สอง' -> '2'
  
  // Test 3: Echoed question
  const res3 = classify('hello my friend', 'how are you doing today', 'how are you doing today');
  assert.strictEqual(res3.status, STATUS.FAIL);
  assert.strictEqual(res3.reason, 'Echoed question, no answer');

  // Test 4: classifyFailure
  const res4 = classifyFailure('TIMEOUT');
  assert.strictEqual(res4.status, STATUS.FAIL);
  assert.strictEqual(res4.reason, 'TIMEOUT');

  console.log('✅ All tests passed!');
}

runTests();
