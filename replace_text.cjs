const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(full));
    } else {
      if (full.endsWith('.tsx') || full.endsWith('.ts')) {
        results.push(full);
      }
    }
  }
  return results;
}

const files = walk(path.join(process.cwd(), 'src'));
for (const f of files) {
  let text = fs.readFileSync(f, 'utf8');
  let changed = false;
  
  if (text.includes('backdrop-blur-2xl') || text.includes('backdrop-blur-xl')) {
    text = text.replace(/backdrop-blur-(2xl|xl)/g, 'backdrop-blur-md');
    changed = true;
  }
  
  if (text.includes('AI Smart Stick')) {
    text = text.replace(/AI Smart Stick/g, 'AI SmartStick');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(f, text, 'utf8');
  }
}
console.log('Replaced successfully');
