import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'server-node'];
const forbidden = [
  'ws.derivws.com',
  'ws.binaryws.com',
  'websockets/v3',
  'DERIV_LEGACY_APP_ID',
  'DERIV_USE_NEW_API',
  'otp_code',
];

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry.name)) files.push(full);
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

let failures = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const token of forbidden) {
    if (text.includes(token)) {
      failures++;
      console.error(`FAIL: ${token} -> ${file}`);
    }
  }
}

const server = fs.readFileSync('server-node/index.js', 'utf8');
for (const required of [
  "https://auth.deriv.com/oauth2/auth",
  "https://auth.deriv.com/oauth2/token",
  "https://api.derivws.com",
  "/trading/v1/options/accounts",
  "/otp",
  "code_verifier",
  "code_challenge_method",
]) {
  if (!server.includes(required)) {
    failures++;
    console.error(`FAIL: required new-API marker missing: ${required}`);
  }
}

if (failures) {
  console.error(`\nNEW API AUDIT FAILED: ${failures} finding(s).`);
  process.exit(1);
}

console.log(`PASS: scanned ${files.length} source files.`);
console.log('PASS: no active legacy transport markers found.');
console.log('PASS: OAuth PKCE + Options REST/OTP markers present.');
