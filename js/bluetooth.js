/**
 * Bluetooth-Modul für Polar H10
 * Verbindet via Web Bluetooth API und empfängt RR-Intervalle
 */

// Polar H10 UUIDs
const HR_SERVICE_UUID        = 0x180d;
const HR_CHARACTERISTIC_UUID = 0x2a37;

// Polar Measurement Data Service (für rohes EKG, z.B. für EDR-Atemableitung)
const PMD_SERVICE_UUID  = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL_UUID  = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA_UUID     = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

// EKG-Start: REQUEST_MEASUREMENT_START(0x02), Typ ECG(0x00),
// SampleRate=130Hz (0x82,0x00 LE), Resolution=14bit (0x0E,0x00 LE)
const PMD_ECG_START_CMD = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00]);
// EKG-Stop: REQUEST_MEASUREMENT_STOP(0x03), Typ ECG(0x00)
const PMD_ECG_STOP_CMD  = new Uint8Array([0x03, 0x00]);
const ECG_SAMPLE_RATE_HZ = 130;

export class PolarBluetooth {
    constructor() {
        this.device = null;
        this.server = null;
        this.hrCharacteristic = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnectDelay = 2000;

        // Nacht-Modus: unbegrenzte Reconnect-Versuche mit steigendem Abstand
        // (unbeaufsichtigte Mehrstunden-Aufnahme, kein Mensch der eingreifen könnte)
        this.persistentReconnect = false;
        this._persistentDelays = [2000, 5000, 10000, 30000];

        // PMD/EKG (optional, für Adaptives Training)
        this.pmdControlChar   = null;
        this.pmdDataChar      = null;
        this.ecgStreaming     = false;
        this._ecgWasStreaming = false;

        // Event-Callbacks
        this.onRRInterval = null;    // (rrMs: number) => void
        this.onHeartRate  = null;    // (bpm: number) => void
        this.onConnect    = null;    // () => void
        this.onDisconnect = null;    // () => void
        this.onError      = null;    // (message: string) => void
        this.onStatusChange = null;  // (status: string) => void
        this.onEcgSample    = null;  // (microVolt: number, tsMs: number) => void — tsMs auf performance.now()-Achse
    }

    /**
     * Prüft ob Web Bluetooth verfügbar ist
     */
    static isAvailable() {
        return navigator.bluetooth !== undefined;
    }

    /**
     * Verbindung mit Polar H10 herstellen
     */
    async connect() {
        if (!PolarBluetooth.isAvailable()) {
            this._error('Web Bluetooth wird von diesem Browser nicht unterstützt. Bitte Chrome verwenden.');
            return false;
        }

        try {
            this._setStatus('Suche nach Polar H10...');

            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Polar' },
                    { services: [HR_SERVICE_UUID] },
                ],
                optionalServices: [HR_SERVICE_UUID, PMD_SERVICE_UUID],
            });

            this.device.addEventListener('gattserverdisconnected', () => {
                this._handleDisconnect();
            });

            this._setStatus('Verbinde...');
            await this._connectToServer();
            return true;

        } catch (err) {
            if (err.name === 'NotFoundError') {
                this._error('Kein Gerät ausgewählt. Bitte Polar H10 in der Liste auswählen.');
            } else if (err.name === 'SecurityError') {
                this._error('Bluetooth-Zugriff verweigert. Bitte Berechtigung erteilen.');
            } else {
                this._error(`Verbindungsfehler: ${err.message}`);
            }
            return false;
        }
    }

    /**
     * Verbindung zum GATT-Server herstellen und Notifications aktivieren
     */
    async _connectToServer() {
        this.server = await this.device.gatt.connect();
        this._setStatus('Lade Dienste...');

        const hrService = await this.server.getPrimaryService(HR_SERVICE_UUID);
        this.hrCharacteristic = await hrService.getCharacteristic(HR_CHARACTERISTIC_UUID);

        this.hrCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
            this._parseHRMeasurement(event.target.value);
        });

        await this.hrCharacteristic.startNotifications();

        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._setStatus('Verbunden');

        // EKG-Stream nach Reconnect automatisch wiederherstellen, falls er vor
        // dem Abbruch aktiv war (Characteristics sind nach GATT-Reconnect ungültig)
        if (this._ecgWasStreaming) {
            this.pmdControlChar = null;
            this.pmdDataChar    = null;
            await this.enableEcgStream();
        }

        if (this.onConnect) this.onConnect();
    }

    /**
     * HR-Measurement-Characteristic parsen
     * Enthält Herzfrequenz + optional mehrere RR-Intervalle
     * RR-Werte sind in Einheiten von 1/1024 Sekunden
     */
    _parseHRMeasurement(data) {
        const flags = data.getUint8(0);
        const hrFormat16Bit = flags & 0x01;
        const contactStatus  = (flags >> 1) & 0x03;
        const energyPresent  = (flags >> 3) & 0x01;
        const rrPresent      = (flags >> 4) & 0x01;

        let offset = 1;

        // Herzfrequenz auslesen
        let hr;
        if (hrFormat16Bit) {
            hr = data.getUint16(offset, true);
            offset += 2;
        } else {
            hr = data.getUint8(offset);
            offset += 1;
        }

        if (this.onHeartRate) this.onHeartRate(hr);

        // Energy Expended überspringen
        if (energyPresent) offset += 2;

        // RR-Intervalle auslesen (können mehrere pro Notification sein)
        if (rrPresent) {
            while (offset + 1 < data.byteLength) {
                const rrRaw = data.getUint16(offset, true);
                offset += 2;
                // Umrechnung: 1/1024 Sekunden → Millisekunden
                const rrMs = Math.round(rrRaw * (1000 / 1024));
                if (this.onRRInterval) this.onRRInterval(rrMs);
            }
        }
    }

    /**
     * PMD-EKG-Stream aktivieren (rohe Herzsignal-Samples, 130 Hz/14 Bit).
     * Läuft zusätzlich zum Standard-HF-Dienst auf derselben Verbindung —
     * keine erneute Kopplung nötig, keine Beeinträchtigung der RR-Intervalle.
     * @returns {Promise<boolean>}
     */
    async enableEcgStream() {
        if (!this.server || !this.isConnected) {
            this._error('EKG-Stream: nicht verbunden.');
            return false;
        }
        try {
            const pmdService = await this.server.getPrimaryService(PMD_SERVICE_UUID);
            this.pmdControlChar = await pmdService.getCharacteristic(PMD_CONTROL_UUID);
            this.pmdDataChar    = await pmdService.getCharacteristic(PMD_DATA_UUID);

            this.pmdDataChar.addEventListener('characteristicvaluechanged', (event) => {
                this._parseEcgFrame(event.target.value);
            });
            await this.pmdDataChar.startNotifications();
            await this.pmdControlChar.writeValueWithResponse(PMD_ECG_START_CMD);

            this.ecgStreaming = true;
            this._ecgWasStreaming = true;
            return true;
        } catch (err) {
            this._error(`EKG-Stream konnte nicht gestartet werden: ${err.message}`);
            this.ecgStreaming = false;
            return false;
        }
    }

    /** PMD-EKG-Stream beenden (RR-Intervalle über den Standard-Dienst laufen unberührt weiter) */
    async disableEcgStream() {
        this.ecgStreaming = false;
        this._ecgWasStreaming = false;
        if (this.pmdControlChar) {
            try { await this.pmdControlChar.writeValueWithoutResponse(PMD_ECG_STOP_CMD); } catch {}
        }
        if (this.pmdDataChar) {
            try { await this.pmdDataChar.stopNotifications(); } catch {}
        }
    }

    /**
     * PMD-EKG-Datenframe parsen: 10-Byte-Header (Messtyp, Geräte-Zeitstempel,
     * Frame-Typ) + N × 3-Byte little-endian signed Samples (µV). Der proprietäre
     * Geräte-Zeitstempel wird ignoriert — Samples bekommen stattdessen einen
     * performance.now()-Zeitstempel, rückgerechnet über die feste Sample-Rate
     * ab dem Notification-Empfangszeitpunkt. Das hält alle Zeitachsen der App
     * (BreathPacer, RR-Intervalle) auf derselben Uhr, ohne die proprietäre
     * Geräte-Epoche entschlüsseln zu müssen.
     */
    _parseEcgFrame(dataView) {
        if (dataView.byteLength < 10) return;
        const measurementType = dataView.getUint8(0);
        if (measurementType !== 0x00) return; // nur ECG-Frames
        const frameType = dataView.getUint8(9);
        if (frameType !== 0x00) return; // nur unkomprimierte Rohdaten-Frames

        const sampleCount = Math.floor((dataView.byteLength - 10) / 3);
        if (sampleCount <= 0) return;

        const nowMs = performance.now();
        const sampleIntervalMs = 1000 / ECG_SAMPLE_RATE_HZ;

        for (let i = 0; i < sampleCount; i++) {
            const offset = 10 + i * 3;
            const b0 = dataView.getUint8(offset);
            const b1 = dataView.getUint8(offset + 1);
            const b2 = dataView.getUint8(offset + 2);
            let uv = b0 | (b1 << 8) | (b2 << 16);
            if (uv & 0x800000) uv -= 0x1000000; // 24-bit Vorzeichen-Erweiterung

            const sampleTs = nowMs - (sampleCount - 1 - i) * sampleIntervalMs;
            if (this.onEcgSample) this.onEcgSample(uv, sampleTs);
        }
    }

    /**
     * Verbindungsabbruch behandeln
     */
    async _handleDisconnect() {
        this.isConnected = false;
        this.ecgStreaming = false;
        this.pmdControlChar = null; // GATT-Objekte ungültig nach Abbruch
        this.pmdDataChar    = null;
        this._setStatus('Verbindung getrennt');

        if (this.onDisconnect) this.onDisconnect();

        if (this.persistentReconnect) {
            await this._persistentReconnectLoop();
            return;
        }

        // Automatisch neu verbinden (begrenzt, für beaufsichtigte Tages-Sessions)
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this._setStatus(`Verbinde erneut (Versuch ${this.reconnectAttempts})...`);
            await new Promise(r => setTimeout(r, this.reconnectDelay));

            try {
                await this._connectToServer();
            } catch {
                if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    this._error('Automatische Wiederverbindung fehlgeschlagen. Bitte manuell verbinden.');
                }
            }
        }
    }

    /**
     * Unbegrenzte Reconnect-Versuche mit steigendem Abstand (2s→5s→10s→30s, dann
     * konstant 30s) — für unbeaufsichtigte Mehrstunden-Aufnahmen (Nacht-Modus).
     */
    async _persistentReconnectLoop() {
        let i = 0;
        while (this.persistentReconnect && !this.isConnected) {
            this.reconnectAttempts++;
            const delay = this._persistentDelays[Math.min(i, this._persistentDelays.length - 1)];
            this._setStatus(`Verbinde erneut (Versuch ${this.reconnectAttempts})...`);
            await new Promise(r => setTimeout(r, delay));

            if (!this.persistentReconnect) return; // währenddessen abgebrochen

            try {
                await this._connectToServer();
                return;
            } catch {
                i++;
            }
        }
    }

    /**
     * Verbindung trennen
     */
    disconnect() {
        this.persistentReconnect = false;
        this._ecgWasStreaming = false;
        this.pmdControlChar = null;
        this.pmdDataChar    = null;
        this.ecgStreaming   = false;
        this.reconnectAttempts = this.maxReconnectAttempts; // Kein Auto-Reconnect
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.isConnected = false;
        this._setStatus('Getrennt');
    }

    _setStatus(status) {
        if (this.onStatusChange) this.onStatusChange(status);
    }

    _error(message) {
        if (this.onError) this.onError(message);
    }
}
