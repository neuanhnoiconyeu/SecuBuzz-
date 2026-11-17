const fs = require('node:fs');
const path = require('node:path');
// Next may add generated-type includes. Keep those edits out of the user's main tsconfig.
function isolatedTsconfig(dist) {
  if (!/^\.next-e2ee-[a-z0-9-]+$/.test(dist)) throw new Error('Invalid isolated build directory.');
  const filename = '.e2ee-typescript-' + dist.slice('.next-e2ee-'.length) + '.json';
  const target = path.join(__dirname, '..', filename);
  if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify({ extends: './tsconfig.json',
    include: ['next-env.d.ts', 'src/**/*.ts', 'src/**/*.tsx', dist + '/types/**/*.ts'], exclude: ['node_modules', 'tmp'] }, null, 2) + '\n');
  return './' + filename;
}
module.exports = { isolatedTsconfig };
