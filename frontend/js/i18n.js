import en from './locales/en.js';
import fr from './locales/fr.js';
import pt from './locales/pt.js';

const catalogs = { en, fr, pt };
let current = 'en';

export const LANGUAGES = Object.freeze([
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'pt', label: 'Português' }
]);

export function getCatalogs() {
  return catalogs;
}

export function setLanguage(code) {
  if (!catalogs[code]) return false;
  current = code;
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  return true;
}

export function getLanguage() {
  return current;
}

export function detectLanguage(preferred, languages = []) {
  if (preferred && catalogs[preferred]) return preferred;
  for (const language of languages) {
    const base = String(language).toLowerCase().split('-')[0];
    if (catalogs[base]) return base;
  }
  return 'en';
}

export function t(key, parameters) {
  const template = catalogs[current][key] ?? catalogs.en[key] ?? key;
  if (!parameters) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in parameters ? String(parameters[name]) : match));
}
