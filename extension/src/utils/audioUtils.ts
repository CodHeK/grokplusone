// Utility to convert Float32 AudioBuffer to 16-bit PCM Linear
export function convertFloat32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Clamp between -1 and 1
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        // Scale to 16-bit integer range
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

export function downsampleBuffer(
    buffer: Float32Array,
    sampleRate: number,
    outSampleRate: number
): Float32Array {
    if (outSampleRate === sampleRate) {
        return buffer;
    }
    if (outSampleRate > sampleRate) {
        throw new Error("Downsampling rate show be smaller than original sample rate");
    }
    const sampleRateRatio = sampleRate / outSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
        // Use average value of skipped samples
        let accum = 0,
            count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
            accum += buffer[i];
            count++;
        }
        result[offsetResult] = accum / count;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
    }
    return result;
}
