/*
 * gash.clop.ai is the public bootstrap, while the launcher HTML itself comes from the phone.
 * This tiny pre-loader asks the phone over the room WebSocket for /, using the same chunk format
 * as SignalChunker. The phone's request is made through its 10.200.0.1 TUN endpoint.
 */
var PROXY_SIGNAL_URL = 'wss://eelqunk48d.execute-api.ap-northeast-2.amazonaws.com/prod';
(function () {
    const params = new URLSearchParams(location.search);
    const room = params.get('r');
    window.CASTLA_HTTP_BOOTSTRAP = false;
    if (params.get('castla_phone_html') === '1') {
        window.dispatchEvent(new Event('castla:phone-html-ready'));
        return;
    }
    if (!room || !/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/.test(room)) return;
    if (!location.hostname.endsWith('gash.clop.ai')) return;
    window.CASTLA_HTTP_BOOTSTRAP = true;

    const splash = () => document.querySelector('#splash-loading .splash-loading-text');
    const status = (text) => { const el = splash(); if (el) el.textContent = text; };
    if (!PROXY_SIGNAL_URL) { status('폰 HTTP 터널 설정이 필요합니다.'); return; }

    const self = 'car-boot-' + Math.random().toString(36).slice(2, 10);
    const messages = new Map();
    let phone = null;
    let requestId = null;
    let finished = false;
    let socket;
    const timeout = setTimeout(() => fail('폰 HTTP 터널 응답 시간 초과 — 미러링을 시작한 뒤 새로고침하세요.'), 20000);

    function fail(text) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        status(text);
        try { socket && socket.close(); } catch (_) {}
    }

    function publish(payload) {
        const body = JSON.stringify(payload);
        const id = Math.random().toString(36).slice(2, 8);
        const n = Math.max(1, Math.ceil(body.length / 3000));
        for (let i = 0; i < n; i++) {
            socket.send(JSON.stringify({
                from: self, id, i, n,
                d: body.slice(i * 3000, (i + 1) * 3000)
            }));
        }
    }

    function receivePart(raw) {
        let part;
        try { part = JSON.parse(raw); } catch (_) { return; }
        if (!part || !part.from || part.from === self || typeof part.d !== 'string' ||
                !Number.isInteger(part.i) || !Number.isInteger(part.n) || part.n < 1 || part.n > 64 ||
                part.i < 0 || part.i >= part.n) return;
        const key = part.from + ':' + part.id;
        let state = messages.get(key);
        if (!state) { state = { from: part.from, chunks: new Array(part.n), received: 0 }; messages.set(key, state); }
        if (state.chunks.length !== part.n) return;
        if (state.chunks[part.i] === undefined) state.received++;
        state.chunks[part.i] = part.d;
        if (state.received < part.n) return;
        messages.delete(key);
        let message;
        try { message = JSON.parse(state.chunks.join('')); } catch (_) { return; }

        if (message.type === 'offer' && message.to === self && !requestId) {
            phone = state.from;
            requestId = Math.random().toString(36).slice(2, 12);
            status('폰 미러링 서버에서 페이지를 가져오는 중…');
            publish({ type: 'http_request', method: 'GET', path: '/', requestId, to: phone });
            return;
        }
        if (message.type !== 'http_response' || message.to !== self || message.requestId !== requestId) return;
        if (message.status < 200 || message.status >= 300 || !message.bodyBase64) {
            fail('폰에서 미러링 페이지를 가져오지 못했습니다.');
            return;
        }
        try {
            const binary = atob(message.bodyBase64);
            const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
            const html = new TextDecoder('utf-8').decode(bytes);
            if (!/^text\/html\b/i.test(message.contentType || '') || !html.toLowerCase().includes('<html')) {
                throw new Error('Invalid phone page response');
            }
            finished = true;
            clearTimeout(timeout);
            const next = new URL(location.href);
            next.searchParams.set('castla_phone_html', '1');
            history.replaceState(null, '', next.pathname + next.search + next.hash);
            try { socket.close(); } catch (_) {}
            document.open();
            document.write(html);
            document.close();
        } catch (e) {
            fail('폰 페이지를 표시하지 못했습니다: ' + e.message);
        }
    }

    try {
        status('AWS를 통해 폰 HTTP 터널에 연결 중…');
        socket = new WebSocket(PROXY_SIGNAL_URL + '?room=' + encodeURIComponent(room));
        socket.onopen = () => publish({ type: 'hello' });
        socket.onmessage = (event) => receivePart(event.data);
        socket.onerror = () => fail('AWS 터널에 연결할 수 없습니다.');
        socket.onclose = () => { if (!finished) fail('AWS 터널 연결이 끊겼습니다.'); };
    } catch (e) {
        fail('AWS 터널에 연결할 수 없습니다: ' + e.message);
    }
})();
