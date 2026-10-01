/*
 * gash.clop.ai is the public bootstrap, while the launcher HTML itself comes from the phone.
 * This tiny pre-loader asks the phone over the room WebSocket for /, using the same chunk format
 * as SignalChunker. The phone's request is made through its 10.200.0.1 TUN endpoint.
 */
var PROXY_SIGNAL_URL = 'wss://eelqunk48d.execute-api.ap-northeast-2.amazonaws.com/prod';
(function () {
    const params = new URLSearchParams(location.search);
    const ROOM_PATTERN = /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
    const ROOM_KEY = 'castlaRoom';
    const onPublicSite = location.hostname.endsWith('gash.clop.ai');
    // Storage can be missing or blocked; the page then simply needs ?r= every time.
    const rememberRoom = (code) => { try { localStorage.setItem(ROOM_KEY, code); } catch (_) {} };
    let room = params.get('r');
    // A car that connected before may open the bare address: put its room code back into the
    // address, where the rest of the page (and the phone's own HTML) looks for it.
    if (!room && onPublicSite && !params.has('h')) {
        let saved = null;
        try { saved = localStorage.getItem(ROOM_KEY); } catch (_) {}
        if (saved && ROOM_PATTERN.test(saved)) {
            room = saved;
            params.set('r', saved);
            history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
        }
    }
    window.CASTLA_HTTP_BOOTSTRAP = false;
    if (params.get('castla_phone_html') === '1') {
        if (room && ROOM_PATTERN.test(room) && onPublicSite) rememberRoom(room);
        window.CASTLA_PHONE_HTML_READY = true;
        window.dispatchEvent(new Event('castla:phone-html-ready'));
        return;
    }
    if (!room || !ROOM_PATTERN.test(room)) return;
    if (!onPublicSite) return;
    window.CASTLA_HTTP_BOOTSTRAP = true;

    const self = 'car-boot-' + Math.random().toString(36).slice(2, 10);
    const ATTEMPT_TIMEOUT_MS = 20000;
    const HELLO_INTERVAL_MS = 5000;             // the phone may start mirroring after the page opened
    const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];
    let messages = new Map();
    let phone = null;
    let requestId = null;
    let finished = false;
    let socket = null;
    let timeout = null;
    let helloTimer = null;
    let retryTimer = null;
    let failures = 0;
    let lastStatus = null;
    let retryButton = null;

    const splash = () => document.querySelector('#splash-loading .splash-loading-text');
    const status = (text) => { lastStatus = text; const el = splash(); if (el) el.textContent = text; };
    // This script runs in <head>, before the splash exists; show what was missed once it does.
    document.addEventListener('DOMContentLoaded', () => {
        if (finished) return;
        if (lastStatus) status(lastStatus);
        showRetryButton(retryTimer !== null);
    });
    if (!PROXY_SIGNAL_URL) { status('폰 HTTP 터널 설정이 필요합니다.'); return; }

    function showRetryButton(visible) {
        if (!retryButton) {
            const box = document.getElementById('splash-loading');
            if (!box) return;
            retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.textContent = '다시 연결';
            retryButton.style.cssText = 'margin-top:12px;padding:10px 24px;font-size:15px;color:#fff;' +
                'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:8px';
            retryButton.addEventListener('click', connect);
            box.appendChild(retryButton);
        }
        retryButton.style.display = visible ? '' : 'none';
    }

    function closeAttempt() {
        clearTimeout(timeout);
        clearInterval(helloTimer);
        clearTimeout(retryTimer);
        retryTimer = null;
        const ws = socket;
        socket = null;          // handlers of a closed attempt check this and stay quiet
        try { ws && ws.close(); } catch (_) {}
    }

    /** Nothing here is final: the phone may not be mirroring yet, so every failure tries again. */
    function fail(text) {
        if (finished) return;
        closeAttempt();
        status(text + ' 자동으로 다시 연결합니다.');
        const delay = RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)];
        retryTimer = setTimeout(connect, delay);
        showRetryButton(true);
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
            fail('폰에서 미러링 페이지를 가져오지 못했습니다 (HTTP ' + message.status + ').');
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
            rememberRoom(room);     // only a code that reached the phone is worth keeping
            const next = new URL(location.href);
            next.searchParams.set('castla_phone_html', '1');
            history.replaceState(null, '', next.pathname + next.search + next.hash);
            closeAttempt();
            document.open();
            document.write(html);
            document.close();
        } catch (e) {
            finished = false;
            fail('폰 페이지를 표시하지 못했습니다: ' + e.message + '.');
        }
    }

    function connect() {
        if (finished) return;
        closeAttempt();
        showRetryButton(false);
        messages = new Map();
        phone = null;
        requestId = null;
        status('AWS를 통해 폰 HTTP 터널에 연결 중…');
        let ws;
        try {
            ws = new WebSocket(PROXY_SIGNAL_URL + '?room=' + encodeURIComponent(room));
        } catch (e) {
            fail('AWS 터널에 연결할 수 없습니다: ' + e.message + '.');
            return;
        }
        socket = ws;
        timeout = setTimeout(() => fail('폰 응답이 없습니다 — 폰에서 미러링을 시작하세요.'), ATTEMPT_TIMEOUT_MS);
        const hello = () => { if (ws === socket && !requestId && ws.readyState === WebSocket.OPEN) publish({ type: 'hello' }); };
        ws.onopen = () => {
            if (ws !== socket) return;
            status('폰 응답을 기다리는 중…');
            hello();
            helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
        };
        ws.onmessage = (event) => { if (ws === socket) receivePart(event.data); };
        ws.onerror = () => { if (ws === socket) fail('AWS 터널에 연결할 수 없습니다.'); };
        ws.onclose = () => { if (ws === socket) fail('AWS 터널 연결이 끊겼습니다.'); };
    }

    connect();
})();
