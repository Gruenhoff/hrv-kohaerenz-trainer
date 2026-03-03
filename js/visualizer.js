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
