const fs = require('fs');
const path = require('path');

const IGNORE = ['node_modules', 'dist', 'build', '.git', 'functions/lib'];
const MATCH = /logo|icon|splash|favicon/i;
const EXT = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.xml'];

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat && stat.isDirectory()) {
      if (!IGNORE.includes(file)) results = results.concat(walk(full));
    } else {
      if (MATCH.test(file) || EXT.includes(path.extname(file).toLowerCase())) {
        results.push(full);
      }
    }
  }
  return results;
}

const files = walk(process.cwd());
fs.writeFileSync('inventory.json', JSON.stringify(files, null, 2));
console.log(`Found ${files.length} matching files.`);
