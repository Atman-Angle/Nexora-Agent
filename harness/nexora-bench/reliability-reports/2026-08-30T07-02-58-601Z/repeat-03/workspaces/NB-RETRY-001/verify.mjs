import { readFileSync } from 'fs';

const result = readFileSync('result.txt', 'utf8');
const expected = 'transient-service-value=ready\n';

if (result === expected) {
  console.log('VERIFIER: PASS');
  process.exit(0);
} else {
  console.error('VERIFIER: FAIL');
  console.error(`Expected: ${JSON.stringify(expected)}`);
  console.error(`Got:      ${JSON.stringify(result)}`);
  process.exit(1);
}
