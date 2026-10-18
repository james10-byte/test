import { formatBytes, formatDate, isActiveState, isExpired, shortHash } from '../format.js';
import { sha256Hex } from '../hash.js';
import { getLanguage, t } from '../i18n.js';
import { confirmDialog, copyText, emptyState, errorMessage, errorState, h, icon, loadingState, saveBlob, stateBadge, toast } from '../ui.js';

const PAGE_SIZE = 15;

export function renderHistory(main, { api }) {
  const body = h('div', { class: 'page-body' });
  main.append(
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, t('history.title')), h('a', { class: 'button button-primary', href: '#/studio' }, icon('plus', { size: 18 }), t('dashboard.create'))),
    body
  );
  let destroyed = false;
  let offset = 0;

  const download = async (build) => {
    try {
      const result = await api.downloadBuild(build.id);
      const actual = await sha256Hex(await result.blob.arrayBuffer());
      if (actual && build.artifact && actual !== build.artifact.sha256) {
        toast(t('common.error', { message: 'SHA-256' }), 'danger');
        return;
      }
      saveBlob(result.blob, result.filename);
      toast(t('monitor.downloadStarted'), 'success');
    } catch (error) {
      toast(t('common.error', { message: errorMessage(error) }), 'danger');
    }
  };

  const remove = async (build) => {
    if (!(await confirmDialog(t('monitor.deleteConfirm')))) return;
    try {
      await api.deleteBuild(build.id);
      toast(t('history.deleted'), 'success');
      load();
    } catch (error) {
      toast(t('common.error', { message: errorMessage(error) }), 'danger');
    }
  };

  const copyChecksum = async (button, hash) => {
    if (await copyText(hash)) {
      const label = button.lastChild;
      const previous = label.textContent;
      label.textContent = t('common.copied');
      setTimeout(() => {
        label.textContent = previous;
      }, 1500);
    }
  };

  const row = (build) => {
    const expired = isExpired(build.expiresAt);
    const downloadable = build.state === 'completed' && !expired;
    return h(
      'tr',
      null,
      h('td', { 'data-label': t('history.application'), class: 'cell-name' }, h('a', { class: 'text-link', href: `#/monitor/${build.id}` }, build.appName)),
      h('td', { 'data-label': t('history.created') }, formatDate(build.createdAt, getLanguage())),
      h('td', { 'data-label': t('history.type') }, t(`input.${build.inputType}`)),
      h('td', { 'data-label': t('history.status') }, stateBadge(build.state)),
      h('td', { 'data-label': t('history.size') }, build.artifact ? formatBytes(build.artifact.size, getLanguage()) : '—'),
      h(
        'td',
        { 'data-label': t('history.checksum') },
        build.artifact
          ? h('button', { type: 'button', class: 'chip', title: build.artifact.sha256, onclick: (event) => copyChecksum(event.currentTarget, build.artifact.sha256) }, icon('copy', { size: 14 }), h('span', null, shortHash(build.artifact.sha256)))
          : '—'
      ),
      h('td', { 'data-label': t('history.expires') }, build.expiresAt ? (expired ? t('history.expiredLabel') : formatDate(build.expiresAt, getLanguage())) : '—'),
      h(
        'td',
        { 'data-label': t('history.actions'), class: 'cell-actions' },
        h('a', { class: 'button button-small', href: `#/monitor/${build.id}` }, t('common.open')),
        downloadable ? h('button', { type: 'button', class: 'button button-small', onclick: () => download(build) }, icon('download', { size: 16 }), t('common.download')) : null,
        isActiveState(build.state) ? null : h('button', { type: 'button', class: 'button button-small button-quiet-danger', 'aria-label': `${t('common.delete')} ${build.appName}`, onclick: () => remove(build) }, icon('trash', { size: 16 }), t('common.delete'))
      )
    );
  };

  const draw = (data) => {
    if (data.stats.total === 0) {
      body.replaceChildren(emptyState({ title: t('history.emptyTitle'), body: t('history.emptyBody'), action: h('a', { class: 'button button-primary', href: '#/studio' }, t('dashboard.create')) }));
      return;
    }
    const total = data.stats.total;
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + data.builds.length, total);
    body.replaceChildren(
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, ['application', 'created', 'type', 'status', 'size', 'checksum', 'expires', 'actions'].map((key) => h('th', { scope: 'col' }, t(`history.${key}`))))),
        h('tbody', null, data.builds.map(row))
      ),
      h(
        'div',
        { class: 'pager' },
        h('span', { class: 'pager-info' }, t('history.pageInfo', { from, to, total })),
        h('button', { type: 'button', class: 'button button-small', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE_SIZE); load(); } }, t('common.previous')),
        h('button', { type: 'button', class: 'button button-small', disabled: offset + PAGE_SIZE >= total, onclick: () => { offset += PAGE_SIZE; load(); } }, t('common.next'))
      )
    );
  };

  async function load(initial = true) {
    if (initial) body.replaceChildren(loadingState());
    try {
      const data = await api.listBuilds({ limit: PAGE_SIZE, offset });
      if (destroyed) return;
      if (data.builds.length === 0 && offset > 0) {
        offset = Math.max(0, offset - PAGE_SIZE);
        load();
        return;
      }
      draw(data);
    } catch (error) {
      if (!destroyed) body.replaceChildren(errorState(t('common.error', { message: errorMessage(error) }), () => load()));
    }
  }

  load();
  return () => {
    destroyed = true;
  };
}
