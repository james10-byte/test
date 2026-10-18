import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '../errors.js';

const blockedRanges = new net.BlockList();

const ipv4Ranges = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3]
];

const ipv6Ranges = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
];

for (const [address, prefix] of ipv4Ranges) blockedRanges.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of ipv6Ranges) blockedRanges.addSubnet(address, prefix, 'ipv6');

const blockedHostnames = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const blockedSuffixes = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];
const allowedPorts = new Set([80, 443, 8080, 8443]);

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true;
  return blockedRanges.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const isBlockedHostname = (hostname) =>
  blockedHostnames.has(hostname) || blockedSuffixes.some((suffix) => hostname.endsWith(suffix));

const stripBrackets = (hostname) =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

export const defaultResolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export async function validatePublicUrl(raw, { resolver = defaultResolver } = {}) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new AppError(422, 'invalid_url', 'The URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(422, 'unsupported_scheme', 'Only http and https URLs are supported.');
  }
  if (url.username || url.password) {
    throw new AppError(422, 'credentials_not_allowed', 'URLs containing credentials are not allowed.');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!allowedPorts.has(port)) {
    throw new AppError(422, 'port_not_allowed', 'This port is not permitted.');
  }
  const hostname = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  if (!hostname || isBlockedHostname(hostname)) {
    throw new AppError(422, 'blocked_host', 'This host name is not permitted.');
  }
  let addresses;
  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new AppError(422, 'dns_failure', 'The host name could not be resolved.');
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new AppError(422, 'dns_failure', 'The host name could not be resolved.');
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new AppError(422, 'blocked_address', 'The URL resolves to a non-public network address.');
    }
  }
  return {
    url,
    hostname,
    address: addresses[0].address,
    family: addresses[0].family,
    addresses
  };
}

export function httpRequester({ url, address, family, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'user-agent': 'INCONNU-BOY-APK-BUILDER-probe',
          accept: 'text/html,*/*;q=0.5'
        },
        lookup: (_hostname, options, callback) => {
          if (options && options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }
      },
      (response) => {
        const result = {
          status: response.statusCode,
          location: response.headers.location ?? null,
          contentType: response.headers['content-type'] ?? null
        };
        response.destroy();
        resolve(result);
      }
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

export async function probeUrl(
  raw,
  { resolver = defaultResolver, requester = httpRequester, maxRedirects = 3, timeoutMs = 8000 } = {}
) {
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await validatePublicUrl(current, { resolver });
    let response;
    try {
      response = await requester({
        url: target.url,
        address: target.address,
        family: target.family,
        timeoutMs
      });
    } catch (error) {
      if (error && error.message === 'timeout') {
        throw new AppError(504, 'connection_timeout', 'The website did not respond in time.');
      }
      throw new AppError(502, 'connection_failed', 'The website could not be reached.');
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      try {
        current = new URL(response.location, target.url).toString();
      } catch {
        throw new AppError(422, 'invalid_redirect', 'The website returned an invalid redirect.');
      }
      continue;
    }
    return {
      finalUrl: target.url.toString(),
      status: response.status,
      redirects: hop,
      secure: target.url.protocol === 'https:',
      contentType: response.contentType
    };
  }
  throw new AppError(422, 'too_many_redirects', 'The website redirected too many times.');
}
