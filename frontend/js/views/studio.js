import { formatBytes } from '../format.js';
import { getLanguage, t } from '../i18n.js';
import { routeHash } from '../router.js';
import { buildConfigPayload, isHexColor, validateAppForm } from '../validation.js';
import { errorMessage, h, icon } from '../ui.js';

const PREVIEW_DELAY_MS = 300;
const PREVIEW_NAMES = ['square', 'rounded', 'round', 'adaptive', 'transparency'];
const ORIENTATIONS = ['unspecified', 'portrait', 'landscape', 'sensor'];
const SOURCE_TYPES = ['html', 'zip', 'url'];
const RECOMMENDED_ICON = Object.freeze({
  transparent: true,
  background: '#0B1020',
  adaptiveBackground: '#FFFFFF',
  scale: 1,
  padding: 0.1,
  offsetX: 0,
  offsetY: 0,
  fit: 'contain'
});
const FIELD_ORDER = ['source', 'appName', 'packageId', 'versionName', 'versionCode', 'iconFile', 'statusBarColor', 'navigationBarColor'];
const SLIDERS = [
  { key: 'scale', min: 0.1, max: 1, step: 0.01, label: 'icon.scale' },
  { key: 'padding', min: 0, max: 0.4, step: 0.01, label: 'icon.padding' },
  { key: 'offsetX', min: -0.5, max: 0.5, step: 0.01, label: 'icon.offsetX' },
  { key: 'offsetY', min: -0.5, max: 0.5, step: 0.01, label: 'icon.offsetY' }
];

export function renderStudio(main, { api, getSettings }) {
  const defaults = getSettings().defaults;
  const form = {
    inputType: 'html',
    file: null,
    url: '',
    appName: '',
    packageId: defaults.packageId,
    versionName: defaults.versionName,
    versionCode: '1',
    orientation: defaults.orientation,
    statusBarColor: defaults.statusBarColor,
    navigationBarColor: defaults.navigationBarColor,
    iconFile: null,
    icon: { ...RECOMMENDED_ICON }
  };
  let limits = null;
  let attempted = false;
  let submitting = false;
  let destroyed = false;
  let previewTimer = null;
  let previewController = null;
  let previewResult = null;
  let previewError = null;
  let previewLoading = false;
  let originalAddress = null;
  const registry = new Map();
  const sliderRefs = new Map();
  const iconRefs = {};

  const formatLimit = (bytes) => formatBytes(bytes, getLanguage());

  const registerField = (name, { id, label, hint, control, extra }) => {
    const hintId = hint ? `${id}-hint` : null;
    const errorId = `${id}-error`;
    const errorNode = h('p', { class: 'field-error', id: errorId, hidden: true });
    registry.set(name, { control, errorNode, focus: control });
    const target = control.matches('input, select, textarea') ? control : control.querySelector('input[type="text"], select');
    if (target) {
      target.id = target.id || id;
      target.setAttribute('aria-describedby', [hintId, errorId].filter(Boolean).join(' '));
      registry.get(name).focus = target;
    }
    return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control, extra ?? null, hint ? h('p', { class: 'field-hint', id: hintId }, hint) : null, errorNode);
  };

  const showError = (name, error) => {
    const entry = registry.get(name);
    if (!entry) return;
    entry.errorNode.hidden = !error;
    entry.errorNode.textContent = error ? t(error.key, error.parameters) : '';
    const target = entry.focus;
    if (target) {
      if (error) target.setAttribute('aria-invalid', 'true');
      else target.removeAttribute('aria-invalid');
    }
  };

  const collectErrors = () => {
    const errors = validateAppForm(form);
    if (limits && form.file && !errors.source) {
      const limit = form.inputType === 'html' ? limits.maxHtmlBytes : limits.maxUploadBytes;
      if (form.file.size > limit) errors.source = { key: 'validation.fileTooLarge', parameters: { limit: formatLimit(limit) } };
    }
    return errors;
  };

  const applyErrors = (errors) => {
    for (const name of FIELD_ORDER) if (name !== 'iconFile') showError(name, errors[name]);
    const iconError = limits && form.iconFile && form.iconFile.size > limits.maxImageBytes ? { key: 'validation.imageTooLarge', parameters: { limit: formatLimit(limits.maxImageBytes) } } : null;
    showError('iconFile', iconError);
    return { ...errors, ...(iconError ? { iconFile: iconError } : {}) };
  };

  const revalidate = () => {
    if (attempted) applyErrors(collectErrors());
  };

  const textInput = (name, attributes = {}) => {
    const input = h('input', { type: 'text', class: 'input', value: form[name], autocomplete: 'off', ...attributes });
    input.addEventListener('input', () => {
      form[name] = input.value;
      if (name === 'appName') renderPreview();
      revalidate();
    });
    return input;
  };

  const colorPair = (name) => {
    const picker = h('input', { type: 'color', class: 'color-input', value: isHexColor(form[name]) ? form[name].toLowerCase() : '#000000', 'aria-hidden': 'true', tabindex: '-1' });
    const text = h('input', { type: 'text', class: 'input input-color', value: form[name], maxlength: '7', spellcheck: 'false', autocomplete: 'off' });
    picker.addEventListener('input', () => {
      form[name] = picker.value.toUpperCase();
      text.value = form[name];
      revalidate();
    });
    text.addEventListener('input', () => {
      form[name] = text.value;
      if (isHexColor(text.value)) picker.value = text.value.toLowerCase();
      revalidate();
    });
    picker.setAttribute('aria-label', t(`studio.${name}`));
    picker.removeAttribute('aria-hidden');
    picker.removeAttribute('tabindex');
    return { wrapper: h('div', { class: 'color-pair' }, picker, text), text };
  };

  const sourcePanel = h('div', { class: 'source-panel' });
  const fileInput = h('input', { type: 'file', class: 'visually-hidden', id: 'source-file' });

  const acceptFor = (type) => (type === 'html' ? '.html,.htm,text/html' : '.zip,application/zip');

  const setFile = (file) => {
    form.file = file ?? null;
    drawSource();
    revalidate();
  };

  function drawSource() {
    sourcePanel.replaceChildren();
    const sourceError = h('p', { class: 'field-error', id: 'source-error', hidden: true });
    registry.set('source', { control: sourcePanel, errorNode: sourceError, focus: null });
    if (form.inputType === 'url') {
      const input = h('input', { type: 'url', class: 'input', id: 'source-url', value: form.url, placeholder: 'https://example.com', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'source-hint source-error' });
      input.addEventListener('input', () => {
        form.url = input.value;
        revalidate();
      });
      registry.get('source').focus = input;
      sourcePanel.append(h('label', { class: 'field-label', for: 'source-url' }, t('studio.urlLabel')), input, h('p', { class: 'field-hint', id: 'source-hint' }, t('studio.urlHint')), sourceError);
      return;
    }
    fileInput.value = '';
    fileInput.setAttribute('accept', acceptFor(form.inputType));
    fileInput.setAttribute('aria-describedby', 'source-hint source-error');
    registry.get('source').focus = fileInput;
    const zone = h('label', { class: 'dropzone', for: 'source-file' }, icon('upload', { size: 24 }), h('span', { class: 'dropzone-title' }, form.inputType === 'html' ? t('studio.chooseHtml') : t('studio.chooseZip')), h('span', { class: 'dropzone-hint' }, t('studio.dropHint')));
    for (const eventName of ['dragenter', 'dragover']) {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        zone.classList.add('dropzone-active');
      });
    }
    for (const eventName of ['dragleave', 'drop']) zone.addEventListener(eventName, () => zone.classList.remove('dropzone-active'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      const [file] = event.dataTransfer?.files ?? [];
      if (file) setFile(file);
    });
    const chosen = form.file
      ? h('div', { class: 'file-row' }, icon('file', { size: 18 }), h('span', { class: 'file-name' }, form.file.name), h('span', { class: 'file-size' }, formatLimit(form.file.size)), h('button', { type: 'button', class: 'icon-button', 'aria-label': t('studio.remove'), onclick: () => setFile(null) }, icon('x', { size: 18 })))
      : null;
    sourcePanel.append(fileInput, zone, chosen, h('p', { class: 'field-hint', id: 'source-hint' }, form.inputType === 'html' ? t('studio.htmlHint') : t('studio.zipHint')), sourceError);
  }

  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    if (file) setFile(file);
  });

  const segmented = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': t('studio.source') },
    SOURCE_TYPES.map((type) => {
      const input = h('input', { type: 'radio', name: 'input-type', value: type, id: `type-${type}`, class: 'segment-input', checked: type === form.inputType });
      input.addEventListener('change', () => {
        form.inputType = type;
        form.file = null;
        drawSource();
        revalidate();
      });
      return h('label', { class: 'segment', for: `type-${type}` }, input, h('span', null, t(`input.${type}`)));
    })
  );

  const appNameInput = textInput('appName', { maxlength: '30', required: true });
  const packageInput = textInput('packageId', { spellcheck: 'false', autocapitalize: 'none', maxlength: '100' });
  const versionNameInput = textInput('versionName', { maxlength: '30', spellcheck: 'false' });
  const versionCodeInput = textInput('versionCode', { inputmode: 'numeric', maxlength: '10' });
  const orientationSelect = h('select', { class: 'input' }, ORIENTATIONS.map((value) => h('option', { value, selected: value === form.orientation }, t(`orientation.${value}`))));
  orientationSelect.addEventListener('change', () => {
    form.orientation = orientationSelect.value;
  });
  const statusColor = colorPair('statusBarColor');
  const navigationColor = colorPair('navigationBarColor');

  const iconFileInput = h('input', { type: 'file', class: 'visually-hidden', id: 'icon-file', accept: 'image/png,image/jpeg,image/webp' });
  const iconFileName = h('span', { class: 'file-name' }, t('icon.defaultNote'));
  const iconError = h('p', { class: 'field-error', id: 'icon-error', hidden: true });
  registry.set('iconFile', { control: iconFileInput, errorNode: iconError, focus: iconFileInput });
  iconFileInput.setAttribute('aria-describedby', 'icon-hint icon-error');
  iconFileInput.addEventListener('change', () => {
    const [file] = iconFileInput.files;
    form.iconFile = file ?? null;
    if (originalAddress) URL.revokeObjectURL(originalAddress);
    originalAddress = file ? URL.createObjectURL(file) : null;
    iconFileName.textContent = file ? `${file.name} · ${formatLimit(file.size)}` : t('icon.defaultNote');
    previewResult = null;
    previewError = null;
    schedulePreview();
    revalidate();
  });

  const iconPayload = () => ({
    background: form.icon.transparent ? 'transparent' : form.icon.background.toUpperCase(),
    adaptiveBackground: form.icon.adaptiveBackground.toUpperCase(),
    scale: Number(form.icon.scale),
    padding: Number(form.icon.padding),
    offsetX: Number(form.icon.offsetX),
    offsetY: Number(form.icon.offsetY),
    fit: form.icon.fit
  });

  const transparentBox = h('input', { type: 'checkbox', id: 'icon-transparent', checked: form.icon.transparent });
  const backgroundPicker = h('input', { type: 'color', class: 'color-input', id: 'icon-background', value: form.icon.background.toLowerCase(), 'aria-label': t('icon.background') });
  const adaptivePicker = h('input', { type: 'color', class: 'color-input', id: 'icon-adaptive', value: form.icon.adaptiveBackground.toLowerCase(), 'aria-label': t('icon.adaptiveBackground') });
  const fitSelect = h('select', { class: 'input', id: 'icon-fit' }, [h('option', { value: 'contain' }, t('icon.fitContain')), h('option', { value: 'cover' }, t('icon.fitCover'))]);
  Object.assign(iconRefs, { transparentBox, backgroundPicker, adaptivePicker, fitSelect });

  transparentBox.addEventListener('change', () => {
    form.icon.transparent = transparentBox.checked;
    backgroundPicker.disabled = transparentBox.checked;
    schedulePreview();
  });
  backgroundPicker.addEventListener('input', () => {
    form.icon.background = backgroundPicker.value.toUpperCase();
    schedulePreview();
  });
  adaptivePicker.addEventListener('input', () => {
    form.icon.adaptiveBackground = adaptivePicker.value.toUpperCase();
    schedulePreview();
  });
  fitSelect.addEventListener('change', () => {
    form.icon.fit = fitSelect.value;
    schedulePreview();
  });

  const sliderRow = ({ key, min, max, step, label }) => {
    const output = h('output', { class: 'slider-value', for: `icon-${key}` }, String(form.icon[key]));
    const input = h('input', { type: 'range', id: `icon-${key}`, class: 'slider', min, max, step, value: form.icon[key] });
    input.addEventListener('input', () => {
      form.icon[key] = Number(input.value);
      output.textContent = Number(input.value).toFixed(2);
      schedulePreview();
    });
    sliderRefs.set(key, { input, output });
    return h('div', { class: 'slider-row' }, h('label', { class: 'field-label', for: `icon-${key}` }, t(label)), input, output);
  };

  const syncIconControls = () => {
    transparentBox.checked = form.icon.transparent;
    backgroundPicker.value = form.icon.background.toLowerCase();
    backgroundPicker.disabled = form.icon.transparent;
    adaptivePicker.value = form.icon.adaptiveBackground.toLowerCase();
    fitSelect.value = form.icon.fit;
    for (const [key, { input, output }] of sliderRefs) {
      input.value = form.icon[key];
      output.textContent = Number(form.icon[key]).toFixed(2);
    }
  };

  backgroundPicker.disabled = form.icon.transparent;
  const sliders = SLIDERS.map(sliderRow);
  const resetButton = h('button', { type: 'button', class: 'button button-small', onclick: () => {
    form.icon = { ...RECOMMENDED_ICON };
    syncIconControls();
    schedulePreview();
  } }, icon('refresh', { size: 16 }), t('icon.reset'));

  const previewPanel = h('aside', { class: 'preview', 'aria-labelledby': 'preview-title' });

  function renderPreview() {
    previewPanel.replaceChildren(h('h2', { class: 'section-title', id: 'preview-title' }, t('preview.title')));
    if (!form.iconFile) {
      previewPanel.append(h('p', { class: 'prose' }, t('preview.empty')));
      return;
    }
    if (previewError) previewPanel.append(h('div', { class: 'notice notice-danger', role: 'alert' }, icon('alert'), h('p', null, t('preview.error', { message: previewError }))));
    if (previewLoading) previewPanel.append(h('p', { class: 'loading', role: 'status' }, t('preview.loading')));
    if (!previewResult) return;
    const name = form.appName.trim() || t('studio.app');
    previewPanel.append(
      h(
        'div',
        { class: 'home-screen' },
        h('div', { class: 'home-icon' }, h('img', { src: previewResult.rounded, alt: '', width: 64, height: 64 }), h('span', { class: 'home-label' }, name)),
        h('p', { class: 'home-caption' }, t('preview.launcher'))
      ),
      h(
        'ul',
        { class: 'preview-grid' },
        h('li', null, h('img', { src: originalAddress, alt: t('preview.original'), class: 'preview-image' }), h('span', null, t('preview.original'))),
        PREVIEW_NAMES.map((key) => h('li', null, h('img', { src: previewResult[key], alt: t(`preview.${key}`), class: `preview-image preview-${key}` }), h('span', null, t(`preview.${key}`))))
      )
    );
  }

  async function runPreview() {
    if (destroyed || !form.iconFile) return;
    if (previewController) previewController.abort();
    previewController = new AbortController();
    previewLoading = true;
    renderPreview();
    try {
      const result = await api.previewIcon(form.iconFile, iconPayload(), previewController.signal);
      previewResult = result.previews;
      previewError = null;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      previewResult = null;
      previewError = errorMessage(error);
    }
    previewLoading = false;
    if (!destroyed) renderPreview();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    if (!form.iconFile) {
      previewResult = null;
      renderPreview();
      return;
    }
    previewLoading = true;
    renderPreview();
    previewTimer = setTimeout(runPreview, PREVIEW_DELAY_MS);
  }

  const summary = h('div', { class: 'notice notice-danger', role: 'alert', hidden: true });
  const submitButton = h('button', { type: 'submit', class: 'button button-primary button-large' }, icon('studio', { size: 18 }), t('studio.build'));

  const showSummary = (message, candidates) => {
    summary.hidden = !message;
    summary.replaceChildren();
    if (!message) return;
    summary.append(icon('alert'), h('div', { class: 'notice-body' }, h('p', null, message), candidates ? h('p', null, t('studio.candidates', { items: candidates.join(', ') })) : null));
    summary.scrollIntoView({ block: 'nearest' });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    attempted = true;
    const errors = applyErrors(collectErrors());
    const firstInvalid = FIELD_ORDER.find((name) => errors[name]);
    if (firstInvalid) {
      showSummary(t('studio.formError'));
      registry.get(firstInvalid)?.focus?.focus();
      return;
    }
    showSummary(null);
    submitting = true;
    submitButton.disabled = true;
    submitButton.replaceChildren(t('studio.building'));
    try {
      const data = new FormData();
      data.append('config', JSON.stringify(buildConfigPayload({ ...form, icon: iconPayload() })));
      if (form.inputType !== 'url') data.append('source', form.file, form.file.name);
      if (form.iconFile) data.append('icon', form.iconFile, form.iconFile.name);
      const { build } = await api.createBuild(data);
      location.hash = routeHash('monitor', { id: build.id });
    } catch (error) {
      showSummary(t('studio.submitError', { message: errorMessage(error) }), error?.details?.candidates);
      submitting = false;
      submitButton.disabled = false;
      submitButton.replaceChildren(icon('studio', { size: 18 }), t('studio.build'));
    }
  };

  const sourceSection = h('fieldset', { class: 'group' }, h('legend', { class: 'group-title' }, t('studio.source')), segmented, sourcePanel);
  const appSection = h(
    'fieldset',
    { class: 'group' },
    h('legend', { class: 'group-title' }, t('studio.app')),
    h(
      'div',
      { class: 'grid-two' },
      registerField('appName', { id: 'app-name', label: t('studio.appName'), control: appNameInput }),
      registerField('packageId', { id: 'package-id', label: t('studio.packageId'), control: packageInput }),
      registerField('versionName', { id: 'version-name', label: t('studio.versionName'), control: versionNameInput }),
      registerField('versionCode', { id: 'version-code', label: t('studio.versionCode'), control: versionCodeInput }),
      registerField('orientation', { id: 'orientation', label: t('studio.orientation'), control: orientationSelect }),
      h('div', { class: 'field' })
    )
  );
  const iconSection = h(
    'fieldset',
    { class: 'group' },
    h('legend', { class: 'group-title' }, t('studio.icon')),
    h('div', { class: 'icon-picker' }, h('label', { class: 'button', for: 'icon-file' }, icon('upload', { size: 18 }), t('icon.choose')), iconFileInput, iconFileName),
    h('p', { class: 'field-hint', id: 'icon-hint' }, t('icon.hint')),
    iconError,
    h(
      'div',
      { class: 'icon-controls' },
      h('div', { class: 'check-row' }, transparentBox, h('label', { for: 'icon-transparent' }, t('icon.transparent'))),
      h('div', { class: 'inline-field' }, h('label', { class: 'field-label', for: 'icon-background' }, t('icon.background')), backgroundPicker),
      h('div', { class: 'inline-field' }, h('label', { class: 'field-label', for: 'icon-adaptive' }, t('icon.adaptiveBackground')), adaptivePicker),
      sliders,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'icon-fit' }, t('icon.fit')), fitSelect),
      resetButton
    )
  );
  const androidSection = h(
    'fieldset',
    { class: 'group' },
    h('legend', { class: 'group-title' }, t('studio.android')),
    h(
      'div',
      { class: 'grid-two' },
      registerField('statusBarColor', { id: 'status-color', label: t('studio.statusBarColor'), control: statusColor.wrapper }),
      registerField('navigationBarColor', { id: 'navigation-color', label: t('studio.navigationBarColor'), control: navigationColor.wrapper })
    ),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'signing' }, t('studio.signing')), h('select', { class: 'input', id: 'signing' }, h('option', { value: 'debug' }, t('signing.debug'))), h('p', { class: 'field-hint' }, t('studio.signingNote')))
  );

  const formElement = h('form', { class: 'studio-form', novalidate: true, onsubmit: submit }, summary, sourceSection, appSection, iconSection, androidSection, h('div', { class: 'form-actions' }, submitButton));

  main.append(h('h1', { class: 'page-title' }, t('studio.title')), h('div', { class: 'studio' }, formElement, previewPanel));
  drawSource();
  renderPreview();

  api.config().then((config) => {
    if (!destroyed) limits = config.limits;
  }).catch(() => {});

  return () => {
    destroyed = true;
    clearTimeout(previewTimer);
    if (previewController) previewController.abort();
    if (originalAddress) URL.revokeObjectURL(originalAddress);
  };
}
