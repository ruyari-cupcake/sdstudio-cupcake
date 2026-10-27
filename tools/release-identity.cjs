'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function releaseIdentity(pkg) {
  const version = pkg.version;
  const match = /^(\d+)\.(\d+)\.(\d+)-cupcake\.(\d+)$/.exec(version);
  assert(match, 'Expected x.y.z-cupcake.n release version');
  const [, major, minor, patch, edition] = match.map(Number);
  assert(minor < 100 && patch < 100 && edition < 100, 'Android version segments exceed limits');
  const versionCode = major * 1000000 + minor * 10000 + patch * 100 + edition;
  assert(versionCode > 0 && versionCode < 2100000000, 'Android versionCode exceeds limits');
  const { appId, productName, publish } = pkg.build;
  assert(/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(appId), 'Invalid application identity');
  assert(typeof productName === 'string' && /^[\w .-]+$/.test(productName), 'Invalid executable product name');
  assert(publish.provider === 'github' && typeof publish.private === 'boolean', 'Explicit GitHub release channel required');
  assert(/^[\w.-]+$/.test(publish.owner) && /^[\w.-]+$/.test(publish.repo), 'Invalid GitHub release repository');
  assert(!('token' in publish), 'Tokens must never enter build metadata');
  const project = `${publish.owner}/${publish.repo}`;
  assert.equal(pkg.repository.url.replace(/\.git$/, '').replace(/\/$/, ''), `https://github.com/${project}`, 'Source and release repository differ');
  return {
    version, versionCode, appId, productName, project,
    channel: publish.private ? 'private' : 'public',
    artifactPrefix: productName.replace(/\s+/g, '-'),
    executable: `${productName}.exe`,
  };
}

function readReleaseIdentity(root = path.resolve(__dirname, '..')) {
  return releaseIdentity(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
}

module.exports = { releaseIdentity, readReleaseIdentity };

if (require.main === module) {
  console.log(JSON.stringify(readReleaseIdentity()));
}
