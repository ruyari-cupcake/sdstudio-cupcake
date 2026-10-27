#!/usr/bin/env node
'use strict';

// One version and one installed Android identity for the maintained Cupcake fork.
// Gradle's namespace deliberately stays io.sunho.SDStudio: the native JNI methods
// are bound to those Java class names, while applicationId is the install identity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readReleaseIdentity } = require('./release-identity.cjs');

const root = path.resolve(__dirname, '..');
const identity = readReleaseIdentity(root);
const androidId = identity.appId;
const productName = identity.productName;
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const androidVersionCode = identity.versionCode;
assert.equal(pkg.build.productName, productName);
assert.equal(
  pkg.extraMetadata.version,
  pkg.version,
  'Packaged Electron version differs',
);

// Electron Builder packages release/app as the real app. The root manifest
// alone cannot prove the Windows executable's installed version or filename.
for (const [file, label, isLockfile] of [
  ['package-lock.json', 'Root npm lockfile', true],
  ['release/app/package.json', 'Packaged Electron manifest', false],
  ['release/app/package-lock.json', 'Packaged Electron lockfile', true],
]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (process.argv.includes('--write')) {
    manifest.version = pkg.version;
    if (isLockfile) manifest.packages[''].version = pkg.version;
    else {
      manifest.productName = productName;
      manifest.description = pkg.description;
    }
    fs.writeFileSync(path.join(root, file), JSON.stringify(manifest, null, 2) + '\n');
  }
  assert.equal(manifest.version, pkg.version, `${label} version differs`);
  if (isLockfile) {
    assert.equal(
      manifest.packages[''].version,
      pkg.version,
      `${label} root package version differs`,
    );
  }
  if (file === 'release/app/package.json') {
    assert.equal(manifest.productName, productName, 'Packaged product name differs');
  }
}

const gradlePath = path.join(root, 'android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
function field(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, 1, `Expected exactly one ${label}`);
  return matches[0][1];
}
assert.equal(
  field(gradle, /^\s*applicationId\s+["']([^"']+)["']/gm, 'applicationId'),
  androidId,
);
if (process.argv.includes('--write')) {
  gradle = gradle
    .replace(
      /^(\s*versionCode\s+)\d+/m,
      (_, prefix) => `${prefix}${androidVersionCode}`,
    )
    .replace(
      /^(\s*versionName\s+)["'][^"']+["']/m,
      (_, prefix) => `${prefix}"${pkg.version}"`,
    );
  fs.writeFileSync(gradlePath, gradle);
}
assert.equal(
  Number(field(gradle, /^\s*versionCode\s+(\d+)/gm, 'versionCode')),
  androidVersionCode,
);
assert.equal(
  field(gradle, /^\s*versionName\s+["']([^"']+)["']/gm, 'versionName'),
  pkg.version,
);

for (const config of ['capacitor.config.ts', 'capacitor.config.deploy.ts']) {
  const text = fs.readFileSync(path.join(root, config), 'utf8');
  assert.equal(
    field(text, /\bappId:\s*['"]([^'"]+)['"]/g, config + ' appId'),
    androidId,
  );
  assert.equal(
    field(text, /\bappName:\s*['"]([^'"]+)['"]/g, config + ' appName'),
    productName,
  );
}
const strings = fs.readFileSync(
  path.join(root, 'android/app/src/main/res/values/strings.xml'),
  'utf8',
);
for (const key of ['app_name', 'title_activity_main']) {
  assert.equal(
    field(
      strings,
      new RegExp('<string name="' + key + '">([^<]+)</string>', 'g'),
      key,
    ),
    productName,
  );
}
for (const key of ['package_name', 'custom_url_scheme']) {
  assert.equal(
    field(
      strings,
      new RegExp('<string name="' + key + '">([^<]+)</string>', 'g'),
      key,
    ),
    androidId,
  );
}
const tagOption = process.argv.find((arg) => arg.startsWith('--tag='));
if (tagOption) {
  assert.equal(
    tagOption.slice(6),
    `v${pkg.version}`,
    'Release Git tag does not match package version',
  );
}
if (process.argv.includes('--ci-env')) {
  assert(process.env.GITHUB_ENV, 'GitHub environment file is required');
  fs.appendFileSync(process.env.GITHUB_ENV, [
    `version=${identity.version}`,
    `version_code=${identity.versionCode}`,
    `artifact_prefix=${identity.artifactPrefix}`,
    `app_executable=${identity.executable}`,
    `app_id=${identity.appId}`,
    `release_channel=${identity.channel}`,
    '',
  ].join('\n'));
}
console.log(
  `SDSTUDIO_RELEASE_IDENTITY_OK version=${pkg.version} androidId=${androidId} versionCode=${androidVersionCode}`,
);
