import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { extractZip } from '../security/zipSafe.js';

const HTML_FILE = /\.html?$/i;
const HTML_MARKER = /<\s*(!doctype\s+html|html|head|body|div|script|main|section|h1|p)\b/i;
const REFERENCE_PATTERN = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const IGNORED_SCHEMES = /^(data:|mailto:|tel:|javascript:|blob:|about:)/i;
const MAXIMUM_CANDIDATES = 20;

export function zipLimitsFromConfig(limits) {
  return {
    maxCompressedBytes: limits.maxUploadBytes,
    maxExtractedBytes: limits.maxExtractedBytes,
    maxEntryBytes: limits.maxExtractedBytes,
    maxFiles: limits.maxZipFiles,
    maxDepth: limits.maxZipDepth
  };
}

function resolveEntry(paths, prefix) {
  const rootFiles = paths.filter((segments) => segments.length === 1);
  const rootHtml = rootFiles.filter((segments) => HTML_FILE.test(segments[0]));
  const index = rootHtml.find((segments) => segments[0].toLowerCase() === 'index.html');
  if (index) return { rootDirectory: prefix, entryFile: index[0] };
  if (rootHtml.length === 1) return { rootDirectory: prefix, entryFile: rootHtml[0][0] };
  if (rootHtml.length > 1) {
    throw new AppError(
      422,
      'ambiguous_entry_point',
      'Several HTML files were found and none is named index.html.',
      { candidates: rootHtml.slice(0, MAXIMUM_CANDIDATES).map((segments) => path.posix.join(prefix, segments[0])) }
    );
  }
  const directories = new Set(paths.filter((segments) => segments.length > 1).map((segments) => segments[0]));
  if (rootFiles.length === 0 && directories.size === 1) {
    const [directory] = [...directories];
    const nested = paths.map((segments) => segments.slice(1));
    return resolveEntry(nested, prefix ? path.posix.join(prefix, directory) : directory);
  }
  const allHtml = paths
    .filter((segments) => HTML_FILE.test(segments[segments.length - 1]))
    .sort((left, right) => left.length - right.length)
    .map((segments) => path.posix.join(prefix, ...segments));
  if (allHtml.length === 0) {
    throw new AppError(422, 'missing_entry_point', 'No HTML file was found in the archive.');
  }
  throw new AppError(
    422,
    'ambiguous_entry_point',
    'The entry point could not be determined automatically.',
    { candidates: allHtml.slice(0, MAXIMUM_CANDIDATES) }
  );
}

export function detectEntryPoint(files) {
  return resolveEntry(files.map((file) => file.split('/')), '');
}

export function collectReferenceWarnings(html, availableFiles, baseDirectory = '') {
  const available = new Set(availableFiles);
  const missing = new Set();
  const external = new Set();
  for (const match of html.matchAll(REFERENCE_PATTERN)) {
    const reference = (match[1] ?? match[2] ?? '').trim();
    if (reference === '' || reference.startsWith('#') || IGNORED_SCHEMES.test(reference)) continue;
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(reference)) {
      external.add(reference);
      continue;
    }
    const withoutSuffix = reference.split('#')[0].split('?')[0];
    if (withoutSuffix === '') continue;
    let decoded = withoutSuffix;
    try {
      decoded = decodeURIComponent(withoutSuffix);
    } catch {
      decoded = withoutSuffix;
    }
    const joined = decoded.startsWith('/')
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.normalize(path.posix.join(baseDirectory, decoded));
    if (joined.startsWith('..') || !available.has(joined)) missing.add(reference);
  }
  const warnings = [];
  if (missing.size > 0) {
    warnings.push({
      code: 'missing_local_resources',
      message: 'Some local resources referenced by the page are not included in the project.',
      items: [...missing].slice(0, 50)
    });
  }
  if (external.size > 0) {
    warnings.push({
      code: 'external_resources',
      message: 'The page loads external resources. They will only work when the device is online.',
      items: [...external].slice(0, 50)
    });
  }
  return warnings;
}

export async function ingestHtml(buffer, destination, { maxBytes }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(422, 'empty_html', 'The HTML file is empty.');
  }
  if (buffer.length > maxBytes) {
    throw new AppError(413, 'html_too_large', 'The HTML file exceeds the allowed size.');
  }
  if (buffer.includes(0)) {
    throw new AppError(422, 'invalid_html', 'The file is not a readable HTML document.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError(422, 'invalid_encoding', 'The HTML file must be encoded as UTF-8.');
  }
  if (!HTML_MARKER.test(text)) {
    throw new AppError(422, 'invalid_html', 'The file does not look like an HTML document.');
  }
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'index.html'), buffer, { flag: 'wx', mode: 0o644 });
  return {
    rootDirectory: '',
    entryFile: 'index.html',
    files: ['index.html'],
    warnings: collectReferenceWarnings(text, ['index.html'])
  };
}

export async function ingestZip(buffer, destination, limits) {
  const { files } = await extractZip(buffer, destination, zipLimitsFromConfig(limits));
  const { rootDirectory, entryFile } = detectEntryPoint(files);
  const entryPath = path.posix.join(rootDirectory, entryFile);
  const html = await fs.readFile(path.join(destination, ...entryPath.split('/')), 'utf8');
  const prefix = rootDirectory === '' ? '' : `${rootDirectory}/`;
  const projectFiles = files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
  return {
    rootDirectory,
    entryFile,
    files: projectFiles,
    warnings: collectReferenceWarnings(html, projectFiles, path.posix.dirname(entryFile) === '.' ? '' : path.posix.dirname(entryFile))
  };
}

export function collectPackagingWarnings(files) {
  const hidden = files.filter((file) => file.split('/').some((segment, index, all) => segment.startsWith('.') || (segment.startsWith('_') && index < all.length - 1)));
  if (hidden.length === 0) return [];
  return [
    {
      code: 'assets_may_be_ignored',
      message: 'Android may skip files or folders whose names start with a dot, and folders starting with an underscore.',
      items: hidden.slice(0, 50)
    }
  ];
}
