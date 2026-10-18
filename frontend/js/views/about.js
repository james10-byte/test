import { t } from '../i18n.js';
import { brandMark, h, icon } from '../ui.js';

const REPOSITORY = 'https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER';
const VERSION = '0.1.0';

export function renderAbout(main) {
  main.append(
    h('h1', { class: 'page-title' }, t('about.title')),
    h(
      'div',
      { class: 'about' },
      h('div', { class: 'about-mark' }, brandMark(64)),
      h('h2', { class: 'about-name' }, t('app.name')),
      h('p', { class: 'about-creator' }, t('about.creator', { name: 'INCONNU BOY SENSEI' })),
      h('p', { class: 'prose' }, t('about.description')),
      h(
        'dl',
        { class: 'facts' },
        h('div', null, h('dt', null, t('about.repository')), h('dd', null, h('a', { class: 'text-link', href: REPOSITORY, target: '_blank', rel: 'noopener noreferrer' }, 'INCONNU-BOY/INCONNU-BOY-APK-BUILDER', icon('external', { size: 14 })))),
        h('div', null, h('dt', null, t('about.license')), h('dd', null, 'MIT'))
      ),
      h('p', { class: 'about-version' }, t('about.version', { version: VERSION }))
    )
  );
}
