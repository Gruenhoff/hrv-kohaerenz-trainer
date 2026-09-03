/**
 * Adaptives Training — geschlossene Regelschleife
 *
 * Startet beim gespeicherten Protokoll-1/2-Rhythmus, sammelt 3 Minuten
 * Baseline (Kalibrierung), passt danach pro Zyklus Ein-/Ausatemdauer anhand
 * des HF-Wendepunkt-Timings an (Wendepunkt sollte mit Phasenende
 * zusammenfallen — siehe Herleitung im Chat), mit Ein-Schritt-Sicherheitsnetz
 * über die Zyklus-Amplitude. EDR-Atemtiefe (aus dem rohen EKG) löst bei
 * anhaltend flacher Atmung ein gesprochenes Hinweis-Signal aus — die
 * Pacer-Anpassung selbst bleibt unsichtbar/unangesagt.
 */
import { HRVAnalyzer } from './hrv.js';
import { EcgRPeakDetector, EdrBuffer } from './ecgAnalysis.js';

export class CancelledError extends Error {}

const CALIBRATION_MS      = 3 * 60 * 1000;
const STEP_MS              = 300;
const MAX_DRIFT_FRACTION   = 0.20;
const DIRECTION_WINDOW_MS  = 3000;
const REVERT_DROP_FRACTION = 0.10;   // Amplitude >10% schlechter → letzter Schritt zurück
const EDR_SHALLOW_FRACTION = 0.6;    // < 60% der Kalibrierungs-Baseline gilt als "flach"
const EDR_SHALLOW_STREAK   = 3;      // so viele Zyklen in Folge, bevor Hinweis kommt
const SPEECH_COOLDOWN_MS   = 50000;  // 45–60s Zielkorridor, Mittelwert
const AMPLITUDE_HISTORY_N  = 4;      // Rolling-Fenster für den Amplitude-Vergleich

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export class AdaptiveTraining {
    /**
     * @param {HRVAnalyzer} hrv
     * @param {import('./database.js').Database} db
     * @param {{inhale:number,holdIn:number,exhale:number,holdOut:number}} baseRhythm
     */
    constructor(hrv, db, baseRhythm) {
        this.hrv = hrv;
        this.db = db;
        this.baseRhythm = { ...baseRhythm };
        this.rhythm = { ...baseRhythm };
        this._calibrationMs = CALIBRATION_MS; // als Instanzfeld für Testbarkeit (Konstruktorwert überschreibbar)

        this._bounds = {};
        for (const key of ['inhale', 'holdIn', 'exhale', 'holdOut']) {
            const base = baseRhythm[key] || 0;
            this._bounds[key] = base > 0
                ? [base * (1 - MAX_DRIFT_FRACTION), base * (1 + MAX_DRIFT_FRACTION)]
                : [0, 0]; // keine Halte-Phase im Ausgangsrhythmus → bleibt aus (kein Hinzuerfinden)
        }

        this._active = false;
        this._phaseWaiters = [];

        this.rPeakDetector = new EcgRPeakDetector();
        this.edrBuffer = new EdrBuffer(120000);
        this.rPeakDetector.onRPeak = (ts, amp) => this.edrBuffer.addRPeak(ts, amp);

        this._edrBaseline = null;
        this._edrShallowStreak = 0;
        this._lastSpeechTs = -Infinity;

        this._amplitudeHistory = [];
        this._pending = { inhale: null, exhale: null }; // { prevValue, amplitudeBefore }

        this._summary = {
            adjustments: {
                inhale: { lengthen: 0, shorten: 0, revert: 0 },
                exhale: { lengthen: 0, shorten: 0, revert: 0 },
            },
            speechCues: 0,
            cyclesObserved: 0,
        };

        // Callbacks (von app.js gesetzt)
        this.onRhythmChange    = null; // (rhythm) => void — Pacer (neu) starten
        this.onCalibrationTick = null; // (elapsedMs, totalMs) => void
        this.onCalibrationDone = null; // () => void
        this.onSpeechCue       = null; // (text) => void
        this.onCycleComplete   = null; // (info) => void — für optionale Live-Anzeige/Debug
        this.onComplete        = null; // (summary) => void
        this.onCancelled       = null; // () => void
    }

    get active() { return this._active; }

    async start() {
        this._active = true;
        this.onRhythmChange?.(this.rhythm);
        try {
            await this._calibrationPhase();
            await this._adaptiveLoop();
        } catch (err) {
            this._active = false;
            if (err instanceof CancelledError) { this.onCancelled?.(); return; }
            throw err;
        }
    }

    async stop() {
        this._active = false;
        const waiters = this._phaseWaiters;
        this._phaseWaiters = [];
        waiters.forEach(w => w.reject(new CancelledError()));
        if (this._waitReject) {
            const reject = this._waitReject;
            this._waitReject = null;
            reject(new CancelledError());
        }
        const result = { rhythm: this.rhythm, ...this._summary };
        await this.db.saveAdaptiveTrainingSession(result).catch(() => {});
        this.onComplete?.(result);
    }

    /** Von app.js bei jedem BreathPacer.onPhaseChange aufzurufen */
    notifyPhaseChange(phase) {
        if (!this._phaseWaiters.length) return;
        const evt = { phase, ts: performance.now() };
        const waiters = this._phaseWaiters;
        this._phaseWaiters = [];
        waiters.forEach(w => w.resolve(evt));
    }

    /** Von app.js bei jedem rohen EKG-Sample aufzurufen (PMD-Stream) */
    addEcgSample(uv, tsMs) {
        this.rPeakDetector.addSample(uv, tsMs);
    }

    _nextPhaseEvent() {
        if (!this._active) return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => this._phaseWaiters.push({ resolve, reject }));
    }

    /** Wartet auf den nächsten Wechsel WEG von der aktuellen Phase */
    async _waitPhaseLeave() {
        return this._nextPhaseEvent();
    }

    _wait(ms) {
        if (!this._active) return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => {
            this._waitReject = reject;
            this._waitTimer = setTimeout(() => { this._waitReject = null; resolve(); }, ms);
        });
    }

    // ─── Ein vollständiger Zyklus: Grenzen einsammeln + auswerten ──────────

    /**
     * Wartet auf einen vollständigen Zyklus (Einatmen[-Halt]-Ausatmen[-Halt])
     * und liefert Wendepunkt-Richtungen + Zyklus-Amplitude + EDR-Spannweite.
     *
     * @param {{phase:string,ts:number}|null} knownInhaleStart - das schließende
     *   Ereignis des VORIGEN Zyklus (= öffnendes 'inhale' dieses Zyklus), falls
     *   bekannt. Ohne diese Wiederverwendung würde bei fortlaufendem Aufruf
     *   jeder zweite reale Zyklus übersprungen, weil sonst erneut auf ein
     *   FRISCHES 'inhale' gewartet würde, während der Pacer bereits mitten im
     *   nächsten Zyklus läuft.
     * @returns {object} Zyklusdaten, inkl. `nextInhaleEvt` als Cursor für den
     *   nächsten Aufruf.
     */
    async _observeOneCycle(knownInhaleStart = null) {
        const inhaleStartEvt = knownInhaleStart ?? await this._waitUntilPhase('inhale');
        const inhaleStart = inhaleStartEvt.ts;

        const afterInhale = await this._nextPhaseEvent(); // weg von 'inhale'
        const inhaleEndTs = afterInhale.ts;

        let exhaleStart = inhaleEndTs;
        if (afterInhale.phase === 'holdIn') {
            const afterHoldIn = await this._nextPhaseEvent(); // weg von 'holdIn'
            exhaleStart = afterHoldIn.ts;
        }

        const afterExhale = await this._nextPhaseEvent(); // weg von 'exhale'
        const exhaleEndTs = afterExhale.ts;

        // Cursor fürs nächste Mal: entweder direkt das öffnende 'inhale' des
        // Folgezyklus (afterExhale), oder — falls Halt-Aus existiert — das
        // Ereignis danach.
        let nextInhaleEvt = afterExhale;
        if (afterExhale.phase === 'holdOut') {
            nextInhaleEvt = await this._nextPhaseEvent(); // weg von 'holdOut'
        }

        const inhaleDir = this.hrv.hrDirectionBefore(inhaleEndTs, DIRECTION_WINDOW_MS);
        const exhaleDir = this.hrv.hrDirectionBefore(exhaleEndTs, DIRECTION_WINDOW_MS);
        const amplitude = this.hrv.cycleAmplitude(inhaleStart, inhaleEndTs, exhaleEndTs);
        const edrRange  = this.edrBuffer.amplitudeRangeInWindow(inhaleStart, exhaleEndTs);

        this._summary.cyclesObserved++;
        return { inhaleStart, inhaleEndTs, exhaleStart, exhaleEndTs, inhaleDir, exhaleDir, amplitude, edrRange, nextInhaleEvt };
    }

    async _waitUntilPhase(target) {
        for (;;) {
            const evt = await this._nextPhaseEvent();
            if (evt.phase === target) return evt;
        }
    }

    // ─── Kalibrierungsphase: nur Baseline sammeln, keine Eingriffe ─────────

    async _calibrationPhase() {
        const startTs = performance.now();
        const edrSamples = [];
        const ampSamples = [];
        let cursor = null;

        while (performance.now() - startTs < this._calibrationMs) {
            const cycle = await this._observeOneCycle(cursor);
            cursor = cycle.nextInhaleEvt;
            if (cycle.edrRange !== null) edrSamples.push(cycle.edrRange);
            if (cycle.amplitude !== null && cycle.amplitude > 0) ampSamples.push(cycle.amplitude);
            this.onCalibrationTick?.(performance.now() - startTs, this._calibrationMs);
        }

        this._edrBaseline = edrSamples.length ? edrSamples.reduce((a, b) => a + b, 0) / edrSamples.length : null;
        this._amplitudeHistory = ampSamples.slice(-AMPLITUDE_HISTORY_N);
        this._cursor = cursor; // an die adaptive Schleife übergeben, damit kein Zyklus übersprungen wird
        this.onCalibrationDone?.();
    }

    // ─── Adaptive Hauptschleife ─────────────────────────────────────────────

    async _adaptiveLoop() {
        let cursor = this._cursor ?? null; // nahtlos an die Kalibrierung anschließen
        while (this._active) {
            const cycle = await this._observeOneCycle(cursor);
            cursor = cycle.nextInhaleEvt;

            // 1) Ausstehende Reverts aus der letzten Anpassung prüfen
            const priorAvg = this._rollingAverage();
            for (const phase of ['inhale', 'exhale']) {
                const pending = this._pending[phase];
                if (!pending) continue;
                if (cycle.amplitude !== null && cycle.amplitude > 0 &&
                    cycle.amplitude < pending.amplitudeBefore * (1 - REVERT_DROP_FRACTION)) {
                    this.rhythm[phase] = pending.prevValue;
                    this._summary.adjustments[phase].revert++;
                    this.onRhythmChange?.(this.rhythm);
                }
                this._pending[phase] = null;
            }

            // 2) Neue Wendepunkt-Anpassung für diesen Zyklus
            let rhythmChanged = false;
            rhythmChanged = this._applyDirection('inhale', cycle.inhaleDir, priorAvg, cycle.amplitude) || rhythmChanged;
            rhythmChanged = this._applyDirection('exhale', cycle.exhaleDir, priorAvg, cycle.amplitude) || rhythmChanged;
            if (rhythmChanged) this.onRhythmChange?.(this.rhythm);

            // 3) Amplitude-Historie fortschreiben
            if (cycle.amplitude !== null && cycle.amplitude > 0) {
                this._amplitudeHistory.push(cycle.amplitude);
                if (this._amplitudeHistory.length > AMPLITUDE_HISTORY_N) this._amplitudeHistory.shift();
            }

            // 4) EDR-Atemtiefe prüfen → ggf. Sprach-Hinweis
            this._checkEdrFeedback(cycle.edrRange);

            this.onCycleComplete?.(cycle);
        }
    }

    _rollingAverage() {
        if (!this._amplitudeHistory.length) return null;
        return this._amplitudeHistory.reduce((a, b) => a + b, 0) / this._amplitudeHistory.length;
    }

    /**
     * Wendet bei Bedarf eine ±300ms-Anpassung auf eine Phase an.
     * inhale: 'rising' (steigt noch) → zu kurz → verlängern; 'falling' → zu lang → verkürzen
     * exhale: spiegelbildlich ('falling' → zu kurz → verlängern; 'rising' → zu lang → verkürzen)
     */
    _applyDirection(phase, direction, amplitudeBefore, currentAmplitude) {
        if (!direction || direction === 'flat') return false;
        if (this._bounds[phase][1] <= 0) return false; // keine Halte-/Phasen-Dauer vorhanden (nur inhale/exhale betroffen, immer >0)

        const tooShort = phase === 'inhale' ? direction === 'rising' : direction === 'falling';
        const delta = tooShort ? STEP_MS : -STEP_MS;

        const prevValue = this.rhythm[phase];
        const [min, max] = this._bounds[phase];
        const nextValue = clamp(prevValue + delta, min, max);
        if (nextValue === prevValue) return false; // an der Sicherheitsgrenze angekommen

        this.rhythm[phase] = nextValue;
        this._summary.adjustments[phase][tooShort ? 'lengthen' : 'shorten']++;
        this._pending[phase] = { prevValue, amplitudeBefore: amplitudeBefore ?? currentAmplitude ?? 0 };
        return true;
    }

    _checkEdrFeedback(edrRange) {
        if (this._edrBaseline === null || edrRange === null) return; // Signal zu unsicher/fehlt → keine EDR-Hinweise
        const isShallow = edrRange < this._edrBaseline * EDR_SHALLOW_FRACTION;
        this._edrShallowStreak = isShallow ? this._edrShallowStreak + 1 : 0;

        if (this._edrShallowStreak < EDR_SHALLOW_STREAK) return;
        const now = performance.now();
        if (now - this._lastSpeechTs < SPEECH_COOLDOWN_MS) return;

        this._lastSpeechTs = now;
        this._edrShallowStreak = 0;
        this._summary.speechCues++;
        this.onSpeechCue?.('Versuch etwas tiefer zu atmen.');
    }
}
