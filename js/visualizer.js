/**
 * Echtzeit-Visualisierungs-Modul (Canvas)
 * Zeigt RR-Intervall-Kurve und optionales FFT-Spektrum
 */

export class RRVisualizer {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.rrData = [];          // Letzte N RR-Werte (ms)
        this.maxPoints = 120;      // Anzahl angezeigter Punkte
        this.coherenceScore = 0;   // 0-100
        this.animFrame = null;
        this.isRunning = false;

        // Resize-Observer
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas.parentElement || canvas);
        this._resize();
    }

    _resize() {
        const parent = this.canvas.parentElement;
        if (parent) {
            this.canvas.width  = parent.clientWidth;
            this.canvas.height = parent.clientHeight || 180;
        }
    }

    /**
     * Neuen RR-Wert hinzufügen
     * @param {number} rrMs
     */
    addRR(rrMs) {
        this.rrData.push(rrMs);
        if (this.rrData.length > this.maxPoints) this.rrData.shift();
    }

    /**
     * Kohärenz-Score aktualisieren (0-100)
     */
    setCoherence(score) {
        this.coherenceScore = Math.max(0, Math.min(100, score));
    }

    /**
     * Visualisierung starten
     */
    start() {
        this.isRunning = true;
        this._loop();
    }

    /**
     * Visualisierung stoppen
     */
    stop() {
        this.isRunning = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
    }

    /**
     * Render-Loop
     */
    _loop() {
        if (!this.isRunning) return;
        this._draw();
        this.animFrame = requestAnimationFrame(() => this._loop());
    }

    /**
     * Aktuelle Farbe basierend auf Kohärenz-Score
     */
    _coherenceColor(score = this.coherenceScore, alpha = 1) {
        let r, g, b;
        if (score < 30) {
            // Rot
            r = 255; g = 68; b = 68;
        } else if (score < 50) {
            // Orange
            const t = (score - 30) / 20;
            r = 255; g = Math.round(68 + t * (136 - 68)); b = 0;
        } else if (score < 70) {
            // Gelb
            const t = (score - 50) / 20;
            r = 255; g = Math.round(136 + t * (119)); b = 0;
        } else if (score < 85) {
            // Grün
            const t = (score - 70) / 15;
            r = Math.round(255 - t * (255 - 68)); g = 221; b = Math.round(t * 136);
        } else {
            // Türkis
            const t = (score - 85) / 15;
            r = Math.round(68 - t * 68); g = Math.round(221 - t * (221 - 212)); b = Math.round(136 + t * (255 - 136));
        }
        return alpha < 1
            ? `rgba(${r},${g},${b},${alpha})`
            : `rgb(${r},${g},${b})`;
    }

    /**
     * Canvas zeichnen
     */
    _draw() {
        const { canvas, ctx } = this;
        const W = canvas.width;
        const H = canvas.height;

        ctx.clearRect(0, 0, W, H);

        // Hintergrund
        ctx.fillStyle = 'rgba(8, 17, 31, 0.0)'; // Transparent (CSS-Hintergrund)
        ctx.fillRect(0, 0, W, H);

        if (this.rrData.length < 2) {
            // Warte-Animation: gepunktete Linie
            ctx.strokeStyle = 'rgba(0, 212, 255, 0.2)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 8]);
            ctx.beginPath();
            ctx.moveTo(0, H / 2);
            ctx.lineTo(W, H / 2);
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        // Min/Max für Skalierung
        const min = Math.min(...this.rrData) - 20;
        const max = Math.max(...this.rrData) + 20;
        const range = Math.max(max - min, 100); // Mindest-Range: 100ms

        const toY = (rr) => H - ((rr - min) / range) * H * 0.85 - H * 0.075;

        const stepX = W / (this.maxPoints - 1);
        const offsetX = (this.maxPoints - this.rrData.length) * stepX;

        // Gradient basierend auf Kohärenz
        const gradient = ctx.createLinearGradient(0, 0, W, 0);
        gradient.addColorStop(0, this._coherenceColor(this.coherenceScore, 0.3));
        gradient.addColorStop(1, this._coherenceColor(this.coherenceScore, 1.0));

        // Füllbereich unter Linie
        ctx.beginPath();
        ctx.moveTo(offsetX, toY(this.rrData[0]));
        for (let i = 1; i < this.rrData.length; i++) {
            const x = offsetX + i * stepX;
            const y = toY(this.rrData[i]);
            const px = offsetX + (i - 1) * stepX;
            const py = toY(this.rrData[i - 1]);
            const cpx = (px + x) / 2;
            ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
        }
        ctx.lineTo(offsetX + (this.rrData.length - 1) * stepX, H);
        ctx.lineTo(offsetX, H);
        ctx.closePath();

        const fillGradient = ctx.createLinearGradient(0, 0, 0, H);
        fillGradient.addColorStop(0, this._coherenceColor(this.coherenceScore, 0.25));
        fillGradient.addColorStop(1, this._coherenceColor(this.coherenceScore, 0.0));
        ctx.fillStyle = fillGradient;
        ctx.fill();

        // Hauptlinie
        ctx.beginPath();
        ctx.moveTo(offsetX, toY(this.rrData[0]));
        for (let i = 1; i < this.rrData.length; i++) {
            const x = offsetX + i * stepX;
            const y = toY(this.rrData[i]);
            const px = offsetX + (i - 1) * stepX;
            const py = toY(this.rrData[i - 1]);
            const cpx = (px + x) / 2;
            ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
        }
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Leuchteffekt bei hoher Kohärenz
        if (this.coherenceScore > 70) {
            ctx.save();
            ctx.shadowColor = this._coherenceColor();
            ctx.shadowBlur = 12 + (this.coherenceScore - 70) * 0.5;
            ctx.beginPath();
            ctx.moveTo(offsetX, toY(this.rrData[0]));
            for (let i = 1; i < this.rrData.length; i++) {
                const x = offsetX + i * stepX;
                const y = toY(this.rrData[i]);
                const px = offsetX + (i - 1) * stepX;
                const py = toY(this.rrData[i - 1]);
                const cpx = (px + x) / 2;
                ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
            }
            ctx.strokeStyle = this._coherenceColor(this.coherenceScore, 0.6);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
        }
    }

    destroy() {
        this.stop();
        this._resizeObserver.disconnect();
    }
}

// ─── FFT-Spektrum-Visualisierung ─────────────────────────────────────────────

export class SpectrumVisualizer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.frequencies = [];
        this.power = [];
        this.resonanceFreq = 0.1;

        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas.parentElement || canvas);
        this._resize();
    }

    _resize() {
        const parent = this.canvas.parentElement;
        if (parent) {
            this.canvas.width  = parent.clientWidth;
            this.canvas.height = parent.clientHeight || 120;
        }
    }

    update(frequencies, power, resonanceFreq) {
        this.frequencies = frequencies;
        this.power = power;
        this.resonanceFreq = resonanceFreq;
        this._draw();
    }

    _draw() {
        const { canvas, ctx } = this;
        const W = canvas.width;
        const H = canvas.height;

        ctx.clearRect(0, 0, W, H);

        if (!this.frequencies.length) return;

        // Nur 0–0.5 Hz anzeigen
        const maxFreq = 0.5;
        const maxPower = Math.max(...this.power.slice(0, 50)) * 1.1;

        const toX = (f) => (f / maxFreq) * W;
        const toY = (p) => H - (p / maxPower) * H * 0.9;

        // LF-Band Bereich
        ctx.fillStyle = 'rgba(0, 212, 255, 0.06)';
        ctx.fillRect(toX(0.04), 0, toX(0.15) - toX(0.04), H);

        // HF-Band Bereich
        ctx.fillStyle = 'rgba(201, 168, 76, 0.04)';
        ctx.fillRect(toX(0.15), 0, toX(0.4) - toX(0.15), H);

        // Spektrum zeichnen
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < this.frequencies.length; i++) {
            if (this.frequencies[i] > maxFreq) break;
            const x = toX(this.frequencies[i]);
            const y = toY(this.power[i]);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Resonanzfrequenz-Markierung
        const rx = toX(this.resonanceFreq);
        ctx.strokeStyle = 'rgba(201, 168, 76, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(rx, 0);
        ctx.lineTo(rx, H);
        ctx.stroke();
        ctx.setLineDash([]);

        // Beschriftungen
        ctx.fillStyle = 'rgba(122, 155, 192, 0.8)';
        ctx.font = '10px system-ui';
        ctx.fillText('LF', toX(0.04) + 2, H - 4);
        ctx.fillText('HF', toX(0.15) + 2, H - 4);
        ctx.fillText(`${this.resonanceFreq.toFixed(3)} Hz`, rx + 3, 14);
    }

    destroy() {
        this._resizeObserver.disconnect();
    }
}

// ─── Tachogramm-Visualisierung (Phase 3 Selbsterzeugung) ─────────────────────

// Zeigt rollenden 120s Herzfrequenzverlauf (HR in bpm, nicht RR-Intervalle)

export class TachogramVisualizer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hrData = [];
        this.timestamps = [];
        this.windowSeconds = 120;
        this.coherenceScore = 0;

        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas.parentElement || canvas);
        this._resize();
    }

    _resize() {
        const parent = this.canvas.parentElement;
        if (parent) {
            this.canvas.width  = parent.clientWidth;
            this.canvas.height = parent.clientHeight || 100;
        }
        this._draw();
    }

    addRR(rrMs) {
        if (rrMs <= 0) return;
        const now = Date.now();
        this.hrData.push(60000 / rrMs);
        this.timestamps.push(now);
        const cutoff = now - this.windowSeconds * 1000;
        while (this.timestamps.length > 1 && this.timestamps[0] < cutoff) {
            this.timestamps.shift();
            this.hrData.shift();
        }
        this._draw();
    }

    setCoherence(score) {
        this.coherenceScore = Math.max(0, Math.min(100, score));
    }

    _coherenceColor(alpha = 1) {
        const s = this.coherenceScore;
        const hue = s < 50 ? (s / 50) * 60 : 60 + ((s - 50) / 50) * 110;
        return `hsla(${Math.round(hue)},75%,55%,${alpha})`;
    }

    _draw() {
        const { canvas, ctx } = this;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        if (this.hrData.length < 2) {
            ctx.strokeStyle = 'rgba(0,212,255,0.2)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 8]);
            ctx.beginPath();
            ctx.moveTo(0, H / 2);
            ctx.lineTo(W, H / 2);
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        const min = Math.min(...this.hrData) - 5;
        const max = Math.max(...this.hrData) + 5;
        const range = Math.max(max - min, 15);
        const toY  = (hr) => H - ((hr - min) / range) * H * 0.85 - H * 0.075;

        const now   = Date.now();
        const startT = now - this.windowSeconds * 1000;
        const toX   = (ts) => Math.max(0, ((ts - startT) / (this.windowSeconds * 1000)) * W);

        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, this._coherenceColor(0.3));
        grad.addColorStop(1, this._coherenceColor(1.0));

        // Füllbereich
        ctx.beginPath();
        ctx.moveTo(toX(this.timestamps[0]), toY(this.hrData[0]));
        for (let i = 1; i < this.hrData.length; i++) {
            const x = toX(this.timestamps[i]), y = toY(this.hrData[i]);
            const px = toX(this.timestamps[i - 1]), py = toY(this.hrData[i - 1]);
            ctx.bezierCurveTo((px + x) / 2, py, (px + x) / 2, y, x, y);
        }
        ctx.lineTo(toX(this.timestamps[this.timestamps.length - 1]), H);
        ctx.lineTo(toX(this.timestamps[0]), H);
        ctx.closePath();
        const fillGrad = ctx.createLinearGradient(0, 0, 0, H);
        fillGrad.addColorStop(0, this._coherenceColor(0.18));
        fillGrad.addColorStop(1, this._coherenceColor(0));
        ctx.fillStyle = fillGrad;
        ctx.fill();

        // Hauptlinie
        ctx.beginPath();
        ctx.moveTo(toX(this.timestamps[0]), toY(this.hrData[0]));
        for (let i = 1; i < this.hrData.length; i++) {
            const x = toX(this.timestamps[i]), y = toY(this.hrData[i]);
            const px = toX(this.timestamps[i - 1]), py = toY(this.hrData[i - 1]);
            ctx.bezierCurveTo((px + x) / 2, py, (px + x) / 2, y, x, y);
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    destroy() {
        this._resizeObserver.disconnect();
    }
}

// ─── Kohärenz-Welle Overlay (Phase 3) ────────────────────────────────────────
// Halbtransparentes Canvas über dem Ballon-Container.
// Untere 35% = Wellen-Zone:
//   – gestrichelte Referenz-Sinuslinie (adaptiv an Resonanzfrequenz)
//   – farbige gemessene HR-Kurve (Rot → Gelb → Grün → Türkis je nach Kohärenz)
//   – Glow-Effekt bei Kohärenz > 70%

export class CoherenceWaveOverlay {
    constructor(canvas) {
        this.canvas         = canvas;
        this.ctx            = canvas.getContext('2d');
        this.hrData         = [];    // [{ ts: ms, hr: bpm }]
        this.windowSec      = 30;
        this.resonanceFreq  = 0.1;   // Hz, adaptiv
        this.coherenceScore = 0;
        this._refOrigin     = null;  // ms – Phasenanker
        this._smoothAmp     = 8;     // bpm – geglättete RSA-Amplitude
        this._running       = false;
        this._raf           = null;

        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas.parentElement || canvas);
        this._resize();
    }

    _resize() {
        const p = this.canvas.parentElement;
        if (p) {
            this.canvas.width  = p.clientWidth;
            this.canvas.height = p.clientHeight;
        }
    }

    /** Neues RR-Intervall (ms) hinzufügen – bei jedem Herzschlag aufrufen */
    addRR(rrMs) {
        if (rrMs < 300 || rrMs > 1800) return;
        const now = Date.now();
        if (this._refOrigin === null) this._refOrigin = now;
        this.hrData.push({ ts: now, hr: 60000 / rrMs });
        const cutoff = now - this.windowSec * 1000;
        while (this.hrData.length > 1 && this.hrData[0].ts < cutoff) this.hrData.shift();
    }

    /** FFT-Ergebnis übergeben → adaptive Resonanzfrequenz-Aktualisierung */
    setFFTResult(result) {
        if (!result) return;
        const f = result.lfPeakFreq ?? result.resonanceFreq;
        if (f >= 0.04 && f <= 0.15) {
            this.resonanceFreq = 0.9 * this.resonanceFreq + 0.1 * f;
        }
    }

    setCoherence(score) {
        this.coherenceScore = Math.max(0, Math.min(100, score));
    }

    start() { this._running = true; this._loop(); }

    stop() {
        this._running = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    _loop() {
        if (!this._running) return;
        this._draw();
        this._raf = requestAnimationFrame(() => this._loop());
    }

    _hue() {
        const s = this.coherenceScore;
        if (s < 35) return 0;
        if (s < 65) return 30 + (s - 35);
        if (s < 75) return 60 + (s - 65) * 6;
        return 160 + (s - 75) * 0.8;
    }

    _color(a = 1) {
        return `hsla(${Math.round(this._hue())},80%,60%,${a})`;
    }

    _draw() {
        const { canvas, ctx } = this;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        if (this.hrData.length < 4 || this._refOrigin === null) return;

        // Wellen-Zone: untere 35% des Canvas
        const zTop = H * 0.65;
        const zH   = H - zTop;
        const zMid = zTop + zH * 0.5;

        const now    = Date.now();
        const startT = now - this.windowSec * 1000;
        const toX    = ts => Math.max(0, ((ts - startT) / (this.windowSec * 1000)) * W);

        const hrs  = this.hrData.map(d => d.hr);
        const mean = hrs.reduce((a, b) => a + b) / hrs.length;
        const curAmp = (Math.max(...hrs) - Math.min(...hrs)) / 2;
        this._smoothAmp = this._smoothAmp * 0.9 + curAmp * 0.1;
        const refAmp = Math.max(this._smoothAmp, 3);
        const scale  = (zH * 0.38) / refAmp;
        const toY    = hr => zMid - (hr - mean) * scale;

        // Subtiler Hintergrund für Wellen-Zone
        const bgGrad = ctx.createLinearGradient(0, zTop, 0, H);
        bgGrad.addColorStop(0, 'rgba(0,5,15,0)');
        bgGrad.addColorStop(1, 'rgba(0,5,15,0.6)');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, zTop, W, zH);

        // ─── Referenz-Sinus ───────────────────────────────────────────────────
        ctx.beginPath();
        for (let x = 0; x <= W; x++) {
            const tSec = (startT + (x / W) * this.windowSec * 1000 - this._refOrigin) / 1000;
            const y    = toY(mean + refAmp * Math.sin(2 * Math.PI * this.resonanceFreq * tSec));
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);

        // ─── Gemessene HR-Kurve ───────────────────────────────────────────────
        ctx.beginPath();
        let started = false;
        for (const d of this.hrData) {
            const x = toX(d.ts), y = toY(d.hr);
            if (x < 0) continue;
            started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
        }
        ctx.strokeStyle = this._color(0.9);
        ctx.lineWidth   = 2.5;
        ctx.stroke();

        // Glow bei hoher Kohärenz
        if (this.coherenceScore > 70) {
            ctx.save();
            ctx.shadowColor = this._color(1);
            ctx.shadowBlur  = 6 + (this.coherenceScore - 70) * 0.5;
            ctx.beginPath();
            started = false;
            for (const d of this.hrData) {
                const x = toX(d.ts), y = toY(d.hr);
                if (x < 0) continue;
                started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
            }
            ctx.strokeStyle = this._color(0.35);
            ctx.lineWidth   = 5;
            ctx.stroke();
            ctx.restore();
        }

        // Frequenz-Label (links oben)
        ctx.fillStyle = 'rgba(255,255,255,0.30)';
        ctx.font      = '10px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText(`${(this.resonanceFreq * 60).toFixed(1)} Atemz/min`, 8, zTop + 14);

        // ─── Atemführungs-Punkt ───────────────────────────────────────────────
        // Wandert live auf der Referenz-Sinuslinie (rechter Rand = "jetzt").
        // Steigt der Sinus → Einatmen; fällt er → Ausatmen.
        const nowSec   = (now - this._refOrigin) / 1000;
        const phase    = 2 * Math.PI * this.resonanceFreq * nowSec;
        const dotRefHR = mean + refAmp * Math.sin(phase);
        const dotX     = W - 7;
        const dotY     = toY(dotRefHR);
        const isRising = Math.cos(phase) > 0;

        // Äußerer Glow-Ring
        ctx.save();
        ctx.shadowColor = 'rgba(255,255,255,0.7)';
        ctx.shadowBlur  = 14;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fill();
        ctx.restore();

        // Kern-Punkt
        ctx.save();
        ctx.shadowColor = 'rgba(255,255,255,0.95)';
        ctx.shadowBlur  = 6;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.restore();

        // Atemphase-Label: bei hoher Kohärenz dezenter (User kennt den Rhythmus)
        const labelAlpha = this.coherenceScore > 75 ? 0.35 : 0.88;
        const label      = isRising ? '↑  Einatmen' : '↓  Ausatmen';
        const labelY     = isRising ? dotY - 13 : dotY + 20;
        ctx.fillStyle  = `rgba(255,255,255,${labelAlpha})`;
        ctx.font       = 'bold 12px system-ui';
        ctx.textAlign  = 'right';
        ctx.fillText(label, dotX - 10, labelY);
        ctx.textAlign  = 'left';
    }

    destroy() {
        this.stop();
        this._ro.disconnect();
    }
}
