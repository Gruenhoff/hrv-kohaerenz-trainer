/**
 * Zone 2 Controller – DFA-alpha1 basierte Schwellenwert-Ermittlung
 *
 * Zwei Modi:
 *   • Feldtest   – läuft im Hintergrund während des normalen Trainings
 *   • Stufentest – geführter 18-Min-Inkrementaltest (6 × 3 Min)
 */

import { computeAlpha1 } from './dfa.js';

const WARMUP_MS        = 10 * 60 * 1000;  // 10 Minuten Einlaufzeit (Feldtest)
const SAMPLE_INTERVAL  = 30 * 1000;       // Sample alle 30 Sekunden
const HR_WINDOW_FELD   = 120;             // Rollendes 2-Min-HR-Fenster (Feldtest)
const HR_WINDOW_STUFEN = 60;             // 1-Min-Fenster im Stufentest
const ALPHA1_BUFFER    = 128;             // Letzte n RR für alpha1
const RR_MAX_BUF       = 300;             // Gesamtpuffer
const ALPHA1_THRESH    = 0.75;            // VT1 / Zone-2-Grenze
const ALPHA1_VT2       = 0.50;            // VT2 – Frühstopp Stufentest

export const STUFEN = [
    { name: 'Sehr leicht', durationSec: 180 },
    { name: 'Leicht',      durationSec: 180 },
    { name: 'Moderat',     durationSec: 180 },
    { name: 'Mittel',      durationSec: 180 },
    { name: 'Erhöht',      durationSec: 180 },
    { name: 'Hoch',        durationSec: 180 },
];

export class Zone2 {
    /**
     * @param {import('./database.js').Database} db
     */
    constructor(db) {
        this.db = db;

        // Gemeinsamer rollierender RR-Puffer
        this._rrBuf = [];   // RR-Werte in ms
        this._rrTs  = [];   // Timestamps (Date.now())

        // ── Feldtest ─────────────────────────────────────────────────────────
        this._feldActive    = false;
        this._feldStart     = null;
        this._feldWarmTimer = null;  // einmaliger Timeout für Warmup
        this._feldSamTimer  = null;  // Interval für Samples
        this._feldSamples   = [];    // [{ time, avgHR, alpha1 }]
        this._feldThreshHR  = null;  // interpolierter Zone-2-Puls

        // ── Stufentest ───────────────────────────────────────────────────────
        this._stufenActive      = false;
        this._stufenStage       = 0;
        this._stufenStart       = null;    // Startzeit des Gesamttests
        this._stufenStageStart  = null;    // Startzeit der aktuellen Stufe
        this._stufenStageTimer  = null;    // Timeout zum Stufen-Wechsel
        this._stufenSamTimer    = null;    // Interval für Samples
        this._stufenSamples     = [];      // [{ stage, stageName, avgHR, alpha1 }]

        // Callbacks (werden von app.js gesetzt)
        /** @type {function(sample[], number|null): void} */
        this.onFeldUpdate   = null;  // (samples, threshHR)
        /** @type {function(number, object[], number|null, number|null): void} */
        this.onStufenUpdate = null;  // (stageIdx, samples, alpha1, avgHR)
        /** @type {function(object[], number|null): void} */
        this.onStufenEnd    = null;  // (samples, threshHR)
    }

    // ─── RR-Daten empfangen ──────────────────────────────────────────────────

    addRR(rrMs) {
        this._rrBuf.push(rrMs);
        this._rrTs.push(Date.now());
        if (this._rrBuf.length > RR_MAX_BUF) {
            this._rrBuf.shift();
            this._rrTs.shift();
        }
    }

    // ─── Berechnungen ────────────────────────────────────────────────────────

    getAlpha1() {
        const buf = this._rrBuf.length > ALPHA1_BUFFER
            ? this._rrBuf.slice(-ALPHA1_BUFFER)
            : this._rrBuf;
        return computeAlpha1(buf);
    }

    /** Rollendes HR-Fenster (windowSec Sekunden, Standard 120 s) */
    getAvgHR(windowSec = HR_WINDOW_FELD) {
        const cutoff = Date.now() - windowSec * 1000;
        const recent = [];
        for (let i = this._rrTs.length - 1; i >= 0; i--) {
            if (this._rrTs[i] < cutoff) break;
            recent.unshift(this._rrBuf[i]);
        }
        if (recent.length === 0) return null;
        const avgRR = recent.reduce((a, b) => a + b, 0) / recent.length;
        return Math.round(60000 / avgRR);
    }

    // ─── Feldtest ────────────────────────────────────────────────────────────

    startFeldTestSession() {
        if (this._feldActive) return;
        this._feldActive   = true;
        this._feldStart    = Date.now();
        this._feldSamples  = [];
        this._feldThreshHR = null;

        // Nach Warmup-Zeit mit Sampling beginnen
        this._feldWarmTimer = setTimeout(() => {
            this._feldSampleTick();  // sofort einen ersten Sample nehmen
            this._feldSamTimer = setInterval(
                () => this._feldSampleTick(), SAMPLE_INTERVAL
            );
        }, WARMUP_MS);
    }

    stopFeldTestSession() {
        if (!this._feldActive) return;
        this._feldActive = false;
        clearTimeout(this._feldWarmTimer);
        clearInterval(this._feldSamTimer);
        this._feldWarmTimer = null;
        this._feldSamTimer  = null;

        if (this._feldSamples.length >= 3) {
            this.db.saveZone2Result({
                type:     'feldtest',
                date:     new Date().toISOString(),
                samples:  this._feldSamples,
                threshHR: this._feldThreshHR,
            }).catch(() => {});
        }
    }

    _feldSampleTick() {
        const alpha1 = this.getAlpha1();
        const avgHR  = this.getAvgHR(HR_WINDOW_FELD);
        if (alpha1 === null || avgHR === null) return;

        const elapsed = Math.round((Date.now() - this._feldStart) / 1000);
        this._feldSamples.push({ time: elapsed, avgHR, alpha1 });

        this._detectThreshold(this._feldSamples, (hr) => { this._feldThreshHR = hr; });

        if (this.onFeldUpdate) this.onFeldUpdate(this._feldSamples, this._feldThreshHR);
    }

    /** Interpoliere den HR-Wert bei alpha1 = 0.75 */
    _detectThreshold(samples, setter) {
        for (let i = 1; i < samples.length; i++) {
            const a = samples[i - 1], b = samples[i];
            if ((a.alpha1 >= ALPHA1_THRESH && b.alpha1 < ALPHA1_THRESH) ||
                (a.alpha1 < ALPHA1_THRESH  && b.alpha1 >= ALPHA1_THRESH)) {
                const t  = (ALPHA1_THRESH - a.alpha1) / (b.alpha1 - a.alpha1);
                setter(Math.round(a.avgHR + t * (b.avgHR - a.avgHR)));
                return;
            }
        }
        // Wenn alpha1 durchgehend ≥ 0.75: noch in Zone 2
        const last = samples[samples.length - 1];
        if (last && last.alpha1 >= ALPHA1_THRESH) setter(null);
    }

    // Getter für UI
    get feldActive()        { return this._feldActive; }
    get feldSamples()       { return this._feldSamples; }
    get feldThreshHR()      { return this._feldThreshHR; }
    get feldElapsedSec()    { return this._feldStart ? Math.round((Date.now() - this._feldStart) / 1000) : 0; }
    get feldWarmupSec()     { return WARMUP_MS / 1000; }
    get feldWarmupActive()  { return this._feldActive && this.feldElapsedSec < this.feldWarmupSec; }

    // ─── Stufentest ──────────────────────────────────────────────────────────

    startStufenTest() {
        if (this._stufenActive) return;
        this._stufenActive  = true;
        this._stufenSamples = [];
        this._stufenStart   = Date.now();
        this._advanceStage(0);
    }

    stopStufenTest() {
        this._stufenActive = false;
        clearTimeout(this._stufenStageTimer);
        clearInterval(this._stufenSamTimer);
        this._stufenStageTimer = null;
        this._stufenSamTimer   = null;
    }

    _advanceStage(idx) {
        if (!this._stufenActive) return;
        if (idx >= STUFEN.length) {
            this._finishStufenTest();
            return;
        }

        this._stufenStage      = idx;
        this._stufenStageStart = Date.now();
        const stage = STUFEN[idx];

        // Sampling alle 30 s
        clearInterval(this._stufenSamTimer);
        this._stufenSamTimer = setInterval(() => this._stufenSampleTick(), SAMPLE_INTERVAL);

        // Stufen-Wechsel nach stageDurationSec
        clearTimeout(this._stufenStageTimer);
        this._stufenStageTimer = setTimeout(() => {
            clearInterval(this._stufenSamTimer);
            this._advanceStage(idx + 1);
        }, stage.durationSec * 1000);

        // Sofort UI updaten (neue Stufe)
        if (this.onStufenUpdate) {
            this.onStufenUpdate(idx, this._stufenSamples, this.getAlpha1(), this.getAvgHR(HR_WINDOW_STUFEN));
        }
    }

    _stufenSampleTick() {
        if (!this._stufenActive) return;
        const alpha1 = this.getAlpha1();
        const avgHR  = this.getAvgHR(HR_WINDOW_STUFEN);

        if (alpha1 !== null && avgHR !== null) {
            this._stufenSamples.push({
                stage:     this._stufenStage,
                stageName: STUFEN[this._stufenStage].name,
                avgHR,
                alpha1,
            });

            // Frühstopp bei VT2 (alpha1 < 0.50)
            if (alpha1 < ALPHA1_VT2) {
                this.stopStufenTest();
                this._finishStufenTest();
                return;
            }
        }

        if (this.onStufenUpdate) {
            this.onStufenUpdate(this._stufenStage, this._stufenSamples, alpha1, avgHR);
        }
    }

    _finishStufenTest() {
        this._stufenActive = false;
        clearTimeout(this._stufenStageTimer);
        clearInterval(this._stufenSamTimer);

        const threshHR = this._computeStufenThreshold();

        if (this._stufenSamples.length >= 3) {
            this.db.saveZone2Result({
                type:     'stufentest',
                date:     new Date().toISOString(),
                samples:  this._stufenSamples,
                threshHR,
            }).catch(() => {});
        }

        if (this.onStufenEnd) this.onStufenEnd(this._stufenSamples, threshHR);
    }

    _computeStufenThreshold() {
        const s = this._stufenSamples;
        if (s.length < 2) return null;
        let threshHR = null;
        this._detectThreshold(s, (hr) => { threshHR = hr; });
        // Fallback: letzter Wert war noch ≥ 0.75 → dieser Puls ist noch Zone 2
        if (threshHR === null) {
            const last = s[s.length - 1];
            if (last && last.alpha1 >= ALPHA1_THRESH) threshHR = last.avgHR;
        }
        return threshHR;
    }

    // Getter für UI
    get stufenActive()   { return this._stufenActive; }
    get stufenStage()    { return this._stufenStage; }
    get stufenSamples()  { return this._stufenSamples; }
    get stufenStages()   { return STUFEN; }

    get stufenStageRemainingMs() {
        if (!this._stufenStageStart || !this._stufenActive) return 0;
        const elapsed = Date.now() - this._stufenStageStart;
        return Math.max(0, STUFEN[this._stufenStage].durationSec * 1000 - elapsed);
    }

    get stufenTotalRemainingMs() {
        if (!this._stufenStart || !this._stufenActive) return 0;
        const total   = STUFEN.reduce((s, st) => s + st.durationSec, 0) * 1000;
        const elapsed = Date.now() - this._stufenStart;
        return Math.max(0, total - elapsed);
    }

    /** Letzte Zone-2-Ergebnisse aus der DB laden */
    async getLastResults(limit = 5) {
        return this.db.getZone2Results(limit);
    }
}
