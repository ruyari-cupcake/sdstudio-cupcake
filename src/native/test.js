const fs = require('fs');
const { inspect } = require('util');
const prompt = require('prompt-sync')();
const { createDB, search, loadDB, releaseDB } = require('.');

const db = createDB('test');
try {
  const content = fs.readFileSync('db.csv', 'utf8');
  loadDB(db, content);
  let input = prompt('Enter a search term (/quit to exit): ');
  while (input !== null && input !== '/quit') {
    const before = Date.now();
    const result = search(db, input);
    const after = Date.now();
    process.stdout.write(`Search took ${after - before} ms\n`);
    process.stdout.write(`${inspect(result.slice(0, 20))}\n`);
    input = prompt('Enter a search term (/quit to exit): ');
  }
} finally {
  releaseDB(db);
}
