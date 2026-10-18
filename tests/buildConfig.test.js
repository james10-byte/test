import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBuildConfig } from '../backend/src/android/buildConfig.js';
import { validConfig } from './helpers/fixtures.js';

const rejects = (input, code) => assert.throws(() => validateBuildConfig(input), (error) => error.code === code);

test('accepts a complete configuration and normalizes values', () => {
  const config = validateBuildConfig(validConfig({ appName: '  Demo App  ', statusBarColor: '#aabbcc' }));
  assert.equal(config.appName, 'Demo App');
  assert.equal(config.statusBarColor, '#AABBCC');
  assert.equal(config.icon.fit, 'contain');
  assert.equal(config.signing, 'debug');
});

test('applies safe defaults', () => {
  const config = validateBuildConfig({ appName: 'X', inputType: 'zip' });
  assert.equal(config.packageId, 'dev.inconnuboy.apkbuilder');
  assert.equal(config.versionName, '1.0.0');
  assert.equal(config.versionCode, 1);
  assert.equal(config.orientation, 'unspecified');
});

test('rejects invalid application names', () => {
  rejects(validConfig({ appName: '' }), 'invalid_config');
  rejects(validConfig({ appName: 'x'.repeat(31) }), 'invalid_config');
  rejects(validConfig({ appName: 'bad\nname' }), 'invalid_config');
  rejects(validConfig({ appName: 42 }), 'invalid_config');
});

test('rejects invalid package identifiers', () => {
  for (const packageId of ['single', 'Com.Example.App', 'com.example.1app', 'com.example.class', 'com..example', 'com.exa-mple.app', `com.${'a'.repeat(100)}`]) {
    rejects(validConfig({ packageId }), 'invalid_config');
  }
  assert.equal(validateBuildConfig(validConfig({ packageId: 'org.my_company.app2' })).packageId, 'org.my_company.app2');
});

test('rejects invalid versions, colors and orientation', () => {
  rejects(validConfig({ versionCode: 0 }), 'invalid_config');
  rejects(validConfig({ versionCode: 1.5 }), 'invalid_config');
  rejects(validConfig({ versionCode: '3' }), 'invalid_config');
  rejects(validConfig({ versionName: '1.0 beta' }), 'invalid_config');
  rejects(validConfig({ statusBarColor: 'red' }), 'invalid_config');
  rejects(validConfig({ orientation: 'upside-down' }), 'invalid_config');
});

test('rejects unknown fields, bad input types and unsupported signing', () => {
  rejects(validConfig({ keystorePassword: 'secret' }), 'unknown_config_field');
  rejects(validConfig({ inputType: 'git' }), 'invalid_config');
  rejects(validConfig({ signing: 'release' }), 'signing_unsupported');
  rejects(null, 'invalid_config');
  rejects([], 'invalid_config');
});

test('website applications require an https url and other types refuse one', () => {
  const config = validateBuildConfig(validConfig({ inputType: 'url', url: 'https://example.com/app' }));
  assert.equal(config.url, 'https://example.com/app');
  rejects(validConfig({ inputType: 'url', url: 'http://example.com' }), 'https_required');
  rejects(validConfig({ inputType: 'url' }), 'invalid_config');
  rejects(validConfig({ inputType: 'url', url: 'not a url' }), 'invalid_config');
  rejects(validConfig({ inputType: 'html', url: 'https://example.com' }), 'invalid_config');
});

test('icon settings are validated through the icon generator rules', () => {
  rejects(validConfig({ icon: { scale: 5 } }), 'invalid_icon_settings');
  rejects(validConfig({ icon: 'big' }), 'invalid_config');
  assert.equal(validateBuildConfig(validConfig({ icon: { background: '#ffffff' } })).icon.background, '#FFFFFF');
});
