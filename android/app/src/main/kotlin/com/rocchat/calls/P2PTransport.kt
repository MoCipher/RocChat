/**
 * RocChat Android — RocP2P Transport
 *
 * Mirrors P2PTransport.swift byte-for-byte on the wire:
 *   • RFC 5389 STUN client
 *   • Raw UDP via DatagramSocket
 *   • UDP hole-punching
 *   • AES-256-GCM packet encryption, 12-byte nonce = 4-byte salt || 8-byte seq
 *   • HKDF-SHA256 key derivation from the existing Double Ratchet secret
 *
 * Zero third-party dependencies — javax.crypto + java.net only.
 */

package com.rocchat.calls

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.*

// MARK: - Public types

data class P2PCandidate(
    val type: String, // "host" | "srflx"
    val host: String,
    val port: Int,
    val priority: Int,
)

interface P2PTransportDelegate {
    fun p2pDidGatherCandidate(candidate: P2PCandidate)
    fun p2pDidConnect()
    fun p2pDidFail(reason: String)
    fun p2pDidReceiveAudio(pcm: ByteArray)
    fun p2pDidReceiveVideo(encoded: ByteArray) {}
}

class P2PTransport(private val delegate: P2PTransportDelegate) {
    /** When used in a group call mesh, identifies which remote peer this transport belongs to. */
    var groupPeerUserId: String? = null

    companion object {
        val stunServers = listOf(
            "stun.stunprotocol.org" to 3478,
            "stun.nextcloud.com" to 3478,
        )
        private const val STUN_MAGIC_COOKIE = 0x2112A442.toInt()
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var socket: DatagramSocket? = null
    private var sendKey: ByteArray = ByteArray(32)
    private var recvKey: ByteArray = ByteArray(32)
    private var sendSalt: ByteArray = ByteArray(4)
    private var recvSalt: ByteArray = ByteArray(4)
    private val sendSeq = AtomicLong(0)
    private var peerAddress: InetSocketAddress? = null
    private val connected = AtomicBoolean(false)
    private var recvJob: Job? = null
    private var punchJob: Job? = null

    // MARK: - Start / stop

    fun start(sharedSecret: ByteArray, isInitiator: Boolean) {
        scope.launch {
            try {
                deriveKeys(sharedSecret, isInitiator)
                val sock = DatagramSocket(0) // random port
                sock.reuseAddress = true
                socket = sock
                startReceiveLoop()
                gatherHostCandidates()
                gatherSrflxCandidates()
            } catch (e: Exception) {
                delegate.p2pDidFail("P2P start failed: ${e.message}")
            }
        }
    }

    fun addRemoteCandidate(candidate: P2PCandidate) {
        scope.launch {
            if (connected.get()) return@launch
            peerAddress = InetSocketAddress(InetAddress.getByName(candidate.host), candidate.port)
            beginHolePunch()
        }
    }

    fun stop() {
        punchJob?.cancel()
        recvJob?.cancel()
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        connected.set(false)
    }

    fun sendAudio(pcm: ByteArray) = sendEncrypted(pcm, 0x52.toByte())
    fun sendVideo(encoded: ByteArray) = sendEncrypted(encoded, 0x56.toByte())

    private fun sendEncrypted(payload: ByteArray, magic: Byte) {
        if (!connected.get()) return
        val sock = socket ?: return
        val peer = peerAddress ?: return
        val seq = sendSeq.incrementAndGet()
        try {
            val nonce = ByteArray(12)
            System.arraycopy(sendSalt, 0, nonce, 0, 4)
            for (i in 0..7) nonce[4 + i] = ((seq ushr (8 * (7 - i))) and 0xFF).toByte()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "AES"), GCMParameterSpec(128, nonce))
            val sealed = cipher.doFinal(payload)
            // Wire: magic | 8-byte seq | ciphertext+tag
            val frame = ByteArray(1 + 8 + sealed.size)
            frame[0] = magic
            System.arraycopy(nonce, 4, frame, 1, 8)
            System.arraycopy(sealed, 0, frame, 9, sealed.size)
            sock.send(DatagramPacket(frame, frame.size, peer))
        } catch (_: Exception) {}
    }

    // MARK: - Key derivation (HKDF-SHA256)

    private fun deriveKeys(sharedSecret: ByteArray, isInitiator: Boolean) {
        val salt = "rocchat-p2p-voice-v1".toByteArray()
        val info = "rocchat.p2p".toByteArray()
        val okm = hkdfSha256(sharedSecret, salt, info, 72)
        val keyA = okm.copyOfRange(0, 32)
        val keyB = okm.copyOfRange(32, 64)
        val saltA = okm.copyOfRange(64, 68)
        val saltB = okm.copyOfRange(68, 72)
        if (isInitiator) {
            sendKey = keyA; recvKey = keyB; sendSalt = saltA; recvSalt = saltB
        } else {
            sendKey = keyB; recvKey = keyA; sendSalt = saltB; recvSalt = saltA
        }
    }

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var i = 1
        var generated = 0
        while (generated < length) {
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(t)
            mac.update(info)
            mac.update(i.toByte())
            t = mac.doFinal()
            val chunk = minOf(t.size, length - generated)
            System.arraycopy(t, 0, out, generated, chunk)
            generated += chunk
            i++
        }
        return out
    }

    // MARK: - Host candidates

    private fun gatherHostCandidates() {
        val port = socket?.localPort ?: return
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return
            for (iface in ifaces) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    if (addr.isLoopbackAddress || addr.isLinkLocalAddress) continue
                    // IPv4 only for now
                    if (addr.address.size != 4) continue
                    val ip = addr.hostAddress ?: continue
                    delegate.p2pDidGatherCandidate(
                        P2PCandidate("host", ip, port, 1_000_000)
                    )
                }
            }
        } catch (_: Exception) {}
    }

    // MARK: - STUN client

    private fun gatherSrflxCandidates() {
        for ((host, port) in stunServers) {
            scope.launch { sendStunBindingRequest(host, port) }
        }
    }

    private suspend fun sendStunBindingRequest(host: String, port: Int) {
        val sock = socket ?: return
        try {
            val txId = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val req = stunBindingRequest(txId)
            val serverAddr = InetSocketAddress(InetAddress.getByName(host), port)
            sock.send(DatagramPacket(req, req.size, serverAddr))
            // Reply is picked up by the main receive loop — we recognize STUN
            // responses via the magic cookie and dispatch here.
            stunPending[ByteArrayKey(txId)] = System.currentTimeMillis()
        } catch (_: Exception) {}
    }

    private val stunPending = mutableMapOf<ByteArrayKey, Long>()

    private fun stunBindingRequest(txId: ByteArray): ByteArray {
        val out = ByteArray(20)
        out[0] = 0x00; out[1] = 0x01 // Binding Request
        out[2] = 0x00; out[3] = 0x00 // length 0
        out[4] = 0x21; out[5] = 0x12; out[6] = 0xA4.toByte(); out[7] = 0x42 // cookie
        System.arraycopy(txId, 0, out, 8, 12)
        return out
    }

    private fun parseStunResponse(data: ByteArray, length: Int): P2PCandidate? {
        if (length < 20) return null
        val type = ((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)
        if (type != 0x0101) return null
        val cookie = ((data[4].toInt() and 0xFF) shl 24) or
            ((data[5].toInt() and 0xFF) shl 16) or
            ((data[6].toInt() and 0xFF) shl 8) or
            (data[7].toInt() and 0xFF)
        if (cookie != STUN_MAGIC_COOKIE) return null
        val txId = data.copyOfRange(8, 20)
        if (stunPending.remove(ByteArrayKey(txId)) == null) return null

        var offset = 20
        val msgLen = ((data[2].toInt() and 0xFF) shl 8) or (data[3].toInt() and 0xFF)
        val end = 20 + msgLen
        while (offset + 4 <= end && offset + 4 <= length) {
            val attrType = ((data[offset].toInt() and 0xFF) shl 8) or (data[offset + 1].toInt() and 0xFF)
            val attrLen = ((data[offset + 2].toInt() and 0xFF) shl 8) or (data[offset + 3].toInt() and 0xFF)
            val v = offset + 4
            if (attrType == 0x0020 && attrLen >= 8 && data[v + 1] == 0x01.toByte()) {
                val xPort = ((data[v + 2].toInt() and 0xFF) shl 8) or (data[v + 3].toInt() and 0xFF)
                val port = xPort xor (STUN_MAGIC_COOKIE ushr 16)
                val ipBytes = ByteArray(4)
                for (i in 0..3) {
                    val cb = ((STUN_MAGIC_COOKIE ushr (8 * (3 - i))) and 0xFF).toByte()
                    ipBytes[i] = (data[v + 4 + i].toInt() xor cb.toInt()).toByte()
                }
                val ip = "${ipBytes[0].toInt() and 0xFF}.${ipBytes[1].toInt() and 0xFF}." +
                    "${ipBytes[2].toInt() and 0xFF}.${ipBytes[3].toInt() and 0xFF}"
                return P2PCandidate("srflx", ip, port and 0xFFFF, 500_000)
            }
            offset = v + ((attrLen + 3) and 3.inv())
        }
        return null
    }

    // MARK: - Hole punch

    private fun beginHolePunch() {
        val sock = socket ?: return
        val peer = peerAddress ?: return
        punchJob?.cancel()
        punchJob = scope.launch {
            var attempts = 0
            while (attempts < 15 && !connected.get()) {
                try {
                    sock.send(DatagramPacket(byteArrayOf(0xFF.toByte()), 1, peer))
                } catch (_: Exception) {}
                delay(200)
                attempts++
            }
            if (!connected.get()) delegate.p2pDidFail("ICE timeout")
        }
    }

    // MARK: - Receive loop

    private fun startReceiveLoop() {
        recvJob = scope.launch {
            val sock = socket ?: return@launch
            val buf = ByteArray(1500)
            val pkt = DatagramPacket(buf, buf.size)
            while (isActive) {
                try {
                    sock.receive(pkt)
                    handleInbound(buf.copyOf(pkt.length), pkt.length, pkt.address.hostAddress, pkt.port)
                } catch (_: Exception) {
                    if (!isActive) break
                }
            }
        }
    }

    private fun handleInbound(data: ByteArray, length: Int, fromHost: String?, fromPort: Int) {
        if (length == 0) return
        // STUN success response
        if (length >= 20 && ((data[0].toInt() and 0xC0) == 0)) {
            val candidate = parseStunResponse(data, length)
            if (candidate != null) {
                delegate.p2pDidGatherCandidate(candidate)
                return
            }
        }
        // Keepalive / hole-punch probe
        if (length == 1 && data[0] == 0xFF.toByte()) {
            if (!connected.getAndSet(true)) {
                if (peerAddress == null && fromHost != null) {
                    peerAddress = InetSocketAddress(InetAddress.getByName(fromHost), fromPort)
                }
                delegate.p2pDidConnect()
            }
            return
        }
        // Audio/Video frame
        if (length >= 1 + 8 + 16 && (data[0] == 0x52.toByte() || data[0] == 0x56.toByte())) {
            val magic = data[0]
            if (!connected.getAndSet(true)) {
                if (peerAddress == null && fromHost != null) {
                    peerAddress = InetSocketAddress(InetAddress.getByName(fromHost), fromPort)
                }
                delegate.p2pDidConnect()
            }
            val seq = data.copyOfRange(1, 9)
            val ct = data.copyOfRange(9, length)
            val nonce = ByteArray(12)
            System.arraycopy(recvSalt, 0, nonce, 0, 4)
            System.arraycopy(seq, 0, nonce, 4, 8)
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(recvKey, "AES"), GCMParameterSpec(128, nonce))
                val plain = cipher.doFinal(ct)
                if (magic == 0x52.toByte()) delegate.p2pDidReceiveAudio(plain)
                else delegate.p2pDidReceiveVideo(plain)
            } catch (_: Exception) {}
        }
    }

    // MARK: - Util

    private data class ByteArrayKey(val bytes: ByteArray) {
        override fun equals(other: Any?): Boolean =
            other is ByteArrayKey && bytes.contentEquals(other.bytes)
        override fun hashCode(): Int = bytes.contentHashCode()
    }
}
