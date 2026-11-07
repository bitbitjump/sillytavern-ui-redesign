import { handleTavernApi } from './api.mjs';

export default {
    async fetch(request, env) {
        const api = await handleTavernApi(request, env);
        if (api) return api;
        const response = await env.ASSETS.fetch(request);
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/html')) return response;
        const html = (await response.text()).replace(/<body(?=[\s>])/, '<body data-hosted');
        const headers = new Headers(response.headers);
        headers.delete('Content-Length');
        headers.delete('ETag');
        headers.set('Cache-Control', 'no-store');
        return new Response(html, { headers, status: response.status });
    },
};
