import { formatBytes, formatDate, formatDuration, isActiveState, isExpired } from '../format.js';
import { sha256Hex } from '../hash.js';
import { getLanguage, t } from '../i18n.js';
import { confirmDialog, copyText, emptyState, errorMessage, errorState, h, icon, loadingState, saveBlob, stateBadge, toast } from '../ui.js';

const STAGES = ['queued', 'preparing', 'compiling', 'validating', 'completed'];
const MAXIMUM_LOG_NODES = 2000;
const MAXIMUM_RECONNECT_DELAY_MS = 10000;
const STICK_TO_BOTTOM_PX = 40;

const sleep = (milliseconds, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

function renderActiveList(main, { api }) {
  const body = h('div', { class: 'page-body' });
  main.append(h('h1', { class: 'page-title' }, t('monitor.title')), body);
  let destroyed = false;
  let timer = null;
  const load = async (initial) => {
    if (initial) body.replaceChildren(loadingState());
    try {
      const { builds } = await api.listBuilds({ limit: 50 });
      if (destroyed) return;
      const active = builds.filter((build) => isActiveState(build.state));
      if (active.length === 0) {
        body.replaceChildren(emptyState({ title: t('monitor.empty'), body: t('monitor.emptyBody'), action: h('a', { class: 'button button-primary', href: '#/studio' }, t('dashboard.create')) }));
      } else {
        body.replaceChildren(
          h('h2', { class: 'section-title' }, t('monitor.active')),
          h('ul', { class: 'activity' }, active.map((build) => h('li', { class: 'activity-row' }, h('a', { class: 'activity-link', href: `#/monitor/${build.id}` }, h('span', { class: 'activity-name' }, build.appName), h('span', { class: 'activity-meta' }, formatDate(build.createdAt, getLanguage()))), stateBadge(build.state))))
        );
      }
      timer = setTimeout(() => load(false), 4000);
    } catch (error) {
      if (!destroyed) body.replaceChildren(errorState(t('common.error', { message: errorMessage(error) }), () => load(true)));
    }
  };
  load(true);
  return () => {
    destroyed = true;
    clearTimeout(timer);
  };
}

function renderBuild(main, { api }, id) {
  const root = h('div', { class: 'monitor' });
  main.append(root);
  root.append(loadingState());
  const controller = new AbortController();
  let destroyed = false;
  let build = null;
  let lastSequence = 0;
  let logNodes = 0;
  let reconnecting = false;
  let elapsedTimer = null;
  const refs = {};

  const isTerminal = () => build && !isActiveState(build.state);

  const download = async () => {
    refs.downloadButton.disabled = true;
    try {
      const result = await api.downloadBuild(id);
      const actual = await sha256Hex(await result.blob.arrayBuffer());
      const expected = build.artifact?.sha256 ?? result.sha256;
      if (actual && expected && actual !== expected) {
        toast(t('common.error', { message: 'SHA-256' }), 'danger');
        return;
      }
      saveBlob(result.blob, result.filename);
      toast(t('monitor.downloadStarted'), 'success');
    } catch (error) {
      toast(t('common.error', { message: errorMessage(error) }), 'danger');
    } finally {
      refs.downloadButton.disabled = false;
    }
  };

  const cancel = async () => {
    refs.cancelButton.disabled = true;
    try {
      const result = await api.cancelBuild(id);
      toast(t('monitor.cancelRequested'));
      if (result.build) applyBuild(result.build);
    } catch (error) {
      refs.cancelButton.disabled = false;
      toast(t('common.error', { message: errorMessage(error) }), 'danger');
    }
  };

  const remove = async () => {
    if (!(await confirmDialog(t('monitor.deleteConfirm')))) return;
    try {
      await api.deleteBuild(id);
      toast(t('monitor.deleted'), 'success');
      location.hash = '#/history';
    } catch (error) {
      toast(t('common.error', { message: errorMessage(error) }), 'danger');
    }
  };

  const updateElapsed = () => {
    if (!build || !refs.elapsed) return;
    const start = Date.parse(build.createdAt);
    const end = isTerminal() ? Date.parse(build.updatedAt) : Date.now();
    refs.elapsed.textContent = formatDuration(end - start);
  };

  const stageList = () => {
    const index = STAGES.indexOf(build.state);
    const items = STAGES.map((stage, position) => {
      let status = 'pending';
      if (index !== -1) status = position < index ? 'done' : position === index ? (build.state === 'completed' ? 'done' : 'current') : 'pending';
      return h('li', { class: `stage stage-${status}`, 'aria-current': status === 'current' ? 'step' : null }, h('span', { class: 'stage-marker' }, status === 'done' ? icon('check', { size: 14 }) : null), h('span', { class: 'stage-name' }, t(`state.${stage}`)));
    });
    if (index === -1) items.push(h('li', { class: `stage stage-final stage-${build.state}`, 'aria-current': 'step' }, h('span', { class: 'stage-marker' }, icon(build.state === 'failed' ? 'alert' : 'x', { size: 14 })), h('span', { class: 'stage-name' }, t(`state.${build.state}`))));
    return h('ol', { class: 'stages', 'aria-label': t('monitor.stages') }, items);
  };

  const warningsBlock = () => {
    const warnings = build.config?.warnings ?? [];
    if (warnings.length === 0) return null;
    return h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, t('monitor.warnings')),
      h('ul', { class: 'warnings' }, warnings.map((warning) => h('li', { class: 'warning' }, h('strong', null, t(`warn.${warning.code}`) === `warn.${warning.code}` ? warning.message : t(`warn.${warning.code}`)), warning.items?.length ? h('ul', { class: 'warning-items' }, warning.items.map((item) => h('li', null, h('code', null, item)))) : null)))
    );
  };

  const artifactBlock = () => {
    if (build.state !== 'completed' || !build.artifact) return null;
    const expired = isExpired(build.expiresAt);
    return h(
      'section',
      { class: 'section' },
      h('h2', { class: 'section-title' }, t('monitor.artifact')),
      expired ? h('p', { class: 'notice notice-warning' }, t('monitor.expired')) : null,
      h(
        'dl',
        { class: 'facts' },
        h('div', null, h('dt', null, t('monitor.size')), h('dd', null, formatBytes(build.artifact.size, getLanguage()))),
        h('div', null, h('dt', null, t('monitor.checksum')), h('dd', { class: 'hash' }, h('code', null, build.artifact.sha256), h('button', { type: 'button', class: 'icon-button', 'aria-label': t('common.copy'), onclick: () => copyText(build.artifact.sha256).then(() => toast(t('common.copied'))) }, icon('copy', { size: 16 })))),
        build.expiresAt ? h('div', null, h('dt', null, t('monitor.expires')), h('dd', null, formatDate(build.expiresAt, getLanguage()))) : null
      )
    );
  };

  function draw() {
    const previousLog = refs.log ? refs.log.cloneNode(true) : null;
    root.replaceChildren();
    refs.downloadButton = h('button', { type: 'button', class: 'button button-primary', onclick: download }, icon('download', { size: 18 }), t('monitor.download'));
    refs.cancelButton = h('button', { type: 'button', class: 'button', onclick: cancel }, icon('x', { size: 18 }), t('monitor.cancel'));
    refs.elapsed = h('span', { class: 'elapsed' });
    const active = isActiveState(build.state);
    const canDownload = build.state === 'completed' && !isExpired(build.expiresAt);
    refs.log = previousLog ?? h('div', { class: 'log', role: 'log', tabindex: '0', 'aria-label': t('monitor.logs') });
    if (!previousLog) refs.log.append(h('p', { class: 'log-empty' }, t('monitor.logsEmpty')));
    refs.reconnect = h('p', { class: 'notice notice-warning', role: 'status', hidden: !reconnecting }, t('monitor.reconnecting'));
    root.append(
      h('div', { class: 'page-head' }, h('div', { class: 'title-stack' }, h('h1', { class: 'page-title' }, build.appName), h('p', { class: 'page-subtitle' }, `${t(`input.${build.inputType}`)} · ${t('monitor.signing', { mode: build.signingMode })}`)), stateBadge(build.state)),
      refs.reconnect,
      h('div', { class: 'monitor-grid' }, h('div', { class: 'monitor-side' }, stageList(), h('p', { class: 'metric' }, h('span', { class: 'metric-label' }, t('monitor.elapsed')), refs.elapsed), build.state === 'queued' && build.queuePosition ? h('p', { class: 'metric' }, t('monitor.queuePosition', { position: build.queuePosition })) : null, h('div', { class: 'actions' }, canDownload ? refs.downloadButton : null, active ? refs.cancelButton : null, active ? null : h('button', { type: 'button', class: 'button button-quiet-danger', onclick: remove }, icon('trash', { size: 18 }), t('monitor.delete')))), h('div', { class: 'monitor-main' }, build.errorSummary ? h('div', { class: 'notice notice-danger', role: 'alert' }, icon('alert'), h('div', { class: 'notice-body' }, h('h2', { class: 'notice-title' }, t('monitor.error')), h('p', null, build.errorSummary))) : null, artifactBlock(), warningsBlock(), h('section', { class: 'section' }, h('h2', { class: 'section-title' }, t('monitor.logs')), refs.log))),
      h('p', null, h('a', { class: 'text-link', href: '#/history' }, t('monitor.backToHistory')))
    );
    updateElapsed();
  }

  function applyBuild(next) {
    build = next;
    document.title = `${build.appName} · ${t('app.name')}`;
    draw();
    if (!elapsedTimer && !isTerminal()) elapsedTimer = setInterval(updateElapsed, 1000);
    if (isTerminal() && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function appendLog(line, sequence) {
    if (sequence && sequence <= lastSequence) return;
    if (sequence) lastSequence = sequence;
    const log = refs.log;
    const placeholder = log.querySelector('.log-empty');
    if (placeholder) placeholder.remove();
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_TO_BOTTOM_PX;
    log.append(h('div', { class: 'log-line' }, line));
    logNodes += 1;
    if (logNodes > MAXIMUM_LOG_NODES) {
      log.firstChild?.remove();
      logNodes -= 1;
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function setReconnecting(value) {
    reconnecting = value;
    if (refs.reconnect) refs.reconnect.hidden = !value;
  }

  async function refresh() {
    try {
      const { build: latest } = await api.getBuild(id);
      if (!destroyed) applyBuild(latest);
    } catch {
      return;
    }
  }

  function handleEvent(event) {
    if (destroyed || !event.data) return;
    setReconnecting(false);
    if (event.type === 'state') applyBuild({ ...build, ...event.data });
    else if (event.type === 'log') appendLog(event.data.line, Number(event.id) || 0);
    else if (event.type === 'end') refresh();
  }

  async function connect() {
    let delay = 1000;
    while (!destroyed && !isTerminal()) {
      try {
        await api.streamEvents(id, { signal: controller.signal, lastEventId: lastSequence || undefined, onEvent: handleEvent });
      } catch (error) {
        if (destroyed || error?.name === 'AbortError') return;
        if (error?.status === 404) return;
      }
      if (destroyed) return;
      if (isTerminal()) break;
      setReconnecting(true);
      await sleep(delay, controller.signal);
      delay = Math.min(delay * 2, MAXIMUM_RECONNECT_DELAY_MS);
    }
    if (!destroyed && build && build.state === 'completed' && !build.artifact) await refresh();
  }

  (async () => {
    try {
      const { build: initial } = await api.getBuild(id);
      if (destroyed) return;
      applyBuild(initial);
      connect();
    } catch (error) {
      if (destroyed) return;
      root.replaceChildren(error?.status === 404 ? emptyState({ title: t('monitor.notFound'), action: h('a', { class: 'button', href: '#/history' }, t('monitor.backToHistory')) }) : errorState(t('common.error', { message: errorMessage(error) }), () => location.reload()));
    }
  })();

  return () => {
    destroyed = true;
    controller.abort();
    clearInterval(elapsedTimer);
  };
}

export function renderMonitor(main, context) {
  const { id } = context.route.params;
  return id ? renderBuild(main, context, id) : renderActiveList(main, context);
}
