/**
 * Moonbird-Steuerung (Haptik-Atemgerät) via Web Bluetooth
 *
 * Das Moonbird kennt nur "Sessions": Programm setzen (Opcode 05), Session
 * starten (07). Solange eine Session läuft, lehnt es neue Programme ab, und
 * eine Session endet immer erst am Ende der ersten Ausatmung NACH Ablauf der
 * gesetzten Dauer (Ende-Ereignis: Notification 0xF1).
 *
 * Daraus folgt der Trick für die Live-Steuerung: Jeder Atemzug ist eine eigene
 * Ein-Atemzug-Session. Die Dauer wird knapp VOR das Ende der Ausatmung gelegt,
 * das Programm für den nächsten Atemzug wird nach dem Ende-Ereignis gesetzt und
 * mit dem nächsten Einatem-Signal des Pacers gestartet. So folgt das Moonbird
 * jeder Rhythmus-Änderung (Adaptives Training) schon im nächsten Atemzug.
 * Den "Halt nach Ausatmen" liefert die Wartezeit zwischen zwei Sessions.
 *
 * Protokoll reverse-engineert (Sniffer + Test vom PC aus), siehe Notizen.
 */

const SERVICE_UUID = 'd2580000-d354-ad94-9b40-bc67a1c968ca';
const NOTIFY_UUID  = 'd2580001-d354-ad94-9b40-bc67a1c968ca';
const WRITE_UUID   = 'd2580002-d354-ad94-9b40-bc67a1c968ca';

const OP_STATUS  = 0x04;
const OP_PROGRAM = 0x05;
const OP_START   = 0x07;
const OP_STOP    = 0x08;
const REPLY_FLAG = 0x80;              // Antwort-Opcode = Befehl | 0x80
const EVT_SESSION_END = 0xf1;
const STATE_RUNNING   = 0x03;         // Statusbyte: 02 = bereit, 03 = läuft
const START_CMD = new Uint8Array([OP_START, 0x01, 0x00, 0x2a, 0xcc, 0x13]);

const MIN_SESSION_MS   = 8000;        // kürzere Dauern lehnt das Moonbird ab
const END_MARGIN_MS    = 200;         // Dauer endet so weit vor dem Ausatem-Ende
const CMD_OVERHEAD_MS  = 300;         // Ende-Ereignis → Start: 2 Schreibvorgänge (05+07)
const REQUEST_TIMEOUT_MS = 3000;
const IDLE_WAIT_MS       = 15000;     // so lange auf das Ende einer laufenden Session warten
const STALE_RUN_GRACE_MS = 3000;      // Toleranz, bevor ein verpasstes Ende-Ereignis abgefragt wird

function rhythmKey(r) {
    return `${r.inhale}|${r.holdIn || 0}|${r.exhale}|${r.holdOut || 0}`;
}

export class MoonbirdController {
    constructor() {
        this.device = null;
        this._writeChar = null;
        this._notifyChar = null;
        this.isConnected = false;

        this.following = false;   // koppelt gerade Atemzug für Atemzug an den Pacer
        this.running = false;     // eine Moonbird-Session läuft
        this.rhythm = null;       // aktueller Soll-Rhythmus { inhale, holdIn, exhale, holdOut } (ms)
        this.prepared = null;     // Schlüssel des zuletzt erfolgreich gesetzten Programms

        this._preparing = false;
        this._starting = false;
        this._wantStart = false;  // Einatem-Signal kam, bevor das Programm bereit war
        this._tooFast = false;
        this._runStartedAt = 0;
        this._runExpectedMs = 0;

        this._waiters = new Map();      // Antwort-Opcode → { resolve, timer }
        this._endListeners = [];
        this._chain = Promise.resolve(); // serialisiert GATT-Operationen

        // Zeitprotokoll für die Diagnose (moonbirdDiagnostics.js): Pacer-Phasen, Befehle
        // mit Sende-/Schreib-/Antwortzeit, Ende-Ereignisse, Entscheidungen. Zeiten: performance.now().
        this.trace = [];
        this._lastProgram = null;

        this._onNotifyBound = (e) => {
            const v = e.target.value;
            this._onNotify(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        };

        // Callbacks (von app.js gesetzt)
        this.onConnectionChange = null; // (connected: boolean) => void
        this.onNotice = null;           // (message: string) => void — unkritischer Hinweis
        this.onError  = null;           // (message: string) => void
    }

    static isAvailable() {
        return typeof navigator !== 'undefined' && navigator.bluetooth !== undefined;
    }

    // ─── Verbindung ──────────────────────────────────────────────────────────

    async connect() {
        if (!MoonbirdController.isAvailable()) {
            this._error('Web Bluetooth wird von diesem Browser nicht unterstützt. Bitte Chrome verwenden.');
            return false;
        }
        try {
            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'moonbird' },
                    { namePrefix: 'Moonbird' },
                    { namePrefix: 'MOONBIRD' },
                    { services: [SERVICE_UUID] },
                ],
                optionalServices: [SERVICE_UUID],
            });
            this.device.addEventListener('gattserverdisconnected', () => this._handleDisconnect());

            const server = await this.device.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            this._notifyChar = await service.getCharacteristic(NOTIFY_UUID);
            this._writeChar  = await service.getCharacteristic(WRITE_UUID);
            this._notifyChar.addEventListener('characteristicvaluechanged', this._onNotifyBound);
            await this._notifyChar.startNotifications();

            this.isConnected = true;
            this.onConnectionChange?.(true);
            return true;
        } catch (err) {
            this._teardown();
            if (err.name === 'NotFoundError') {
                this._error('Kein Moonbird ausgewählt. Ist es wach und die Moonbird-App geschlossen?');
            } else {
                this._error(`Moonbird-Verbindungsfehler: ${err.message}`);
            }
            return false;
        }
    }

    disconnect() {
        this.following = false;
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        else this._handleDisconnect();
    }

    _handleDisconnect() {
        const wasConnected = this.isConnected;
        if (wasConnected) this._trace('decision', { what: 'disconnect' });
        this._teardown();
        if (wasConnected) this.onConnectionChange?.(false);
    }

    _teardown() {
        this.isConnected = false;
        this.following = false;
        this.running = false;
        this.prepared = null;
        this._wantStart = false;
        this._preparing = false;
        this._starting = false;
        for (const w of this._waiters.values()) {
            clearTimeout(w.timer);
            w.reject(new Error('Moonbird getrennt'));
        }
        this._waiters.clear();
        this._endListeners.splice(0).forEach(fn => fn(false));
        this._notifyChar?.removeEventListener('characteristicvaluechanged', this._onNotifyBound);
        this._notifyChar = null;
        this._writeChar = null;
    }

    // ─── Diagnose-Protokoll ──────────────────────────────────────────────────

    _trace(type, data = {}) {
        this.trace.push({ type, t: performance.now(), ...data });
        if (this.trace.length > 20000) this.trace.splice(0, 5000);
    }

    clearTrace() { this.trace = []; }

    // ─── Kommunikation ───────────────────────────────────────────────────────

    _onNotify(bytes) {
        if (!bytes.length) return;
        bytes.tRecv = performance.now();
        const op = bytes[0];
        if (op === EVT_SESSION_END) { this._trace('end'); this._onSessionEnd(); return; }
        const w = this._waiters.get(op);
        if (w) {
            this._waiters.delete(op);
            clearTimeout(w.timer);
            w.resolve(bytes);
        }
        // alles andere (Sensor-Datenstrom 0xF0, sonstige Blöcke) wird ignoriert
    }

    async _write(bytes) {
        const c = this._writeChar;
        if (!c) throw new Error('Moonbird nicht verbunden');
        if (c.writeValueWithResponse) await c.writeValueWithResponse(bytes);
        else await c.writeValue(bytes);
    }

    /** Befehl senden und auf die Antwort-Notification warten (GATT-Zugriffe laufen nacheinander). */
    _request(bytes, timeoutMs = REQUEST_TIMEOUT_MS) {
        const replyOp = bytes[0] | REPLY_FLAG;
        const rec = { op: bytes[0], tQueued: performance.now(), tSend: null, tWritten: null, tReply: null, reply: null, error: null };
        const run = async () => {
            if (!this.isConnected) throw new Error('Moonbird nicht verbunden');
            const reply = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this._waiters.delete(replyOp);
                    reject(new Error('Moonbird antwortet nicht'));
                }, timeoutMs);
                this._waiters.set(replyOp, { resolve, reject, timer });
            });
            reply.catch(() => {});
            rec.tSend = performance.now();
            try {
                await this._write(bytes);
                rec.tWritten = performance.now();
            } catch (err) {
                const w = this._waiters.get(replyOp);
                if (w) { clearTimeout(w.timer); this._waiters.delete(replyOp); }
                throw err;
            }
            return reply;
        };
        const finish = () => this.trace.push({ type: 'cmd', t: rec.tQueued, ...rec });
        const p = this._chain.then(run, run);
        p.then((reply) => {
            rec.tReply = reply.tRecv ?? performance.now();
            rec.reply = Array.from(reply.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
            finish();
        }, (err) => { rec.error = err.message; finish(); });
        this._chain = p.catch(() => {});
        return p;
    }

    static _ok(reply) { return reply[1] === 0x01 && reply[2] === 0x00; }

    // ─── Öffentliche Hilfen (Diagnose) ───────────────────────────────────────

    /** Rohbefehl senden und Antwort abwarten (Bytes mit .tRecv = Empfangszeit). */
    request(bytes, timeoutMs) { return this._request(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), timeoutMs); }
    ensureIdle() { return this._ensureIdle(); }
    waitSessionEnd(timeoutMs = IDLE_WAIT_MS) { return this._waitSessionEnd(timeoutMs); }
    static get startCommand() { return START_CMD; }

    /** Antwort auf 04 zerlegen: Zustand, Sessionzähler (ms seit Start, nur wenn läuft). */
    static parseStatus(reply) {
        const running = reply[3] === STATE_RUNNING;
        let counterMs = null;
        if (running && reply.length >= 38) {
            counterMs = ((reply[34] << 24) | (reply[35] << 16) | (reply[36] << 8) | reply[37]) >>> 0;
        }
        return { running, counterMs };
    }

    /** Programm-Befehl (Opcode 05) aus Rohwerten in ms bauen. */
    static programBytes(holdOut, inhale, holdIn, exhale, duration) {
        const buf = new Uint8Array(22);
        const dv = new DataView(buf.buffer);
        buf[0] = OP_PROGRAM;
        buf[1] = 0x01;
        [holdOut, inhale, holdIn, exhale, duration].forEach((v, i) => dv.setUint32(2 + i * 4, Math.round(v), false));
        return buf;
    }

    static get constants() {
        return { MIN_SESSION_MS, END_MARGIN_MS, CMD_OVERHEAD_MS };
    }

    async _queryRunning() {
        const r = await this._request(new Uint8Array([OP_STATUS]));
        return r[3] === STATE_RUNNING;
    }

    _waitSessionEnd(timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const i = this._endListeners.indexOf(listener);
                if (i >= 0) this._endListeners.splice(i, 1);
                resolve(false);
            }, timeoutMs);
            const listener = (ended) => { clearTimeout(timer); resolve(ended); };
            this._endListeners.push(listener);
        });
    }

    /** Falls noch eine (fremde/vergessene) Session läuft: beenden und Ende abwarten. */
    async _ensureIdle() {
        if (!(await this._queryRunning())) return;
        const ended = this._waitSessionEnd(IDLE_WAIT_MS);
        await this._request(new Uint8Array([OP_STOP]));
        await ended;
        if (await this._queryRunning()) throw new Error('Moonbird beendet die laufende Session nicht');
    }

    // ─── Programm-Berechnung ─────────────────────────────────────────────────

    /**
     * Ein-Atemzug-Programm (Opcode 05) für einen Rhythmus, oder null, wenn der
     * Atemzug für die Mindest-Sessiondauer des Moonbird zu kurz ist.
     * Reihenfolge der Zahlen im Befehl: [Halt nach Ausatmen, Einatmen,
     * Halt nach Einatmen, Ausatmen, Gesamtdauer] (je 4 Byte Big Endian, ms).
     */
    _programFor(r) {
        const holdOut = r.holdOut || 0;
        // Ist der Halt nach Ausatmen kürzer als die Befehlslaufzeit, verkürzt sich
        // die Ausatmung entsprechend, damit der Rhythmus über viele Zyklen nicht driftet.
        const exhale = r.exhale - Math.max(0, CMD_OVERHEAD_MS - holdOut);
        const breath = r.inhale + (r.holdIn || 0) + exhale;
        const duration = breath - END_MARGIN_MS;
        if (duration < MIN_SESSION_MS) return null;

        this._runExpectedMs = breath;
        this._lastProgram = { holdOut, inhale: r.inhale, holdIn: r.holdIn || 0, exhale, duration, breath };
        return MoonbirdController.programBytes(holdOut, r.inhale, r.holdIn || 0, exhale, duration);
    }

    // ─── Kopplung an den Pacer ───────────────────────────────────────────────

    /**
     * Beginnt die Atemzug-für-Atemzug-Kopplung. Bereitet den ersten Atemzug vor;
     * gestartet wird er mit dem nächsten Einatem-Signal des Pacers.
     * @returns {Promise<boolean>}
     */
    async follow(rhythm, source = 'training') {
        if (!this.isConnected) return false;
        this.rhythm = { ...rhythm };
        this._trace('follow', { rhythm: { ...rhythm }, source });
        try {
            await this._ensureIdle();
            this.following = true;
            this.running = false;
            this.prepared = null;
            this._wantStart = false;
            await this._prepare();
            return this.following;
        } catch (err) {
            this._fail(err);
            return false;
        }
    }

    /** Neuen Soll-Rhythmus vormerken (gilt ab dem nächsten Atemzug). */
    setRhythm(rhythm) {
        this.rhythm = { ...rhythm };
        this._trace('rhythm', { rhythm: { ...rhythm } });
        if (this.following && this._tooFast && !this.running && !this._preparing) this._prepare();
    }

    /** Von app.js bei jedem Phasenwechsel des Pacers aufzurufen. */
    onPacerPhase(phase) {
        this._trace('pacer', { phase, following: this.following });
        if (phase !== 'inhale' || !this.following) return;
        // Bewusst erst nach der aktuellen Verarbeitung: Das Adaptive Training ändert
        // den Rhythmus direkt nach dem Einatem-Signal — so startet der Atemzug
        // schon mit dem neuen Rhythmus.
        setTimeout(() => this._startBreath(), 0);
    }

    /** Beendet die Kopplung; ein laufender Atemzug wird noch zu Ende geführt. */
    async release() {
        this.following = false;
        this._wantStart = false;
        if (this.running) await this._waitSessionEnd(IDLE_WAIT_MS);
    }

    async _prepare() {
        if (!this.following || this.running || this._preparing) return;
        this._preparing = true;
        try {
            const program = this._programFor(this.rhythm);
            if (!program) {
                this.prepared = null;
                this._trace('decision', { what: 'too-fast' });
                if (!this._tooFast) this.onNotice?.('Rhythmus zu schnell für das Moonbird (Atemzug unter ca. 8 s) – Moonbird pausiert.');
                this._tooFast = true;
                return;
            }
            this._tooFast = false;
            const key = rhythmKey(this.rhythm);
            const reply = await this._request(program);
            if (!MoonbirdController._ok(reply)) {
                throw new Error(`Programm abgelehnt (${Array.from(reply.slice(0, 3), b => b.toString(16).padStart(2, '0')).join(' ')})`);
            }
            this.prepared = key;
        } catch (err) {
            this._preparing = false;
            this._fail(err);
            return;
        }
        this._preparing = false;
        if (this._wantStart) this._startBreath();
    }

    async _startBreath() {
        if (!this.following || this._starting) return;

        // Ende-Ereignis verpasst? Dann läuft laut Status nichts mehr, obwohl wir es glauben.
        if (this.running && Date.now() - this._runStartedAt > this._runExpectedMs + STALE_RUN_GRACE_MS) {
            try { if (!(await this._queryRunning())) this.running = false; } catch (err) { this._fail(err); return; }
        }

        if (this.running || this._preparing) {
            this._trace('decision', { what: this.running ? 'wait-running' : 'wait-preparing' });
            this._wantStart = true;
            return;
        }
        if (this.prepared !== rhythmKey(this.rhythm)) {
            // nichts vorbereitet oder der Rhythmus hat sich zwischenzeitlich geändert
            this._trace('decision', { what: this.prepared === null ? 'prepare-missing' : 'reprepare' });
            this._wantStart = true;
            this._prepare();
            return;
        }

        this._wantStart = false;
        this._starting = true;
        try {
            const prog = this._lastProgram ? { ...this._lastProgram } : null;
            const reply = await this._request(START_CMD);
            if (MoonbirdController._ok(reply)) {
                this.running = true;
                this.prepared = null;
                this._runStartedAt = Date.now();
                this._trace('session', { prog, tReply: reply.tRecv });
            } else {
                this._trace('decision', { what: 'start-rejected' });
                this._wantStart = true; // vermutlich lief noch eine Session — nach deren Ende erneut versuchen
            }
        } catch (err) {
            this._fail(err);
        } finally {
            this._starting = false;
        }
    }

    _onSessionEnd() {
        this.running = false;
        this._endListeners.splice(0).forEach(fn => fn(true));
        if (this.following) this._prepare();
    }

    // ─── Fehler ──────────────────────────────────────────────────────────────

    _fail(err) {
        console.error('Moonbird:', err);
        this._trace('decision', { what: 'fail', error: err.message });
        const wasFollowing = this.following;
        this.following = false;
        this._wantStart = false;
        if (wasFollowing) this._error(`Moonbird-Steuerung beendet: ${err.message}`);
    }

    _error(msg) {
        this.onError?.(msg);
    }
}
