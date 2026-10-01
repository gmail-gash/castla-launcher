/**
 * WebRTC transport for the public launcher page (`?r=<room code>`).
 *
 * Current Chromium blocks a public page's WebSocket and HTTP requests to a private address, so
 * this page cannot reach the phone the old way. WebRTC peers on the local network are exempt:
 * the page exchanges session descriptions with the phone through ntfy.sh, then video arrives
 * over the peer connection and control messages travel over its data channel. No STUN/TURN
 * servers are configured, so the connection can only form on the local network.
 *
 * Signaling wire format matches the phone (SignalChunker.kt): each ntfy message is
 * {from, id, i, n, d}, where d is a slice of the payload's JSON text.
 */
// WebSocket relay from aws/signaling.yaml. scripts/build-launcher-site.sh fills this in from
// SignalingConfig.SOCKET_URL; left empty, signaling falls back to ntfy.sh.
const RTC_SIGNAL_URL = 'wss://eelqunk48d.execute-api.ap-northeast-2.amazonaws.com/prod';
const RTC_SIGNAL_KEEPALIVE_MS = 4 * 60 * 1000;  // the relay drops a socket after 10 idle minutes
const RTC_NTFY = 'https://ntfy.sh';
const RTC_TOPIC_PREFIX = 'castla-rtc-';
const RTC_CHUNK = 3000;                        // ntfy turns bodies over 4096 bytes into attachments
const RTC_ROOM_PATTERN = /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
// ntfy.sh allows about 250 messages a day per address, and one connection costs ~5 of them
// (hello + offer and answer in two parts each). Waiting hellos are what burns the quota.
const RTC_HELLO_FAST_MS = 5000;                // first 30 s: the phone may be seconds away
const RTC_HELLO_SLOW_MS = 30000;               // then once every 30 s
const RTC_HELLO_FAST_COUNT = 6;
const RTC_NEGOTIATION_MS = 10000;              // matches HelloPolicy.NEGOTIATION_WINDOW_MS on the phone
const RTC_REQUEST_TIMEOUT_MS = 15000;
// Receive-side buffer. 2.4 GHz Wi-Fi shows ~200 ms latency spikes; with Chrome's default ~80 ms
// target each one froze the picture. Costs ~70 ms of extra delay. Override with ?jb=<ms>.
const RTC_JITTER_BUFFER_MS = (() => {
    const v = parseInt(new URLSearchParams(location.search).get('jb'), 10);
    return Number.isFinite(v) && v >= 0 && v <= 1000 ? v : 150;
})();

/** Room code from `?r=`, or null when the page runs on the WebSocket transport. */
function resolveRoom(loc) {
    const room = new URLSearchParams(loc.search).get('r');
    return room && RTC_ROOM_PATTERN.test(room) ? room : null;
}

/**
 * Presents a data channel as a WebSocket, so the existing control code (touch, keyboard bubble,
 * home, viewport) runs unchanged. `readyState` maps to the numeric WebSocket constants.
 */
class DataChannelSocket {
    /**
     * @param tap    sees text messages first; returning true consumes them
     * @param retain for messages arriving before anyone listens: true keeps the latest such
     *               message and delivers it once `onmessage` is set (everything else is dropped)
     */
    constructor(channel, tap, retain) {
        this.channel = channel;
        this.onopen = null;
        this._onmessage = null;
        this._retained = null;
        this.onclose = null;
        this.onerror = null;
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => this.onopen && this.onopen();
        channel.onclose = () => this.onclose && this.onclose();
        channel.onerror = (e) => this.onerror && this.onerror(e);
        channel.onmessage = (event) => {
            if (tap && typeof event.data === 'string' && tap(event.data)) return;
            if (this._onmessage) this._onmessage(event);
            else if (retain && retain(event.data)) this._retained = event;
        };
    }

    get onmessage() { return this._onmessage; }

    set onmessage(handler) {
        this._onmessage = handler;
        const held = this._retained;
        this._retained = null;
        if (handler && held) handler(held);
    }

    get readyState() {
        return { connecting: 0, open: 1, closing: 2, closed: 3 }[this.channel.readyState];
    }

    send(data) { this.channel.send(data); }

    close() { this.channel.close(); }
}

class RtcLink {
    /**
     * @param {string} room
     * @param {{onTrack: function(MediaStream), onChannel: function(DataChannelSocket),
     *          onAudioChannel: function(DataChannelSocket), onLost: function(),
     *          onReplaced: function()}} handlers
     */
    constructor(room, handlers) {
        this.topic = RTC_TOPIC_PREFIX + room;
        this.self = 'car-' + Math.random().toString(36).slice(2, 10);
        this.handlers = handlers;
        this.pc = null;
        this.offerSdp = null;     // offer the current peer answered, to spot repeats
        this.answerSdp = null;
        this.connected = false;
        this.hellos = 0;
        this.helloTimer = null;
        this.waiters = [];
        this.httpWaiters = new Map();
        this.phoneId = null;
        this.icons = new Map();
        this.partial = new Map();
        this.relay = null;
        this.paused = false;   // another screen took the phone; wait for the user before retrying
    }

    start() {
        if (RTC_SIGNAL_URL) {
            this.openRelay(1000);
            return;
        }
        const events = new EventSource(`${RTC_NTFY}/${this.topic}/sse`);
        events.onopen = () => this.scheduleHello(0);
        events.onmessage = (event) => {
            try {
                const e = JSON.parse(event.data);
                if (!e.event || e.event === 'message') this.onSignal(e.message);
            } catch (_) {}
        };
        events.onerror = () => console.warn('[RTC] Signaling stream interrupted — retrying');
    }

    /** Tell the page how far the connection got, for the loading screen. */
    stage(text) {
        if (this.handlers.onStage) this.handlers.onStage(text);
    }

    /** Join the room on the WebSocket relay; reopen with backoff whenever it drops. */
    openRelay(backoffMs) {
        const room = this.topic.slice(RTC_TOPIC_PREFIX.length);
        this.stage('신호 서버 연결 중…');
        let ws;
        try {
            ws = new WebSocket(`${RTC_SIGNAL_URL}?room=${room}`);
        } catch (e) {
            this.stage(`신호 서버에 연결할 수 없음 (${e.message})`);
            return;
        }
        let keepalive = null;
        ws.onopen = () => {
            this.relay = ws;
            backoffMs = 1000;
            if (!this.connected) this.stage('폰 기다리는 중… (폰에서 미러링 시작)');
            keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), RTC_SIGNAL_KEEPALIVE_MS);
            if (!this.connected && !this.paused) this.scheduleHello(0);
        };
        ws.onmessage = (event) => this.onSignal(event.data);
        ws.onclose = () => {
            clearInterval(keepalive);
            if (this.relay === ws) this.relay = null;
            if (!this.connected) this.stage(`신호 서버 연결 끊김 — ${backoffMs / 1000}초 뒤 재시도`);
            console.warn(`[RTC] Signaling relay closed — retrying in ${backoffMs / 1000}s`);
            setTimeout(() => this.openRelay(Math.min(backoffMs * 2, 30000)), backoffMs);
        };
    }

    /** Ask the phone for a fresh connection, e.g. after the previous one dropped. */
    reconnect() {
        if (this.paused) return;
        this.closePeer();
        this.hellos = 0;
        this.scheduleHello(0);
    }

    /* ---------- signaling ---------- */

    scheduleHello(delayMs) {
        clearTimeout(this.helloTimer);
        this.helloTimer = setTimeout(() => {
            if (this.connected || this.paused) return;
            if (document.hidden) {
                // Nobody is looking; ask again as soon as the page is visible.
                document.addEventListener('visibilitychange', () => this.scheduleHello(0), { once: true });
                return;
            }
            this.hellos++;
            this.publish({ type: 'hello' });
            this.scheduleHello(this.hellos < RTC_HELLO_FAST_COUNT ? RTC_HELLO_FAST_MS : RTC_HELLO_SLOW_MS);
        }, delayMs);
    }

    publish(payload) {
        const body = JSON.stringify(payload);
        const id = Math.random().toString(36).slice(2, 8);
        const n = Math.max(1, Math.ceil(body.length / RTC_CHUNK));
        for (let i = 0; i < n; i++) {
            const part = { from: this.self, id, i, n, d: body.slice(i * RTC_CHUNK, (i + 1) * RTC_CHUNK) };
            if (RTC_SIGNAL_URL) {
                if (this.relay && this.relay.readyState === WebSocket.OPEN) this.relay.send(JSON.stringify(part));
                continue;   // a hello lost while the relay reconnects is repeated once it is back
            }
            fetch(`${RTC_NTFY}/${this.topic}`, { method: 'POST', body: JSON.stringify(part) })
                .catch((e) => console.warn('[RTC] Publish failed:', e));
        }
    }

    /** One signaling part — the {from, id, i, n, d} envelope, from either transport. */
    onSignal(data) {
        let part;
        try { part = JSON.parse(data); } catch (_) { return; }
        if (!part || part.from === this.self || typeof part.d !== 'string') return;

        const key = `${part.from}:${part.id}`;
        const parts = this.partial.get(key) || new Array(part.n);
        parts[part.i] = part.d;
        this.partial.set(key, parts);
        if (parts.filter((p) => p !== undefined).length !== part.n) return;
        this.partial.delete(key);

        let msg;
        try { msg = JSON.parse(parts.join('')); } catch (_) { return; }
        if (msg.type === 'http_response') {
            if (msg.to !== this.self) return;
            const waiter = this.httpWaiters.get(msg.requestId);
            if (!waiter) return;
            clearTimeout(waiter.timer);
            this.httpWaiters.delete(msg.requestId);
            waiter.resolve(msg);
            return;
        }
        if (msg.type !== 'offer' || this.connected || this.paused) return;
        if (msg.to && msg.to !== this.self) return;   // another screen's offer
        this.phoneId = part.from;
        // Don't say hello again while this offer is being answered; the phone would take it as
        // a request to start over. If negotiation stalls, the next hello asks for a fresh offer.
        this.scheduleHello(RTC_NEGOTIATION_MS);
        if (msg.sdp === this.offerSdp) {
            // The phone repeats its offer when our hello crossed it in flight: answer it the same way.
            if (this.answerSdp) this.publish({ type: 'answer', sdp: this.answerSdp });
            return;
        }
        this.answer(msg.sdp);
    }

    /* ---------- peer ---------- */

    async answer(sdp) {
        this.stage('폰 찾음 — 같은 Wi‑Fi로 연결 중…');
        this.closePeer();
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.pc = pc;
        this.offerSdp = sdp;

        pc.ontrack = (event) => {
            if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = RTC_JITTER_BUFFER_MS;
            this.handlers.onTrack(event.streams[0] || new MediaStream([event.track]));
        };
        pc.ondatachannel = (event) => {
            if (event.channel.label === 'audio') {
                // Same bytes the WebSocket /ws/audio endpoint sends, so AudioPlayer plays it as is.
                // The phone sends the stream config once, when the channel opens, which can be
                // before a tap lets the page play audio. Hold on to it until the player attaches.
                const isConfig = (data) => data instanceof ArrayBuffer && new Uint8Array(data)[0] === 0x00;
                this.handlers.onAudioChannel(new DataChannelSocket(event.channel, null, isConfig));
            } else {
                this.handlers.onChannel(new DataChannelSocket(event.channel, (text) => this.onControlText(text)));
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc !== this.pc) return;
            console.log('[RTC] Connection:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                this.stage('연결됨');
                this.connected = true;
                clearTimeout(this.helloTimer);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                // Signaling worked but the direct link did not: usually not on the phone's Wi-Fi.
                if (pc.connectionState === 'failed') this.stage('폰에 직접 연결 실패 — 차와 폰이 같은 Wi‑Fi인지 확인');
                this.handlers.onLost();
                this.reconnect();
            }
        };

        await pc.setRemoteDescription({ type: 'offer', sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve();
            pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') resolve();
            });
            setTimeout(resolve, 3000);   // host candidates arrive at once; don't wait on a stalled gatherer
        });
        if (pc !== this.pc) return;
        this.answerSdp = pc.localDescription.sdp;
        this.publish({ type: 'answer', sdp: this.answerSdp });
    }

    closePeer() {
        this.connected = false;
        this.offerSdp = null;
        this.answerSdp = null;
        if (!this.pc) return;
        const pc = this.pc;
        this.pc = null;
        try { pc.close(); } catch (_) {}
    }

    /* ---------- requests over the data channel ---------- */

    /**
     * Send `message` over the control channel and resolve with the first reply `match` accepts
     * (anything but undefined). Used for data the page used to fetch over HTTP.
     */
    request(socket, message, match) {
        return new Promise((resolve, reject) => {
            const waiter = { match, resolve };
            this.waiters.push(waiter);
            setTimeout(() => {
                const at = this.waiters.indexOf(waiter);
                if (at >= 0) { this.waiters.splice(at, 1); reject(new Error('RTC request timed out')); }
            }, RTC_REQUEST_TIMEOUT_MS);
            socket.send(JSON.stringify(message));
        });
    }

    /** HTTP GET through the AWS room relay, phone, and its 10.200.0.1 TUN endpoint. */
    httpGet(path) {
        if (!this.phoneId) return Promise.reject(new Error('Phone endpoint is not connected'));
        if (typeof path !== 'string' || !path.startsWith('/') || path.length > 2048 || path.includes('..')) {
            return Promise.reject(new Error('Invalid proxy path'));
        }
        const requestId = Math.random().toString(36).slice(2, 12);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                this.httpWaiters.delete(requestId);
                reject(new Error('Phone HTTP tunnel timed out'));
            }, RTC_REQUEST_TIMEOUT_MS);
            this.httpWaiters.set(requestId, waiter);
            this.publish({ type: 'http_request', method: 'GET', path, requestId, to: this.phoneId });
        });
    }

    /** App icon as a data URL (null when the app has none), fetched once per package. */
    icon(socket, pkg) {
        if (!this.icons.has(pkg)) {
            this.icons.set(pkg, this.request(socket, { type: 'getIcon', pkg },
                (m) => (m.type === 'icon' && m.pkg === pkg) ? (m.png ? `data:image/png;base64,${m.png}` : null) : undefined)
                .catch(() => { this.icons.delete(pkg); return null; }));
        }
        return this.icons.get(pkg);
    }

    /** Sees control messages first; returns true when it consumed one. */
    onControlText(text) {
        if (text.includes('"replaced"')) {
            let msg = null;
            try { msg = JSON.parse(text); } catch (_) {}
            if (msg && msg.type === 'replaced') {
                // The phone moved to a screen opened later. Reconnecting on our own would take it
                // back, and the two screens would keep trading it.
                console.log('[RTC] Another screen took over the phone');
                this.paused = true;
                clearTimeout(this.helloTimer);
                this.closePeer();
                this.handlers.onReplaced();
                return true;
            }
        }
        return this.resolveReply(text);
    }

    /** Reconnect after {@link onControlText} paused for another screen. */
    resume() {
        this.paused = false;
        this.reconnect();
    }

    /** Hands replies to pending requests; returns true when the message was one. */
    resolveReply(text) {
        if (this.waiters.length === 0) return false;
        let msg;
        try { msg = JSON.parse(text); } catch (_) { return false; }
        for (let i = 0; i < this.waiters.length; i++) {
            const value = this.waiters[i].match(msg);
            if (value !== undefined) {
                const [waiter] = this.waiters.splice(i, 1);
                waiter.resolve(value);
                return true;
            }
        }
        return false;
    }
}
