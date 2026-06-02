/**
 * Coaching-Engine für Phase 3 Selbsterzeugung
 *
 * Zustandsautomat: warmup → low → building → approaching → coherent → lost
 * Gibt bei jedem update()-Aufruf { state, message } zurück.
 * message === null in 'coherent' → UI zeigt Stille + Glow.
 *
 * Hysterese:
 *   Kohärenz erreicht bei ≥ 75%, verloren bei < 60%.
 *   Nachrichten rotieren alle 10 Sekunden.
 */

const MSG = {
    warmup: [
        "Atme gleichmäßig — Daten werden gesammelt...",
    ],
    low: [
        "Atme tief in den Bauch — lass die Brust los",
        "Verlangsame deinen Atem: länger ein, länger aus",
        "Lass Schultern und Kiefer fallen",
        "Weicher Bauch, tiefer ruhiger Atem",
        "Kein Druck — lass den Atem von selbst kommen",
        "Stell dir vor, wie der Bauch sich hebt und senkt",
    ],
    building: [
        "Gut — bleib in diesem Rhythmus",
        "Die Welle wächst ✓",
        "Gleichmäßig weiter — lass nichts anspannen",
        "Lass den Atem fließen, Schlag für Schlag",
    ],
    approaching: [
        "Fast da — atme ganz ruhig weiter",
        "Spür die Welle — bleib dran",
        "Sehr gut ✓ — halte diesen Fluss",
        "Tief und weich — du bist nah dran",
    ],
    coherent: null,
    lost: [
        "Sanft zurück — ein neuer tiefer Atemzug",
        "Nicht aufgeben — gleichmäßig weiter atmen",
        "Lass los und atme neu — du findest es wieder",
        "Schultern locker lassen, Atem wird ruhiger",
    ],
};

const ROTATE_MS = 10_000;

export class CoachingEngine {
    constructor() {
        this._state       = 'warmup';
        this._msgIdx      = 0;
        this._lastRotate  = Date.now();
    }

    /**
     * @param {number} score         0–100 Kohärenz
     * @param {number} dataSpanSec   Sekunden verfügbarer HRV-Daten
     * @returns {{ state: string, message: string|null }}
     */
    update(score, dataSpanSec) {
        const next = this._nextState(score, dataSpanSec);

        if (next !== this._state) {
            this._state      = next;
            this._msgIdx     = 0;
            this._lastRotate = Date.now();
        } else {
            const msgs = MSG[this._state];
            if (msgs && msgs.length > 1 && Date.now() - this._lastRotate >= ROTATE_MS) {
                this._msgIdx     = (this._msgIdx + 1) % msgs.length;
                this._lastRotate = Date.now();
            }
        }

        return this._result();
    }

    _nextState(score, dataSpanSec) {
        if (dataSpanSec < 30) return 'warmup';

        // Hysterese: einmal in Kohärenz → erst bei < 60% verlieren
        if (this._state === 'coherent' && score < 60) return 'lost';
        if (score >= 75) return 'coherent';
        if (score >= 65) return 'approaching';
        if (score >= 35) return 'building';
        return 'low';
    }

    _result() {
        const msgs = MSG[this._state];
        return {
            state:   this._state,
            message: msgs ? msgs[this._msgIdx] : null,
        };
    }

    reset() {
        this._state      = 'warmup';
        this._msgIdx     = 0;
        this._lastRotate = Date.now();
    }
}
