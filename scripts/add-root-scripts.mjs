import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

pkg.scripts = pkg.scripts || {};
pkg.scripts['proxy'] = 'npm --prefix server-node start';
pkg.scripts['proxy:dev'] = 'npm --prefix server-node run dev';
pkg.scripts['setup:proxy'] = 'npm --prefix server-node install';

fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Added proxy scripts to root package.json');
