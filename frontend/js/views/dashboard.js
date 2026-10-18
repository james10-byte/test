import { formatDate } from '../format.js';
import { getLanguage, t } from '../i18n.js';
import { emptyState, errorState, h, icon, loadingState, stateBadge } from '../ui.js';

const POLL_MS = 4000;

export function renderDashboard(main, { api }) {
  const body = h('div', { class: 'page-body' });
  main.append(
    h(
      'div',
      { class: 'page-head' },
      h('h1', { class: 'page-title' }, t('dashboard.title')),
      h('a', { class: 'button button-primary', href: '#/studio' }, icon('plus', { size: 18 }), t('dashboard.create'))
    ),
    body
  );
  let destroyed = false;
  let timer = null;

  const ledger = (stats) =>
    h(
      'dl',
      { class: 'ledger' },
      [
        ['total', stats.total],
        ['succeeded', stats.succeeded],
        ['failed', stats.failed],
        ['active', stats.active]
      ].map(([key, value]) =>
        h('div', { class: `ledger-item ledger-${key}${value === 0 ? ' ledger-zero' : ''}` }, h('dt', null, t(`stats.${key}`)), h('dd', null, new Intl.NumberFormat(getLanguage()).format(value)))
      )
    );

  const recent = (builds) =>
    h(
      'section',
      { class: 'section', 'aria-labelledby': 'recent-title' },
      h('div', { class: 'section-head' }, h('h2', { id: 'recent-title', class: 'section-title' }, t('dashboard.recent')), h('a', { class: 'text-link', href: '#/history' }, t('dashboard.viewAll'))),
      h(
        'ul',
        { class: 'activity' },
        builds.slice(0, 6).map((build) =>
          h(
            'li',
            { class: 'activity-row' },
            h(
              'a',
              { class: 'activity-link', href: `#/monitor/${build.id}` },
              h('span', { class: 'activity-name' }, build.appName),
              h('span', { class: 'activity-meta' }, `${t(`input.${build.inputType}`)} · ${formatDate(build.createdAt, getLanguage())}`)
            ),
            stateBadge(build.state)
          )
        )
      )
    );

  const draw = (data) => {
    if (data.stats.total === 0) {
      body.replaceChildren(
        emptyState({
          title: t('dashboard.emptyTitle'),
          body: t('dashboard.emptyBody'),
          action: h('a', { class: 'button button-primary', href: '#/studio' }, icon('plus', { size: 18 }), t('dashboard.create'))
        })
      );
      return;
    }
    body.replaceChildren(ledger(data.stats), recent(data.builds));
  };

  const load = async (initial) => {
    if (initial) body.replaceChildren(loadingState());
    try {
      const data = await api.listBuilds({ limit: 50 });
      if (destroyed) return;
      draw(data);
      if (data.stats.active > 0) timer = setTimeout(() => load(false), POLL_MS);
    } catch {
      if (destroyed) return;
      body.replaceChildren(errorState(t('dashboard.loadError'), () => load(true)));
    }
  };

  load(true);
  return () => {
    destroyed = true;
    clearTimeout(timer);
  };
}
