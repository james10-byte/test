import { formatBytes } from '../format.js';
import { LANGUAGES, getLanguage, t } from '../i18n.js';
import { isValidToken, normalizeApiBase } from '../storage.js';
import { isHexColor, validatePackageId } from '../validation.js';
import { copyText, h, icon, toast } from '../ui.js';

const ORIENTATIONS = ['unspecified', 'portrait', 'landscape', 'sensor'];
const THEMES = ['dark', 'light', 'system'];

const field = (id, label, control, hint, errorNode) =>
  h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control, hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null, errorNode ?? null);

export function renderSettings(main, { api, getSettings, updateSettings }) {
  const settings = getSettings();
  const section = (title, ...children) => h('section', { class: 'settings-section' }, h('h2', { class: 'section-title' }, title), ...children);

  const languageSelect = h('select', { class: 'input', id: 'language' }, LANGUAGES.map((language) => h('option', { value: language.code, selected: language.code === getLanguage() }, language.label)));
  languageSelect.addEventListener('change', () => updateSettings({ language: languageSelect.value }));

  const themeGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': t('settings.theme') },
    THEMES.map((theme) => {
      const input = h('input', { type: 'radio', name: 'theme', value: theme, id: `theme-${theme}`, class: 'segment-input', checked: settings.theme === theme });
      input.addEventListener('change', () => updateSettings({ theme }));
      return h('label', { class: 'segment', for: `theme-${theme}` }, input, h('span', null, t(`theme.${theme}`)));
    })
  );

  const defaultsForm = {
    packageId: h('input', { class: 'input', id: 'default-package', type: 'text', value: settings.defaults.packageId, spellcheck: 'false', autocapitalize: 'none' }),
    versionName: h('input', { class: 'input', id: 'default-version', type: 'text', value: settings.defaults.versionName, spellcheck: 'false' }),
    orientation: h('select', { class: 'input', id: 'default-orientation' }, ORIENTATIONS.map((value) => h('option', { value, selected: value === settings.defaults.orientation }, t(`orientation.${value}`)))),
    statusBarColor: h('input', { class: 'input', id: 'default-status', type: 'text', value: settings.defaults.statusBarColor, maxlength: '7', spellcheck: 'false' }),
    navigationBarColor: h('input', { class: 'input', id: 'default-navigation', type: 'text', value: settings.defaults.navigationBarColor, maxlength: '7', spellcheck: 'false' })
  };
  const defaultsError = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const saveDefaults = (event) => {
    event.preventDefault();
    const invalid = validatePackageId(defaultsForm.packageId.value)
      ? 'validation.packageId'
      : !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,29}$/.test(defaultsForm.versionName.value)
        ? 'validation.versionName'
        : !isHexColor(defaultsForm.statusBarColor.value) || !isHexColor(defaultsForm.navigationBarColor.value)
          ? 'validation.color'
          : null;
    defaultsError.hidden = !invalid;
    defaultsError.textContent = invalid ? t(invalid) : '';
    if (invalid) return;
    updateSettings({
      defaults: {
        packageId: defaultsForm.packageId.value,
        versionName: defaultsForm.versionName.value,
        orientation: defaultsForm.orientation.value,
        statusBarColor: defaultsForm.statusBarColor.value.toUpperCase(),
        navigationBarColor: defaultsForm.navigationBarColor.value.toUpperCase()
      }
    });
    toast(t('settings.saved'), 'success');
  };

  const apiBaseInput = h('input', { class: 'input', id: 'api-base', type: 'url', value: settings.apiBase, placeholder: 'https://api.example.com', spellcheck: 'false', autocomplete: 'off' });
  const apiKeyInput = h('input', { class: 'input', id: 'api-key', type: 'password', value: settings.apiKey, autocomplete: 'off', spellcheck: 'false' });
  const connectionError = h('p', { class: 'field-error', role: 'alert', hidden: true }, t('settings.apiBaseInvalid'));
  const saveConnection = (event) => {
    event.preventDefault();
    const base = normalizeApiBase(apiBaseInput.value);
    connectionError.hidden = base !== null;
    if (base === null) return;
    updateSettings({ apiBase: base, apiKey: apiKeyInput.value.trim() });
    toast(t('settings.saved'), 'success');
  };

  const maskedToken = `${settings.clientToken.slice(0, 6)}••••••••${settings.clientToken.slice(-4)}`;
  const tokenInput = h('input', { class: 'input', id: 'token-replacement', type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none' });
  const tokenError = h('p', { class: 'field-error', role: 'alert', hidden: true }, t('settings.tokenInvalid'));
  const applyToken = (event) => {
    event.preventDefault();
    const value = tokenInput.value.trim();
    tokenError.hidden = isValidToken(value);
    if (!isValidToken(value)) return;
    updateSettings({ clientToken: value });
    tokenInput.value = '';
    toast(t('settings.tokenApplied'), 'success');
    location.hash = '#/history';
  };

  const storage = h('div', { class: 'storage' }, h('p', { class: 'loading' }, t('common.loading')));
  Promise.all([api.config(), api.listBuilds({ limit: 1 })])
    .then(([config, builds]) => {
      if (!storage.isConnected) return;
      const used = builds.storageUsedBytes;
      const quota = config.limits.maxStorageBytesPerClient;
      storage.replaceChildren(
        h('dl', { class: 'facts' }, h('div', null, h('dt', null, t('settings.storageUsed')), h('dd', null, formatBytes(used, getLanguage()))), quota ? h('div', null, h('dt', null, t('settings.storageQuota')), h('dd', null, formatBytes(quota, getLanguage()))) : null),
        quota ? h('progress', { class: 'meter', max: quota, value: Math.min(used, quota), 'aria-label': t('settings.storage') }) : null,
        h('p', { class: 'field-hint' }, t('settings.retention', { hours: config.retentionHours })),
        h('p', { class: 'field-hint' }, t('settings.queueInfo', { queued: config.queue.maxQueued, workers: config.queue.concurrency }))
      );
    })
    .catch(() => {
      if (storage.isConnected) storage.replaceChildren(h('p', { class: 'field-hint' }, t('settings.storageError')));
    });

  main.append(
    h('h1', { class: 'page-title' }, t('settings.title')),
    h(
      'div',
      { class: 'settings' },
      section(t('settings.language'), field('language', t('settings.language'), languageSelect)),
      section(t('settings.theme'), themeGroup),
      section(
        t('settings.defaults'),
        h(
          'form',
          { class: 'settings-form', novalidate: true, onsubmit: saveDefaults },
          h('div', { class: 'grid-two' }, field('default-package', t('studio.packageId'), defaultsForm.packageId), field('default-version', t('studio.versionName'), defaultsForm.versionName), field('default-orientation', t('studio.orientation'), defaultsForm.orientation), h('div', { class: 'field' }), field('default-status', t('studio.statusBarColor'), defaultsForm.statusBarColor), field('default-navigation', t('studio.navigationBarColor'), defaultsForm.navigationBarColor)),
          defaultsError,
          h('button', { type: 'submit', class: 'button button-primary' }, t('settings.saveDefaults'))
        )
      ),
      section(
        t('settings.connection'),
        h(
          'form',
          { class: 'settings-form', novalidate: true, onsubmit: saveConnection },
          field('api-base', t('settings.apiBase'), apiBaseInput, t('settings.apiBaseHint'), connectionError),
          field('api-key', t('settings.apiKey'), apiKeyInput, t('settings.apiKeyHint')),
          h('button', { type: 'submit', class: 'button' }, t('settings.saveConnection'))
        )
      ),
      section(
        t('settings.token'),
        h('p', { class: 'field-hint' }, t('settings.tokenHint')),
        h('div', { class: 'token-row' }, h('code', { class: 'token' }, maskedToken), h('button', { type: 'button', class: 'button button-small', onclick: () => copyText(getSettings().clientToken).then(() => toast(t('common.copied'))) }, icon('copy', { size: 16 }), t('common.copy'))),
        h('form', { class: 'settings-form', novalidate: true, onsubmit: applyToken }, field('token-replacement', t('settings.tokenReplace'), tokenInput, null, tokenError), h('button', { type: 'submit', class: 'button' }, t('settings.tokenApply')))
      ),
      section(t('settings.storage'), storage)
    )
  );
}
