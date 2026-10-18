import { AppError } from '../errors.js';
import { normalizeIconSettings } from '../icons/iconGenerator.js';

export const ORIENTATIONS = Object.freeze(['unspecified', 'portrait', 'landscape', 'sensor']);
export const INPUT_TYPES = Object.freeze(['html', 'zip', 'url']);
export const SIGNING_MODES = Object.freeze(['debug']);

const ALLOWED_FIELDS = new Set([
  'appName',
  'packageId',
  'versionName',
  'versionCode',
  'orientation',
  'statusBarColor',
  'navigationBarColor',
  'inputType',
  'url',
  'icon',
  'signing'
]);

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'
]);

const PACKAGE_SEGMENT = /^[a-z][a-z0-9_]*$/;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,29}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAXIMUM_VERSION_CODE = 2100000000;

const invalid = (message) => new AppError(422, 'invalid_config', message);

function readAppName(value) {
  if (typeof value !== 'string') throw invalid('appName is required.');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 30) throw invalid('appName must contain between 1 and 30 characters.');
  if (CONTROL_CHARACTERS.test(trimmed)) throw invalid('appName must not contain control characters.');
  return trimmed;
}

function readPackageId(value) {
  const packageId = value ?? 'dev.inconnuboy.apkbuilder';
  if (typeof packageId !== 'string' || packageId.length > 100) throw invalid('packageId is not valid.');
  const segments = packageId.split('.');
  if (segments.length < 2) throw invalid('packageId must contain at least two segments, for example com.example.app.');
  for (const segment of segments) {
    if (!PACKAGE_SEGMENT.test(segment)) {
      throw invalid('packageId segments must start with a lowercase letter and contain only lowercase letters, digits and underscores.');
    }
    if (JAVA_KEYWORDS.has(segment)) throw invalid(`packageId must not contain the reserved word "${segment}".`);
  }
  return packageId;
}

function readVersionName(value) {
  const versionName = value ?? '1.0.0';
  if (typeof versionName !== 'string' || !VERSION_NAME.test(versionName)) {
    throw invalid('versionName must be 1 to 30 characters of letters, digits, dots, plus, underscore or hyphen.');
  }
  return versionName;
}

function readVersionCode(value) {
  const versionCode = value ?? 1;
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAXIMUM_VERSION_CODE) {
    throw invalid(`versionCode must be an integer between 1 and ${MAXIMUM_VERSION_CODE}.`);
  }
  return versionCode;
}

function readColor(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) throw invalid(`${label} must be a color in #RRGGBB format.`);
  return value.toUpperCase();
}

function readUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw invalid('url is required for website applications.');
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalid('url is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new AppError(422, 'https_required', 'Website applications require an https URL.');
  }
  return parsed.toString();
}

export function validateBuildConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('config must be an object.');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) throw new AppError(422, 'unknown_config_field', `Unknown configuration field: ${key}.`);
  }
  if (!INPUT_TYPES.includes(input.inputType)) throw invalid('inputType must be html, zip or url.');
  const orientation = input.orientation ?? 'unspecified';
  if (!ORIENTATIONS.includes(orientation)) throw invalid(`orientation must be one of ${ORIENTATIONS.join(', ')}.`);
  const signing = input.signing ?? 'debug';
  if (!SIGNING_MODES.includes(signing)) {
    throw new AppError(422, 'signing_unsupported', 'Only debug signing is available in this version.');
  }
  if (input.icon !== undefined && (input.icon === null || typeof input.icon !== 'object' || Array.isArray(input.icon))) {
    throw invalid('icon must be an object.');
  }
  const config = {
    appName: readAppName(input.appName),
    packageId: readPackageId(input.packageId),
    versionName: readVersionName(input.versionName),
    versionCode: readVersionCode(input.versionCode),
    orientation,
    statusBarColor: readColor(input.statusBarColor, '#0B1020', 'statusBarColor'),
    navigationBarColor: readColor(input.navigationBarColor, '#0B1020', 'navigationBarColor'),
    inputType: input.inputType,
    icon: normalizeIconSettings(input.icon ?? {}),
    signing
  };
  if (input.inputType === 'url') config.url = readUrl(input.url);
  else if (input.url !== undefined) throw invalid('url is only allowed for website applications.');
  return config;
}
