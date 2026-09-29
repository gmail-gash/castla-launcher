/**
 * On-screen keyboard for text fields on the phone.
 *
 * The phone's own keyboard cannot appear on the mirrored screen (Android 12 only allows that on
 * trusted displays), and a desktop browser has no keyboard of its own on screen. This one types
 * into the input bubble; the bubble sends the text to the phone as before.
 */

// ── Hangul (두벌식) composition ─────────────────────────────────────────────

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const VOWEL_PAIRS = { 'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ' };
const FINAL_PAIRS = {
    'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ',
    'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ',
};
const splitPair = (table, jamo) => {
    for (const [pair, joined] of Object.entries(table)) if (joined === jamo) return [...pair];
    return null;
};

class HangulComposer {
    constructor() { this.set(''); }

    /** Replace the text, e.g. after it was edited with a real keyboard. */
    set(text) {
        this.done = text;
        this.cho = this.jung = this.jong = '';
    }

    text() { return this.done + this.syllable(); }

    syllable() {
        const { cho, jung, jong } = this;
        if (cho && jung) {
            return String.fromCharCode(0xAC00 + (CHO.indexOf(cho) * 21 + JUNG.indexOf(jung)) * 28 + JONG.indexOf(jong));
        }
        return cho || jung;
    }

    commit() {
        this.done += this.syllable();
        this.cho = this.jung = this.jong = '';
    }

    input(ch) {
        if (JUNG.includes(ch)) return this.vowel(ch);
        if (CHO.includes(ch) || JONG.includes(ch)) return this.consonant(ch);
        this.commit();
        this.done += ch;
    }

    consonant(c) {
        if (this.cho && this.jung && !this.jong && JONG.includes(c)) { this.jong = c; return; }
        if (this.jong && FINAL_PAIRS[this.jong + c]) { this.jong = FINAL_PAIRS[this.jong + c]; return; }
        this.commit();
        this.cho = c;
    }

    vowel(v) {
        if (this.jong) {
            // The final consonant starts the next syllable: 닭 + ㅣ → 달기.
            const pair = splitPair(FINAL_PAIRS, this.jong);
            const next = pair ? pair[1] : this.jong;
            this.jong = pair ? pair[0] : '';
            this.commit();
            this.cho = next;
            this.jung = v;
            return;
        }
        if (this.jung && VOWEL_PAIRS[this.jung + v]) { this.jung = VOWEL_PAIRS[this.jung + v]; return; }
        if (this.cho && !this.jung) { this.jung = v; return; }
        this.commit();
        this.jung = v;
    }

    /** Undo one jamo of the syllable in progress, or delete the last character. */
    backspace() {
        if (this.jong) { const p = splitPair(FINAL_PAIRS, this.jong); this.jong = p ? p[0] : ''; return; }
        if (this.jung) { const p = splitPair(VOWEL_PAIRS, this.jung); this.jung = p ? p[0] : ''; return; }
        if (this.cho) { this.cho = ''; return; }
        this.done = [...this.done].slice(0, -1).join('');
    }
}

// ── Keyboard ────────────────────────────────────────────────────────────────

const KEY_LAYOUTS = {
    ko: [
        ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅐ', 'ㅔ'],
        ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
        ['⇧', 'ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ', '⌫'],
    ],
    koShift: [
        ['ㅃ', 'ㅉ', 'ㄸ', 'ㄲ', 'ㅆ', 'ㅛ', 'ㅕ', 'ㅑ', 'ㅒ', 'ㅖ'],
        ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
        ['⇧', 'ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ', '⌫'],
    ],
    en: [
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
        ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
    ],
    sym: [
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
        ['@', '#', '$', '%', '&', '-', '+', '(', ')', '/'],
        ['*', '"', "'", ':', ';', '!', '?', ',', '⌫'],
    ],
};

class OnScreenKeyboard {
    /**
     * @param {HTMLInputElement} field the input the keys type into
     * @param {{onEnter: function(), onEmptyBackspace: function(), onHide: function()}} actions
     */
    constructor(field, actions) {
        this.field = field;
        this.actions = actions;
        this.composer = new HangulComposer();
        this.lang = 'ko';
        this.shift = false;
        this.symbols = false;
        this.el = document.createElement('div');
        this.el.id = 'onscreen-keyboard';
        document.body.appendChild(this.el);
        // Keys must not reach the video underneath, which would tap the phone.
        for (const type of ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend', 'touchmove', 'mousedown', 'mouseup', 'click']) {
            this.el.addEventListener(type, (e) => e.stopPropagation());
        }
        // Pressing a key must not take focus from the field (a real keyboard still types there).
        this.el.addEventListener('pointerdown', (e) => e.preventDefault());
        // Typing on a real keyboard edits the field directly; start composing from its text.
        field.addEventListener('input', () => { if (!this.typing) this.composer.set(field.value); });
        this.render();
    }

    get visible() { return this.el.classList.contains('visible'); }

    show() {
        this.composer.set(this.field.value);
        this.field.inputMode = 'none';   // no system keyboard on top of this one
        this.el.classList.add('visible');
    }

    hide() {
        this.el.classList.remove('visible');
        this.field.inputMode = 'text';
    }

    height() { return this.visible ? this.el.offsetHeight : 0; }

    /** Forget the text, e.g. after it was sent. */
    reset() { this.composer.set(''); }

    render() {
        const layout = this.symbols ? KEY_LAYOUTS.sym
            : this.lang === 'ko' ? (this.shift ? KEY_LAYOUTS.koShift : KEY_LAYOUTS.ko)
            : KEY_LAYOUTS.en;
        const rows = layout.map((row) => row.map((k) => this.keyHtml(k)).join(''));
        rows.push([
            this.keyHtml(this.symbols ? (this.lang === 'ko' ? '가' : 'ABC') : '123', 'mode', 'wide'),
            this.keyHtml(this.lang === 'ko' ? 'EN' : '한', 'lang'),
            this.keyHtml('space', 'space', 'space'),
            this.keyHtml('.'),
            this.keyHtml('입력', 'enter', 'wide accent'),
            this.keyHtml('▼', 'hide'),
        ].join(''));
        this.el.innerHTML = rows.map((r) => `<div class="osk-row">${r}</div>`).join('');
        this.el.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => {
            e.preventDefault();
            this.press(b.dataset.action, b.dataset.key);
        }));
    }

    keyHtml(label, action = 'char', cls = '') {
        const isShift = label === '⇧';
        const act = isShift ? 'shift' : label === '⌫' ? 'backspace' : action;
        const shown = this.lang === 'en' && this.shift && act === 'char' && !this.symbols ? label.toUpperCase() : label;
        const active = isShift && this.shift ? ' active' : '';
        const key = shown.replace(/"/g, '&quot;');
        return `<button type="button" class="osk-key ${cls}${active}" data-action="${act}" data-key="${key}">${shown === 'space' ? '' : shown}</button>`;
    }

    press(action, key) {
        switch (action) {
            case 'char': this.type(key); if (this.shift) { this.shift = false; this.render(); } return;
            case 'space': this.type(' '); return;
            case 'backspace':
                if (this.composer.text() === '') { this.actions.onEmptyBackspace(); return; }
                this.edit(() => this.composer.backspace());
                return;
            case 'shift': this.shift = !this.shift; this.render(); return;
            case 'lang': this.lang = this.lang === 'ko' ? 'en' : 'ko'; this.shift = false; this.symbols = false; this.render(); return;
            case 'mode': this.symbols = !this.symbols; this.shift = false; this.render(); return;
            case 'enter': this.actions.onEnter(); return;
            case 'hide': this.actions.onHide(); return;
        }
    }

    type(ch) { this.edit(() => this.composer.input(ch)); }

    edit(change) {
        change();
        this.typing = true;
        this.field.value = this.composer.text();
        this.field.dispatchEvent(new Event('input'));
        this.typing = false;
    }
}

if (typeof module !== 'undefined') module.exports = { HangulComposer };
