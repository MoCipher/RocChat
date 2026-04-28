/**
 * RocChat Android — G.711 μ-law codec
 *
 * Mirrors MuLaw.swift — same encode/decode algorithm, byte-compatible on the wire.
 * Zero third-party dependencies.
 */

package com.rocchat.calls

object MuLaw {
    private const val BIAS = 0x84
    private const val CLIP = 32_635

    fun encode(pcm16: ByteArray): ByteArray {
        val count = pcm16.size / 2
        val out = ByteArray(count)
        for (i in 0 until count) {
            val lo = pcm16[i * 2].toInt() and 0xFF
            val hi = pcm16[i * 2 + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toInt()
            out[i] = encodeSample(sample).toByte()
        }
        return out
    }

    fun decode(mulaw: ByteArray): ByteArray {
        val out = ByteArray(mulaw.size * 2)
        for (i in mulaw.indices) {
            val sample = decodeSample(mulaw[i].toInt() and 0xFF)
            out[i * 2]     = (sample and 0xFF).toByte()
            out[i * 2 + 1] = ((sample ushr 8) and 0xFF).toByte()
        }
        return out
    }

    private fun encodeSample(sample: Int): Int {
        var s = sample
        val sign = if (s < 0) 0x7F else 0xFF
        if (s < 0) s = -s
        if (s > CLIP) s = CLIP
        s += BIAS
        var exponent = 7
        var expMask = 0x4000
        while ((s and expMask) == 0 && exponent > 0) {
            exponent--
            expMask = expMask ushr 1
        }
        val shift = exponent + 3
        val mantissa = (s ushr shift) and 0x0F
        return (((exponent shl 4) or mantissa).inv()) and sign and 0xFF
    }

    private fun decodeSample(byte: Int): Int {
        val b = byte.inv() and 0xFF
        val sign = b and 0x80
        val exponent = (b ushr 4) and 0x07
        val mantissa = b and 0x0F
        var sample = ((mantissa shl 3) + BIAS) shl exponent
        sample -= BIAS
        if (sign != 0) sample = -sample
        if (sample > Short.MAX_VALUE.toInt()) sample = Short.MAX_VALUE.toInt()
        if (sample < Short.MIN_VALUE.toInt()) sample = Short.MIN_VALUE.toInt()
        return sample
    }
}
