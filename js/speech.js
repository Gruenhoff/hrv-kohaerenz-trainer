/**
 * Sprachausgabe für Adaptives Training (Web Speech API).
 * Nur für Ausführungs-Hinweise gedacht, die aktives Handeln erfordern —
 * die automatische Pacer-Anpassung selbst bleibt stumm (siehe adaptiveTraining.js).
 */

// Falls weder 'end' noch 'error' feuern (z.B. Android tötet die TTS-Engine im
// Hintergrund), Sonifikation nach dieser Zeit trotzdem wieder freigeben statt
// dauerhaft stumm zu bleiben. Großzügig bemessen für kurze deutsche Sätze.
const SPEECH_WATCHDOG_MS = 10000;

export class SpeechCoach {
    constructor() {
        this.enabled = typeof window !== 'undefined' && 'speechSynthesis' in window;
        this._voice = null;
        this._finish = null; // aktive Aufräum-Funktion der laufenden Ansage, falls eine läuft

        this.onSpeechStart = null; // () => void — z.B. Sonifikation pausieren
        this.onSpeechEnd   = null; // () => void — z.B. Sonifikation fortsetzen

        if (this.enabled) this._loadVoice();
    }

    _loadVoice() {
        const pick = () => {
            const voices = window.speechSynthesis.getVoices();
            this._voice = voices.find(v => v.lang === 'de-DE')
                || voices.find(v => v.lang?.startsWith('de'))
                || null;
        };
        pick();
        if (!this._voice && 'onvoiceschanged' in window.speechSynthesis) {
            window.speechSynthesis.addEventListener('voiceschanged', pick, { once: true });
        }
    }

    speak(text) {
        if (!this.enabled) return;
        if (this._finish) this._finish(); // evtl. noch laufende vorige Ansage sauber abschließen
        window.speechSynthesis.cancel();

        // Sofort auslösen, nicht erst bei utter.onstart — zwischen speak() und dem
        // tatsächlichen Tonbeginn liegt TTS-Engine-Anlaufzeit, in der sich sonst die
        // Sonifikation noch mit dem Sprachbeginn überlagern könnte.
        this.onSpeechStart?.();

        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'de-DE';
        if (this._voice) utter.voice = this._voice;
        utter.rate = 0.95;

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(watchdog);
            if (this._finish === finish) this._finish = null;
            this.onSpeechEnd?.();
        };
        this._finish = finish;
        const watchdog = setTimeout(finish, SPEECH_WATCHDOG_MS);

        utter.onend   = finish;
        utter.onerror = finish;
        window.speechSynthesis.speak(utter);
    }

    stop() {
        if (this.enabled) window.speechSynthesis.cancel();
        if (this._finish) this._finish(); // cancel() garantiert onend/onerror nicht überall
    }
}
