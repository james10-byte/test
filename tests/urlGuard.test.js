import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlockedAddress, probeUrl, validatePublicUrl } from '../backend/src/security/urlGuard.js';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const resolverFor = (table) => async (hostname) => {
  if (!(hostname in table)) throw new Error('ENOTFOUND');
  return table[hostname].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const rejects = (raw, code, resolver = publicResolver) =>
  assert.rejects(() => validatePublicUrl(raw, { resolver }), (error) => error.code === code);

test('accepts public https and http urls', async () => {
  const result = await validatePublicUrl('https://example.com/path?q=1', { resolver: publicResolver });
  assert.equal(result.address, '93.184.216.34');
  assert.equal((await validatePublicUrl('http://example.com', { resolver: publicResolver })).url.protocol, 'http:');
});

test('rejects invalid syntax and unsupported schemes', async () => {
  await rejects('not a url', 'invalid_url');
  await rejects('ftp://example.com', 'unsupported_scheme');
  await rejects('file:///etc/passwd', 'unsupported_scheme');
  await rejects('javascript:alert(1)', 'unsupported_scheme');
});

test('rejects credentials and unusual ports', async () => {
  await rejects('https://user:pass@example.com', 'credentials_not_allowed');
  await rejects('http://example.com:22', 'port_not_allowed');
});

test('rejects localhost and internal host names', async () => {
  await rejects('http://localhost', 'blocked_host');
  await rejects('http://app.localhost', 'blocked_host');
  await rejects('http://metadata.google.internal', 'blocked_host');
  await rejects('http://printer.local', 'blocked_host');
});

test('rejects loopback, private, link-local and metadata addresses', async () => {
  await rejects('http://127.0.0.1', 'blocked_address');
  await rejects('http://127.1', 'blocked_address');
  await rejects('http://2130706433', 'blocked_address');
  await rejects('http://10.1.2.3', 'blocked_address');
  await rejects('http://172.16.5.5', 'blocked_address');
  await rejects('http://192.168.1.1', 'blocked_address');
  await rejects('http://169.254.169.254/latest/meta-data', 'blocked_address');
  await rejects('http://100.100.100.200', 'blocked_address');
  await rejects('http://[::1]', 'blocked_address');
  await rejects('http://[::ffff:127.0.0.1]', 'blocked_address');
  await rejects('http://[fe80::1]', 'blocked_address');
  await rejects('http://[fd00::1]', 'blocked_address');
  await rejects('http://0.0.0.0', 'blocked_address');
});

test('rejects names that resolve to private or mixed addresses', async () => {
  await rejects('https://internal.example', 'blocked_address', resolverFor({ 'internal.example': ['10.0.0.5'] }));
  await rejects('https://mixed.example', 'blocked_address', resolverFor({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }));
  await rejects('https://missing.example', 'dns_failure', resolverFor({}));
});

test('public addresses are not blocked', () => {
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('probe pins the validated address for the connection', async () => {
  let received;
  const requester = async (request) => {
    received = request;
    return { status: 200, location: null, contentType: 'text/html' };
  };
  const result = await probeUrl('https://example.com', { resolver: publicResolver, requester });
  assert.equal(received.address, '93.184.216.34');
  assert.equal(result.secure, true);
  assert.equal(result.status, 200);
});

test('probe revalidates every redirect', async () => {
  const resolver = resolverFor({ 'start.example': ['93.184.216.34'], 'internal.example': ['192.168.1.10'] });
  const requester = async () => ({ status: 302, location: 'http://internal.example/admin', contentType: null });
  await assert.rejects(() => probeUrl('https://start.example', { resolver, requester }), (error) => error.code === 'blocked_address');
});

test('probe detects dns rebinding between hops', async () => {
  let calls = 0;
  const resolver = async () => {
    calls += 1;
    return [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  };
  const requester = async () => ({ status: 301, location: 'https://rebind.example/next', contentType: null });
  await assert.rejects(() => probeUrl('https://rebind.example', { resolver, requester }), (error) => error.code === 'blocked_address');
});

test('probe follows safe redirects and limits their number', async () => {
  let step = 0;
  const requester = async () => {
    step += 1;
    return step < 3 ? { status: 302, location: '/next', contentType: null } : { status: 200, location: null, contentType: 'text/html' };
  };
  const result = await probeUrl('https://example.com', { resolver: publicResolver, requester });
  assert.equal(result.redirects, 2);
  const looping = async () => ({ status: 302, location: '/again', contentType: null });
  await assert.rejects(() => probeUrl('https://example.com', { resolver: publicResolver, requester: looping }), (error) => error.code === 'too_many_redirects');
});

test('probe maps timeouts and connection errors', async () => {
  const timeout = async () => {
    throw new Error('timeout');
  };
  const refused = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(() => probeUrl('https://example.com', { resolver: publicResolver, requester: timeout }), (error) => error.code === 'connection_timeout' && error.status === 504);
  await assert.rejects(() => probeUrl('https://example.com', { resolver: publicResolver, requester: refused }), (error) => error.code === 'connection_failed');
});
