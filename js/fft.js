/**
 * FFT - Fast Fourier Transform (Cooley-Tukey Algorithmus)
 * Für HRV-Frequenzanalyse: LF/HF-Ratio und Kohärenz-Score
 */
export class FFT {
    /**
     * Führt FFT auf dem Input-Array durch.
     * Input-Länge muss Potenz von 2 sein.
     * @param {Float64Array} inputReal - Reelle Eingangsdaten
     * @returns {{ real: Float64Array, imag: Float64Array }}
     */
    static forward(inputReal) {
        const n = inputReal.length;
        const real = new Float64Array(inputReal);
        const imag = new Float64Array(n);

        // Bit-Reversal Permutation
        let j = 0;
        for (let i = 1; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [real[i], real[j]] = [real[j], real[i]];
                [imag[i], imag[j]] = [imag[j], imag[i]];
            }
        }

        // Butterfly-Operationen
        for (let len = 2; len <= n; len <<= 1) {
            const ang = (2 * Math.PI) / len;
            const wReal = Math.cos(ang);
            const wImag = -Math.sin(ang);

            for (let i = 0; i < n; i += len) {
                let curReal = 1.0;
                let curImag = 0.0;

                for (let k = 0; k < len / 2; k++) {
                    const evenR = real[i + k];
                    const evenI = imag[i + k];
                    const oddR = real[i + k + len / 2];
                    const oddI = imag[i + k + len / 2];

                    const tReal = curReal * oddR - curImag * oddI;
                    const tImag = curReal * oddI + curImag * oddR;

                    real[i + k] = evenR + tReal;
                    imag[i + k] = evenI + tImag;
                    real[i + k + len / 2] = evenR - tReal;
                    imag[i + k + len / 2] = evenI - tImag;

                    const newCurReal = curReal * wReal - curImag * wImag;
                    curImag = curReal * wImag + curImag * wReal;
                    curReal = newCurReal;
                }
            }
        }

        return { real, imag };
    }

    /**
     * Berechnet Power Spectral Density (PSD)
     * @param {number[]} signal - Gleichmäßig abgetastetes Signal
     * @param {number} sampleRate - Abtastrate in Hz
     * @returns {{ frequencies: Float64Array, power: Float64Array }}
     */
    static psd(signal, sampleRate) {
        // Auf nächste Potenz von 2 auffüllen
        const n = nextPow2(signal.length);
        const padded = new Float64Array(n);

        // Hanning-Fenster anwenden
        for (let i = 0; i < signal.length; i++) {
            const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (signal.length - 1)));
            padded[i] = signal[i] * window;
        }

        const { real, imag } = FFT.forward(padded);

        const halfN = Math.floor(n / 2) + 1;
        const frequencies = new Float64Array(halfN);
        const power = new Float64Array(halfN);

        for (let i = 0; i < halfN; i++) {
            frequencies[i] = (i * sampleRate) / n;
            // Zweiseitiges zu einseitigem Spektrum (×2 außer DC und Nyquist)
            const scale = i === 0 || i === halfN - 1 ? 1 : 2;
            power[i] = scale * (real[i] * real[i] + imag[i] * imag[i]) / (n * sampleRate);
        }

        return { frequencies, power };
    }

    /**
     * Bandleistung zwischen fMin und fMax berechnen
     * @param {Float64Array} frequencies
     * @param {Float64Array} power
     * @param {number} fMin
     * @param {number} fMax
     * @returns {{ totalPower: number, peakFreq: number, peakPower: number }}
     */
    static bandPower(frequencies, power, fMin, fMax) {
        let totalPower = 0;
        let peakPower = 0;
        let peakFreq = fMin;
        let df = frequencies[1] - frequencies[0]; // Frequenzauflösung

        for (let i = 0; i < frequencies.length; i++) {
            if (frequencies[i] >= fMin && frequencies[i] <= fMax) {
                totalPower += power[i] * df;
                if (power[i] > peakPower) {
                    peakPower = power[i];
                    peakFreq = frequencies[i];
                }
            }
        }

        return { totalPower, peakFreq, peakPower };
    }
}

/**
 * Nächste Potenz von 2 finden
 */
function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
