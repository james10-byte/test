import { t } from '../i18n.js';
import { h } from '../ui.js';

const SECTIONS = [
  { id: 'usage', paragraphs: 3 },
  { id: 'install', paragraphs: 3, code: ['npm install', 'cp .env.example .env', 'npm start'] },
  {
    id: 'api',
    paragraphs: 2,
    code: [
      'GET    /api/health',
      'GET    /api/config',
      'POST   /api/builds             multipart: config, source, icon',
      'GET    /api/builds',
      'GET    /api/builds/:id',
      'GET    /api/builds/:id/events  Server-Sent Events',
      'POST   /api/builds/:id/cancel',
      'GET    /api/builds/:id/download',
      'DELETE /api/builds/:id',
      'POST   /api/icons/preview      multipart: icon, settings'
    ]
  },
  { id: 'deploy', paragraphs: 3 },
  { id: 'troubleshoot', paragraphs: 4 },
  { id: 'security', paragraphs: 3 }
];

export function renderDocs(main) {
  const sections = SECTIONS.map((section) =>
    h(
      'section',
      { class: 'doc-section', id: `doc-${section.id}`, 'aria-labelledby': `doc-${section.id}-title` },
      h('h2', { class: 'section-title', id: `doc-${section.id}-title` }, t(`docs.${section.id}.title`)),
      Array.from({ length: section.paragraphs }, (_, index) => h('p', { class: 'prose' }, t(`docs.${section.id}.p${index + 1}`))),
      section.code ? h('pre', { class: 'code' }, h('code', null, section.code.join('\n'))) : null
    )
  );
  const contents = h(
    'nav',
    { class: 'doc-contents', 'aria-label': t('docs.title') },
    SECTIONS.map((section) =>
      h(
        'button',
        {
          type: 'button',
          class: 'text-link',
          onclick: () => document.getElementById(`doc-${section.id}`)?.scrollIntoView({ block: 'start' })
        },
        t(`docs.${section.id}.title`)
      )
    )
  );
  main.append(h('h1', { class: 'page-title' }, t('docs.title')), h('div', { class: 'docs' }, contents, h('div', { class: 'doc-body' }, sections)));
}
