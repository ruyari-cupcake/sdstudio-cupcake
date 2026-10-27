'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readReleaseIdentity } = require('./release-identity.cjs');

const MANIFEST_NAME = '.cupcake-app-files.json';

function writeAppManifest(folder, identity) {
  const root = fs.lstatSync(folder);
  assert(root.isDirectory() && !root.isSymbolicLink(), 'Application package root must be a regular directory');
  const files = [];
  const names = new Set();
  function visit(relative) {
    const directory = path.join(folder, relative);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      assert(!entry.isSymbolicLink(), `Application package contains a link: ${child}`);
      if (!relative && entry.name === MANIFEST_NAME) {
        assert(entry.isFile(), 'Existing application manifest must be a regular file');
        continue;
      }
      assert(!entry.name.includes('\\') && !entry.name.includes(':'), `Invalid package entry: ${child}`);
      const folded = child.toLowerCase();
      assert(!names.has(folded), `Case-colliding application entry: ${child}`);
      names.add(folded);
      if (entry.isDirectory()) visit(child);
      else {
        assert(entry.isFile(), `Application package contains a special entry: ${child}`);
        files.push(child);
      }
    }
  }
  visit('');
  assert(files.includes(identity.executable), 'Packaged executable is missing');
  const manifest = {
    schema: 1, appId: identity.appId, channel: identity.channel,
    executable: identity.executable, files: files.sort(),
  };
  fs.writeFileSync(path.join(folder, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = { MANIFEST_NAME, writeAppManifest };

if (require.main === module) {
  const folder = process.argv[2] || path.join(__dirname, '../release/build/win-unpacked');
  const result = writeAppManifest(path.resolve(folder), readReleaseIdentity());
  console.log(`APP_MANIFEST_OK channel=${result.channel} files=${result.files.length}`);
}
