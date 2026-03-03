/**
 * Bluetooth-Modul für Polar H10
 * Verbindet via Web Bluetooth API und empfängt RR-Intervalle
 */

// Polar H10 UUIDs
const HR_SERVICE_UUID        = 0x180d;
const HR_CHARACTERISTIC_UUID = 0x2a37;

// Polar Measurement Data Service (für rohe RR-Daten)
const PMD_SERVICE_UUID  = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL_UUID  = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA_UUID     = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

export class PolarBluetooth {
    constructor() {
        this.device = null;
        this.server = null;
        this.hrCharacteristic = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnectDelay = 2000;

        // Event-Callbacks
        this.onRRInterval = null;    // (rrMs: number) => void
        this.onHeartRate  = null;    // (bpm: number) => void
        this.onConnect    = null;    // () => void
        this.onDisconnect = null;    // () => void
        this.onError      = null;    // (message: string) => void
        this.onStatusChange = null;  // (status: string) => void
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
     * Verbindungsabbruch behandeln
     */
    async _handleDisconnect() {
        this.isConnected = false;
        this._setStatus('Verbindung getrennt');

        if (this.onDisconnect) this.onDisconnect();

        // Automatisch neu verbinden
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
     * Verbindung trennen
     */
    disconnect() {
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
