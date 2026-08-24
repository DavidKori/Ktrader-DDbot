import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src');

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
}

const files = walk(src);
const problems = [];
const legacyImports = [];
const iconNames = new Set();

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);

    if (text.includes('@/utils/tmp/dummy')) {
        problems.push(`${rel}: stale @/utils/tmp/dummy import`);
    }

    for (const match of text.matchAll(/<Icon\b[\s\S]{0,300}?\bicon\s*=\s*['"]([^'"]+)['"]/g)) {
        iconNames.add(match[1]);
    }

    if (text.includes("from '@/utils/icon-compat'")) legacyImports.push(rel);
}

const compat = fs.readFileSync(path.join(src, 'utils', 'icon-compat.tsx'), 'utf8');
const unresolved = [...iconNames].filter(name => !compat.includes(`case '${name}'`));

if (unresolved.length) {
    problems.push(`icon-compat.tsx has no explicit mapping for: ${unresolved.join(', ')}`);
}

if (fs.existsSync(path.join(src, 'utils', 'tmp', 'dummy.ts'))) {
    problems.push('stale src/utils/tmp/dummy.ts still exists');
}

if (problems.length) {
    console.error('ICON AUDIT FAILED');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
}

console.log('ICON AUDIT PASSED');
console.log(`- TypeScript/JavaScript source files scanned: ${files.length}`);
console.log(`- legacy Icon consumers using compatibility layer: ${legacyImports.length}`);
console.log(`- literal legacy icon names detected: ${iconNames.size}`);
console.log('- stale dummy resolver: absent');
