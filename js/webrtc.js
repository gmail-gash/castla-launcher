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
const RTC_NTFY = 'https://ntfy.sh';
const RTC_TOPIC_PREFIX = 'castla-rtc-';
const RTC_CHUNK = 3000;                        // ntfy turns bodies over 4096 bytes into attachments
const RTC_ROOM_PATTERN = /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
const RTC_HELLO_FAST_MS = 5000;                // first minute: the phone may be seconds away
const RTC_HELLO_SLOW_MS = 15000;               // then back off to stay inside ntfy's rate limit
const RTC_HELLO_FAST_COUNT = 12;
const RTC_NEGOTIATION_MS = 10000;              // matches HelloPolicy.NEGOTIATION_WINDOW_MS on the phone
const RTC_REQUEST_TIMEOUT_MS = 15000;

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
    constructor(channel, tap) {
        this.channel = channel;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => this.onopen && this.onopen();
        channel.onclose = () => this.onclose && this.onclose();
        channel.onerror = (e) => this.onerror && this.onerror(e);
        channel.onmessage = (event) => {
            if (tap && typeof event.data === 'string' && tap(event.data)) return;
            if (this.onmessage) this.onmessage(event);
        };
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
     *          onAudioChannel: function(DataChannelSocket), onLost: function()}} handlers
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
        this.icons = new Map();
        this.partial = new Map();
    }

    start() {
        const events = new EventSource(`${RTC_NTFY}/${this.topic}/sse`);
        events.onopen = () => this.scheduleHello(0);
        events.onmessage = (event) => this.onSignal(event.data);
        events.onerror = () => console.warn('[RTC] Signaling stream interrupted — retrying');
    }

    /** Ask the phone for a fresh connection, e.g. after the previous one dropped. */
    reconnect() {
        this.closePeer();
        this.hellos = 0;
        this.scheduleHello(0);
    }

    /* ---------- signaling ---------- */

    scheduleHello(delayMs) {
        clearTimeout(this.helloTimer);
        this.helloTimer = setTimeout(() => {
            if (this.connected) return;
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
            fetch(`${RTC_NTFY}/${this.topic}`, { method: 'POST', body: JSON.stringify(part) })
                .catch((e) => console.warn('[RTC] Publish failed:', e));
        }
    }

    onSignal(data) {
        let part;
        try {
            const event = JSON.parse(data);
            if (event.event && event.event !== 'message') return;
            part = JSON.parse(event.message);
        } catch (_) { return; }
        if (!part || part.from === this.self || typeof part.d !== 'string') return;

        const key = `${part.from}:${part.id}`;
        const parts = this.partial.get(key) || new Array(part.n);
        parts[part.i] = part.d;
        this.partial.set(key, parts);
        if (parts.filter((p) => p !== undefined).length !== part.n) return;
        this.partial.delete(key);

        let msg;
        try { msg = JSON.parse(parts.join('')); } catch (_) { return; }
        if (msg.type !== 'offer' || this.connected) return;
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
        this.closePeer();
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.pc = pc;
        this.offerSdp = sdp;

        pc.ontrack = (event) => this.handlers.onTrack(event.streams[0] || new MediaStream([event.track]));
        pc.ondatachannel = (event) => {
            if (event.channel.label === 'audio') {
                // Same bytes the WebSocket /ws/audio endpoint sends, so AudioPlayer plays it as is.
                this.handlers.onAudioChannel(new DataChannelSocket(event.channel));
            } else {
                this.handlers.onChannel(new DataChannelSocket(event.channel, (text) => this.resolveReply(text)));
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc !== this.pc) return;
            console.log('[RTC] Connection:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                this.connected = true;
                clearTimeout(this.helloTimer);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
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

    /** App icon as a data URL (null when the app has none), fetched once per package. */
    icon(socket, pkg) {
        if (!this.icons.has(pkg)) {
            this.icons.set(pkg, this.request(socket, { type: 'getIcon', pkg },
                (m) => (m.type === 'icon' && m.pkg === pkg) ? (m.png ? `data:image/png;base64,${m.png}` : null) : undefined)
                .catch(() => { this.icons.delete(pkg); return null; }));
        }
        return this.icons.get(pkg);
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
