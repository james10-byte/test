document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const buildForm = document.getElementById('build-form');
  const appNameInput = document.getElementById('app-name');
  const packageNameInput = document.getElementById('package-name');
  const websiteUrlInput = document.getElementById('website-url');
  const formErrorAlert = document.getElementById('form-error');

  // Icon upload elements
  const iconDropzone = document.getElementById('icon-dropzone');
  const iconFileInput = document.getElementById('icon-file');
  const dropzoneDefault = document.getElementById('dropzone-default');
  const dropzonePreview = document.getElementById('dropzone-preview');
  const iconPreviewImg = document.getElementById('icon-preview-img');
  const previewFilename = document.getElementById('preview-filename');
  const removeIconBtn = document.getElementById('remove-icon-btn');

  // Colors
  const primaryColorInput = document.getElementById('primary-color');
  const primaryHex = document.getElementById('primary-hex');
  const statusbarColorInput = document.getElementById('statusbar-color');
  const statusbarHex = document.getElementById('statusbar-hex');
  const navbarColorInput = document.getElementById('navbar-color');
  const navbarHex = document.getElementById('navbar-hex');

  // Views
  const progressView = document.getElementById('progress-view');
  const successView = document.getElementById('success-view');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressPercent = document.getElementById('progress-percent');
  const currentStatusMsg = document.getElementById('current-status-message');
  const buildErrorAlert = document.getElementById('build-error-alert');
  const buildErrorMsg = document.getElementById('build-error-msg');
  const retryBtn = document.getElementById('retry-btn');

  // Success view elements
  const resultAppName = document.getElementById('result-app-name');
  const resultVersion = document.getElementById('result-version');
  const resultPackage = document.getElementById('result-package');
  const resultSize = document.getElementById('result-size');
  const downloadApkBtn = document.getElementById('download-apk-btn');
  const buildAnotherBtn = document.getElementById('build-another-btn');

  // Steps
  const steps = {
    validating: document.getElementById('step-validating'),
    preparing: document.getElementById('step-preparing'),
    configuring: document.getElementById('step-configuring'),
    icon: document.getElementById('step-icon'),
    permissions: document.getElementById('step-permissions'),
    building: document.getElementById('step-building'),
    signing: document.getElementById('step-signing'),
    verifying: document.getElementById('step-verifying')
  };

  let hasManuallyEditedPackage = false;
  let activePollInterval = null;

  // 1. Check environment on load
  checkEnvironment();

  // 2. Package Name Auto-slugifier
  appNameInput.addEventListener('input', (e) => {
    if (!hasManuallyEditedPackage) {
      const clean = e.target.value
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      const slug = clean ? (clean[0].match(/[a-z]/) ? clean : 'app' + clean) : 'mywebsite';
      packageNameInput.value = `com.webtoapk.${slug}`;
    }
  });

  packageNameInput.addEventListener('input', () => {
    hasManuallyEditedPackage = true;
  });

  // 3. Color hex label updates
  function setupColorPicker(input, label) {
    input.addEventListener('input', (e) => {
      label.textContent = e.target.value.toUpperCase();
    });
  }
  setupColorPicker(primaryColorInput, primaryHex);
  setupColorPicker(statusbarColorInput, statusbarHex);
  setupColorPicker(navbarColorInput, navbarHex);

  // 4. Icon Upload & Preview Handling
  iconDropzone.addEventListener('click', (e) => {
    if (e.target !== removeIconBtn) {
      iconFileInput.click();
    }
  });

  iconDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    iconDropzone.classList.add('dragover');
  });

  iconDropzone.addEventListener('dragleave', () => {
    iconDropzone.classList.remove('dragover');
  });

  iconDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    iconDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleSelectedIcon(e.dataTransfer.files[0]);
    }
  });

  iconFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleSelectedIcon(e.target.files[0]);
    }
  });

  function handleSelectedIcon(file) {
    if (!file.type.startsWith('image/')) {
      showFormError('Please select a valid image file (PNG, JPEG, or WebP).');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      iconPreviewImg.src = e.target.result;
      previewFilename.textContent = file.name;
      dropzoneDefault.classList.add('visually-hidden');
      dropzonePreview.classList.remove('visually-hidden');
    };
    reader.readAsDataURL(file);
  }

  removeIconBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    iconFileInput.value = '';
    iconPreviewImg.src = '';
    dropzonePreview.classList.add('visually-hidden');
    dropzoneDefault.classList.remove('visually-hidden');
  });

  // 5. Form Submission
  buildForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideFormError();

    // Client-side quick check
    let url = websiteUrlInput.value.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
      websiteUrlInput.value = url;
    }

    const appName = appNameInput.value.trim();
    const packageName = packageNameInput.value.trim();

    if (!appName || !packageName) {
      showFormError('Please fill in all required fields.');
      return;
    }

    const formData = new FormData(buildForm);

    // Explicitly gather all checked permissions (including locked/disabled ones)
    const checkedPerms = Array.from(buildForm.querySelectorAll('input[name="permissions"]:checked')).map(cb => cb.value);
    if (!checkedPerms.includes('internet')) {
      checkedPerms.unshift('internet');
    }
    formData.delete('permissions');
    checkedPerms.forEach(p => formData.append('permissions', p));

    // Add unchecked checkboxes as false if needed
    const webviewChecks = ['javascript', 'dom_storage', 'file_upload', 'downloads', 'fullscreen', 'back_navigation'];
    webviewChecks.forEach(feature => {
      const el = buildForm.querySelector(`[name="${feature}"]`);
      if (el) {
        formData.set(feature, el.checked ? 'true' : 'false');
      }
    });

    // Disable submit button
    const buildBtn = document.getElementById('build-btn');
    buildBtn.disabled = true;

    try {
      const response = await fetch('/api/build', {
        method: 'POST',
        body: formData,
        credentials: 'same-origin'
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.details ? data.details.join(' ') : (data.error || 'Failed to start build');
        showFormError(msg);
        buildBtn.disabled = false;
        return;
      }

      // Store in sessionStorage (strictly tab/session isolated, no cross-user leakage)
      sessionStorage.setItem('current_build_id', data.build_id);
      sessionStorage.setItem('current_build_token', data.build_token);

      // Transition to progress view
      showProgressView();
      startPolling(data.build_id, data.build_token);

    } catch (err) {
      showFormError('Unable to connect to builder server. Please check your connection.');
      buildBtn.disabled = false;
    }
  });

  // 6. Polling & Progress Display
  function startPolling(buildId, buildToken) {
    if (activePollInterval) clearInterval(activePollInterval);

    // Initial state
    updateStep('validating', 'active');

    const tokenQuery = buildToken ? `?token=${encodeURIComponent(buildToken)}` : '';

    activePollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${buildId}${tokenQuery}`, {
          credentials: 'same-origin'
        });
        if (!res.ok) {
          if (res.status === 404) {
            clearInterval(activePollInterval);
            showBuildError('Build not found or access denied. Your session may have expired.');
          }
          return;
        }

        const data = await res.json();
        renderProgress(data);

        if (data.status === 'completed') {
          clearInterval(activePollInterval);
          setTimeout(() => showSuccessView(data), 600);
        } else if (data.status === 'failed') {
          clearInterval(activePollInterval);
          showBuildError(data.error || data.message || 'Build failed.');
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1000);
  }

  function renderProgress(data) {
    const progress = Math.max(5, Math.min(100, data.progress || 0));
    progressBarFill.style.width = `${progress}%`;
    progressPercent.textContent = `${progress}%`;
    currentStatusMsg.textContent = data.message || 'Processing...';

    // Step state orchestration
    if (data.status === 'queued') {
      currentStatusMsg.textContent = data.message || 'Waiting in build queue...';
    } else {
      if (progress >= 15) {
        updateStep('validating', 'done');
        updateStep('preparing', 'active');
      }
      if (progress >= 30) {
        updateStep('preparing', 'done');
        updateStep('configuring', 'active');
      }
      if (progress >= 45) {
        updateStep('configuring', 'done');
        updateStep('icon', 'done');
        updateStep('permissions', 'done');
        updateStep('building', 'active');
      }
      if (progress >= 85 || data.step === 'signing') {
        updateStep('building', 'done');
        updateStep('signing', 'active');
      }
      if (progress >= 92 || data.step === 'verifying') {
        updateStep('signing', 'done');
        updateStep('verifying', 'active');
      }
      if (progress >= 100 && data.status === 'completed') {
        updateStep('building', 'done');
        updateStep('signing', 'done');
        updateStep('verifying', 'done');
      }
    }
  }

  function updateStep(stepName, state) {
    const el = steps[stepName];
    if (!el) return;

    if (state === 'active') {
      el.classList.add('active');
      el.classList.remove('done');
    } else if (state === 'done') {
      el.classList.remove('active');
      el.classList.add('done');
    } else {
      el.classList.remove('active', 'done');
    }
  }

  function showProgressView() {
    buildForm.classList.add('visually-hidden');
    successView.classList.add('visually-hidden');
    progressView.classList.remove('visually-hidden');
    buildErrorAlert.classList.add('visually-hidden');

    progressBarFill.style.width = '5%';
    progressPercent.textContent = '5%';
    currentStatusMsg.textContent = 'Validating website...';

    Object.keys(steps).forEach(s => updateStep(s, ''));
  }

  function showSuccessView(data) {
    progressView.classList.add('visually-hidden');
    successView.classList.remove('visually-hidden');

    resultAppName.textContent = data.app_name || 'My Website';
    resultVersion.textContent = `Version ${data.version_name || '1.0.0'}`;
    resultPackage.textContent = data.package_name || '';
    resultSize.textContent = `${data.apk_size_mb || 0} MB`;

    downloadApkBtn.href = data.download_url;
    downloadApkBtn.setAttribute('download', data.apk_filename || 'app.apk');
  }

  function showBuildError(msg) {
    buildErrorMsg.textContent = msg;
    buildErrorAlert.classList.remove('visually-hidden');
  }

  retryBtn.addEventListener('click', () => {
    resetToFormView();
  });

  buildAnotherBtn.addEventListener('click', () => {
    resetToFormView();
  });

  function resetToFormView() {
    if (activePollInterval) clearInterval(activePollInterval);
    sessionStorage.removeItem('current_build_id');
    sessionStorage.removeItem('current_build_token');
    progressView.classList.add('visually-hidden');
    successView.classList.add('visually-hidden');
    buildForm.classList.remove('visually-hidden');
    document.getElementById('build-btn').disabled = false;
    hideFormError();
  }

  function showFormError(msg) {
    formErrorAlert.textContent = msg;
    formErrorAlert.classList.remove('visually-hidden');
    formErrorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hideFormError() {
    formErrorAlert.classList.add('visually-hidden');
    formErrorAlert.textContent = '';
  }

  // 7. Check server environment info
  async function checkEnvironment() {
    const badge = document.getElementById('env-badge');
    const text = document.getElementById('env-text');
    try {
      const res = await fetch('/api/info', { credentials: 'same-origin' });
      if (res.ok) {
        const info = await res.json();
        if (info.is_configured) {
          badge.classList.add('ready');
          text.textContent = 'JDK & SDK Ready';
        } else {
          text.textContent = 'Environment check warning';
        }
      } else {
        text.textContent = 'Offline';
      }
    } catch (e) {
      text.textContent = 'Offline';
    }
  }

  // 8. Auto-resume existing build for this user session if page is reloaded
  async function checkAndResumeBuild() {
    const savedBuildId = sessionStorage.getItem('current_build_id');
    const savedBuildToken = sessionStorage.getItem('current_build_token');
    if (!savedBuildId || !savedBuildToken) return;

    try {
      const res = await fetch(`/api/status/${savedBuildId}?token=${encodeURIComponent(savedBuildToken)}`, {
        credentials: 'same-origin'
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'completed') {
          showSuccessView(data);
        } else if (data.status === 'failed') {
          showProgressView();
          showBuildError(data.error || data.message || 'Build failed.');
        } else {
          showProgressView();
          renderProgress(data);
          startPolling(savedBuildId, savedBuildToken);
        }
      } else {
        sessionStorage.removeItem('current_build_id');
        sessionStorage.removeItem('current_build_token');
      }
    } catch (e) {
      // Ignore network errors on initial check
    }
  }

  checkAndResumeBuild();
});

/* ============================================================
 * BUILD SUMMARY PANEL — purely visual live-sync of form state
 * ------------------------------------------------------------
 * This module is ADDITIVE: it does not modify any existing
 * function, listener, or API call. It only:
 *   1. Mirrors form values into the right-hand summary panel
 *   2. Hides the summary panel whenever the form view is hidden
 *      (i.e. during progress / success / error views), so the
 *      workspace naturally collapses to a single column.
 * ============================================================ */
(function setupSummaryPanel() {
  function init() {
    const buildForm = document.getElementById('build-form');
    const summaryPanel = document.getElementById('summary-panel');
    if (!buildForm || !summaryPanel) return;

    const refs = {
      website: document.getElementById('website-url'),
      appName: document.getElementById('app-name'),
      packageName: document.getElementById('package-name'),
      versionName: document.getElementById('version-name'),
      versionCode: document.getElementById('version-code'),
      dropzonePreview: document.getElementById('dropzone-preview'),
      previewFilename: document.getElementById('preview-filename'),
      sumWebsite: document.getElementById('sum-website'),
      sumAppName: document.getElementById('sum-app-name'),
      sumPackage: document.getElementById('sum-package'),
      sumVersion: document.getElementById('sum-version'),
      sumIcon: document.getElementById('sum-icon'),
      sumPermissions: document.getElementById('sum-permissions'),
      sumWebview: document.getElementById('sum-webview'),
      sumLinks: document.getElementById('sum-external-links')
    };

    // Guard — if the summary panel markup was removed, no-op gracefully
    const hasAllRefs = Object.values(refs).every(Boolean);
    if (!hasAllRefs) return;

    const PERMISSION_LABELS = {
      internet: 'Internet',
      camera: 'Camera',
      microphone: 'Microphone',
      location: 'Location',
      notifications: 'Notifications',
      bluetooth: 'Bluetooth',
      photos_videos: 'Photos & Videos'
    };
    const WEBVIEW_LABELS = {
      javascript: 'JavaScript',
      dom_storage: 'DOM Storage',
      file_upload: 'File Upload',
      downloads: 'Downloads',
      fullscreen: 'Fullscreen',
      back_navigation: 'Back Navigation'
    };

    function truncate(str, n) {
      if (!str) return '';
      return str.length > n ? str.slice(0, n - 1) + '\u2026' : str;
    }

    function syncSummary() {
      // Basic fields
      refs.sumWebsite.textContent = truncate(refs.website.value.trim(), 38) || '\u2014';
      refs.sumAppName.textContent = truncate(refs.appName.value.trim(), 26) || '\u2014';
      refs.sumPackage.textContent = truncate(refs.packageName.value.trim(), 34) || '\u2014';

      const vn = refs.versionName.value.trim();
      const vc = refs.versionCode.value.trim();
      refs.sumVersion.textContent = vn ? (vn + ' / code ' + (vc || '1')) : '\u2014';

      // Icon — derive from dropzone preview visibility (robust against
      // the placeholder "icon.png" being present by default)
      const hasIcon = refs.dropzonePreview &&
        !refs.dropzonePreview.classList.contains('visually-hidden');
      refs.sumIcon.textContent = hasIcon
        ? truncate(refs.previewFilename.textContent, 22)
        : 'Default (icon.png)';

      // Permissions
      const perms = Array.from(
        buildForm.querySelectorAll('input[name="permissions"]:checked')
      ).map(cb => PERMISSION_LABELS[cb.value] || cb.value);
      refs.sumPermissions.textContent = perms.length ? perms.join(', ') : '\u2014';

      // WebView features
      const webview = [];
      Object.keys(WEBVIEW_LABELS).forEach(name => {
        const el = buildForm.querySelector('input[name="' + name + '"]');
        if (el && el.checked) webview.push(WEBVIEW_LABELS[name]);
      });
      refs.sumWebview.textContent = webview.length ? webview.join(', ') : 'None';

      // External links radio
      const linksRadio = buildForm.querySelector('input[name="external_links"]:checked');
      if (linksRadio) {
        refs.sumLinks.textContent = linksRadio.value === 'browser' ? 'Browser' : 'Inside App';
      }
    }

    // Initial sync (after DOM is fully parsed and default values applied)
    syncSummary();

    // Listen to any input / change inside the form
    buildForm.addEventListener('input', syncSummary);
    buildForm.addEventListener('change', syncSummary);

    // Hide summary panel whenever the form itself is hidden
    // (progress view / success view). Use a MutationObserver so we
    // don't need to touch the existing view-toggle code in app.js.
    function syncSummaryVisibility() {
      if (buildForm.classList.contains('visually-hidden')) {
        summaryPanel.classList.add('visually-hidden');
      } else {
        summaryPanel.classList.remove('visually-hidden');
      }
    }
    syncSummaryVisibility();
    const observer = new MutationObserver(syncSummaryVisibility);
    observer.observe(buildForm, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
