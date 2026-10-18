import { createSseParser } from './sse.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function toApiError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = body?.error;
  return new ApiError(response.status, error?.code ?? 'http_error', error?.message ?? `Request failed with status ${response.status}.`, error?.details);
}

export function createApi({ getSettings, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  const url = (path) => `${getSettings().apiBase}/api${path}`;

  const headers = (extra = {}) => {
    const settings = getSettings();
    const result = { 'X-Client-Token': settings.clientToken, ...extra };
    if (settings.apiKey) result.Authorization = `Bearer ${settings.apiKey}`;
    return result;
  };

  const request = async (path, options = {}) => {
    let response;
    try {
      response = await fetchImpl(url(path), { ...options, headers: headers(options.headers) });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError(0, 'network_error', 'The server cannot be reached.');
    }
    if (!response.ok) throw await toApiError(response);
    return response;
  };

  const json = async (path, options) => (await request(path, options)).json();

  return {
    async health() {
      let response;
      try {
        response = await fetchImpl(url('/health'));
      } catch {
        throw new ApiError(0, 'network_error', 'The server cannot be reached.');
      }
      if (!response.ok) throw await toApiError(response);
      return response.json();
    },
    config: () => json('/config'),
    listBuilds: ({ limit = 20, offset = 0 } = {}) => json(`/builds?limit=${limit}&offset=${offset}`),
    getBuild: (id) => json(`/builds/${id}`),
    createBuild: (formData) => json('/builds', { method: 'POST', body: formData }),
    cancelBuild: (id) => json(`/builds/${id}/cancel`, { method: 'POST' }),
    async deleteBuild(id) {
      await request(`/builds/${id}`, { method: 'DELETE' });
    },
    async downloadBuild(id) {
      const response = await request(`/builds/${id}/download`);
      const disposition = response.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      return { blob: await response.blob(), filename: match?.[1] ?? `${id}.apk`, sha256: response.headers.get('x-artifact-sha256') };
    },
    previewIcon(file, settings, signal) {
      const form = new FormData();
      form.append('icon', file);
      form.append('settings', JSON.stringify(settings));
      return json('/icons/preview', { method: 'POST', body: form, signal });
    },
    async streamEvents(id, { signal, lastEventId, onEvent }) {
      const extra = { Accept: 'text/event-stream' };
      if (lastEventId) extra['Last-Event-ID'] = String(lastEventId);
      const response = await request(`/builds/${id}/events`, { signal, headers: extra });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser((message) => {
        let data = null;
        try {
          data = JSON.parse(message.data);
        } catch {
          data = null;
        }
        onEvent({ type: message.event, data, id: message.id });
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    }
  };
}
