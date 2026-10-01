/* Load app code only after the public bootstrap has replaced itself with phone HTML. */
(function () {
    const load = () => {
        const scripts = [
            'decoder.js', 'mse-decoder.js', 'renderer.js', 'frame-pacer.js', 'touch.js',
            'audio.js', 'fallback.js', 'webrtc.js', 'keyboard.js', 'main.js'
        ];
        let index = 0;
        const next = () => {
            if (index >= scripts.length) return;
            const script = document.createElement('script');
            script.src = `js/${scripts[index++]}?v=unreach-20261001`;
            script.onload = next;
            script.onerror = () => console.error('[Castla] Failed to load', script.src);
            document.body.appendChild(script);
        };
        next();
    };

    if (window.CASTLA_HTTP_BOOTSTRAP && !window.CASTLA_PHONE_HTML_READY) {
        window.addEventListener('castla:phone-html-ready', load, { once: true });
    } else {
        load();
    }
})();
