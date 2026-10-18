export function parseRoute(hash) {
  const path = String(hash ?? '').replace(/^#/, '').replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return { name: 'dashboard', params: {} };
  const [first, second] = segments;
  if (segments.length === 1) {
    if (['studio', 'history', 'settings', 'docs', 'about', 'monitor'].includes(first)) return { name: first, params: {} };
  }
  if (segments.length === 2 && first === 'monitor' && /^[a-f0-9]{32}$/.test(second)) {
    return { name: 'monitor', params: { id: second } };
  }
  return { name: 'notFound', params: {} };
}

export const routeHash = (name, params = {}) => {
  if (name === 'dashboard') return '#/';
  if (name === 'monitor' && params.id) return `#/monitor/${params.id}`;
  return `#/${name}`;
};
