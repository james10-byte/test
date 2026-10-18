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

export const isHexColor = (value) => typeof value === 'string' && HEX_COLOR.test(value);

export function validatePackageId(value) {
  if (typeof value !== 'string' || value === '') return { key: 'validation.required' };
  const segments = value.split('.');
  if (value.length > 100 || segments.length < 2 || !segments.every((segment) => PACKAGE_SEGMENT.test(segment))) {
    return { key: 'validation.packageId' };
  }
  const reserved = segments.find((segment) => JAVA_KEYWORDS.has(segment));
  if (reserved) return { key: 'validation.packageKeyword', parameters: { word: reserved } };
  return null;
}

export function validateUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return { key: 'validation.required' };
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { key: 'validation.url' };
  }
  if (parsed.protocol !== 'https:') return { key: 'validation.https' };
  return null;
}

export function validateAppForm(values) {
  const errors = {};
  const name = typeof values.appName === 'string' ? values.appName.trim() : '';
  if (name === '') errors.appName = { key: 'validation.required' };
  else if (name.length > 30 || CONTROL_CHARACTERS.test(name)) errors.appName = { key: 'validation.appName' };
  const packageError = validatePackageId(values.packageId);
  if (packageError) errors.packageId = packageError;
  if (typeof values.versionName !== 'string' || !VERSION_NAME.test(values.versionName)) {
    errors.versionName = { key: 'validation.versionName' };
  }
  const code = Number(values.versionCode);
  if (!/^\d+$/.test(String(values.versionCode)) || code < 1 || code > MAXIMUM_VERSION_CODE) {
    errors.versionCode = { key: 'validation.versionCode' };
  }
  if (!isHexColor(values.statusBarColor)) errors.statusBarColor = { key: 'validation.color' };
  if (!isHexColor(values.navigationBarColor)) errors.navigationBarColor = { key: 'validation.color' };
  if (values.inputType === 'url') {
    const urlError = validateUrl(values.url);
    if (urlError) errors.source = urlError;
  } else if (!values.file) {
    errors.source = { key: 'validation.fileRequired' };
  }
  return errors;
}

export function buildConfigPayload(values) {
  const payload = {
    appName: values.appName.trim(),
    packageId: values.packageId,
    versionName: values.versionName,
    versionCode: Number(values.versionCode),
    orientation: values.orientation,
    statusBarColor: values.statusBarColor.toUpperCase(),
    navigationBarColor: values.navigationBarColor.toUpperCase(),
    inputType: values.inputType,
    icon: { ...values.icon },
    signing: 'debug'
  };
  if (values.inputType === 'url') payload.url = values.url.trim();
  return payload;
}
