/**
 * Sprachausgabe für Adaptives Training (Web Speech API).
 * Nur für Ausführungs-Hinweise gedacht, die aktives Handeln erfordern —
 * die automatische Pacer-Anpassung selbst bleibt stumm (siehe adaptiveTraining.js).
 */
export class SpeechCoach {
    constructor() {
        this.enabled = typeof window !== 'undefined' && 'speechSynthesis' in window;
        this._voice = null;

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
        window.speechSynthesis.cancel(); // evtl. hängende vorige Ansage abbrechen
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'de-DE';
        if (this._voice) utter.voice = this._voice;
        utter.rate = 0.95;
        utter.onstart = () => this.onSpeechStart?.();
        utter.onend   = () => this.onSpeechEnd?.();
        utter.onerror = () => this.onSpeechEnd?.();
        window.speechSynthesis.speak(utter);
    }

    stop() {
        if (this.enabled) window.speechSynthesis.cancel();
    }
}
