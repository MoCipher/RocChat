package com.rocchat.network

import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.SecureRandom
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread

/**
 * Lightweight WebSocket client using raw sockets.
 * Supports text frames only — no binary, no extensions.
 * Zero third-party dependencies.
 */
class NativeWebSocket private constructor(
    private val input: InputStream,
    private val output: OutputStream,
    private val closable: AutoCloseable,
) {

    interface Listener {
        fun onOpen(ws: NativeWebSocket) {}
        fun onMessage(ws: NativeWebSocket, text: String)
        fun onClosed(ws: NativeWebSocket, code: Int, reason: String) {}
        fun onFailure(ws: NativeWebSocket, error: Throwable) {}
    }

    @Volatile
    private var closed = false
    private val random = SecureRandom()

    fun send(text: String) {
        if (closed) return
        try {
            val data = text.toByteArray(Charsets.UTF_8)
            val frame = encodeFrame(0x1, data) // 0x1 = text frame
            synchronized(output) { output.write(frame); output.flush() }
        } catch (e: Exception) { /* ignore send errors on closed socket */ }
    }

    fun close(code: Int = 1000, reason: String? = null) {
        if (closed) return
        closed = true
        try {
            val payload = ByteArray(2)
            payload[0] = (code shr 8).toByte()
            payload[1] = (code and 0xFF).toByte()
            val frame = encodeFrame(0x8, payload) // 0x8 = close
            synchronized(output) { output.write(frame); output.flush() }
        } catch (_: Exception) { }
        try { closable.close() } catch (_: Exception) { }
    }

    private fun encodeFrame(opcode: Int, payload: ByteArray): ByteArray {
        val mask = ByteArray(4).also { random.nextBytes(it) }
        val masked = ByteArray(payload.size)
        for (i in payload.indices) masked[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()

        val header = mutableListOf<Byte>()
        header.add((0x80 or opcode).toByte()) // FIN + opcode
        when {
            payload.size < 126 -> header.add((0x80 or payload.size).toByte()) // MASK + length
            payload.size < 65536 -> {
                header.add((0x80 or 126).toByte())
                header.add((payload.size shr 8).toByte())
                header.add((payload.size and 0xFF).toByte())
            }
            else -> {
                header.add((0x80 or 127).toByte())
                for (i in 7 downTo 0) header.add((payload.size.toLong() shr (8 * i) and 0xFF).toByte())
            }
        }
        return header.toByteArray() + mask + masked
    }

    private fun readLoop(listener: Listener) {
        try {
            while (!closed) {
                val b1 = input.read()
                if (b1 == -1) break
                val opcode = b1 and 0x0F
                val b2 = input.read()
                if (b2 == -1) break
                val hasMask = (b2 and 0x80) != 0
                var len = (b2 and 0x7F).toLong()

                if (len == 126L) {
                    len = ((input.read().toLong() and 0xFF) shl 8) or (input.read().toLong() and 0xFF)
                } else if (len == 127L) {
                    len = 0
                    for (i in 0 until 8) len = (len shl 8) or (input.read().toLong() and 0xFF)
                }

                val mask = if (hasMask) ByteArray(4).also { input.readNBytes(it) } else null
                val payload = ByteArray(len.toInt())
                var read = 0
                while (read < payload.size) {
                    val n = input.read(payload, read, payload.size - read)
                    if (n == -1) break
                    read += n
                }
                if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()

                when (opcode) {
                    0x1 -> listener.onMessage(this, String(payload, Charsets.UTF_8)) // text
                    0x8 -> { // close
                        val code = if (payload.size >= 2) ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF) else 1000
                        val reason = if (payload.size > 2) String(payload, 2, payload.size - 2, Charsets.UTF_8) else ""
                        closed = true
                        listener.onClosed(this, code, reason)
                        return
                    }
                    0x9 -> { // ping → pong
                        val pong = encodeFrame(0xA, payload)
                        synchronized(output) { output.write(pong); output.flush() }
                    }
                }
            }
            if (!closed) listener.onClosed(this, 1006, "Connection lost")
        } catch (e: Exception) {
            if (!closed) listener.onFailure(this, e)
        }
    }

    private fun InputStream.readNBytes(buf: ByteArray) {
        var off = 0
        while (off < buf.size) {
            val n = read(buf, off, buf.size - off); if (n == -1) break; off += n
        }
    }

    companion object {
        fun connect(url: String, listener: Listener): NativeWebSocket {
            val uri = URI.create(url)
            val isSecure = uri.scheme == "wss"
            val host = uri.host
            val port = if (uri.port > 0) uri.port else if (isSecure) 443 else 80
            val path = (uri.rawPath ?: "/") + (if (uri.rawQuery != null) "?${uri.rawQuery}" else "")

            val socket = if (isSecure) {
                SSLSocketFactory.getDefault().createSocket(host, port)
            } else {
                java.net.Socket(host, port)
            }

            val output = socket.getOutputStream()
            val input = socket.getInputStream()
            val key = java.util.Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })

            // HTTP upgrade request
            val request = buildString {
                append("GET $path HTTP/1.1\r\n")
                append("Host: $host\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Key: $key\r\n")
                append("Sec-WebSocket-Version: 13\r\n")
                append("\r\n")
            }
            output.write(request.toByteArray(Charsets.UTF_8))
            output.flush()

            // Read HTTP response headers
            val sb = StringBuilder()
            while (true) {
                val line = buildString {
                    while (true) {
                        val c = input.read(); if (c == -1 || c == '\n'.code) break
                        if (c != '\r'.code) append(c.toChar())
                    }
                }
                if (line.isEmpty()) break
                sb.append(line).append('\n')
            }

            val responseLine = sb.toString().lineSequence().firstOrNull() ?: ""
            if (!responseLine.contains("101")) {
                socket.close()
                throw java.io.IOException("WebSocket upgrade failed: $responseLine")
            }

            val ws = NativeWebSocket(input, output, socket)
            listener.onOpen(ws)
            thread(isDaemon = true, name = "ws-read-$host") { ws.readLoop(listener) }
            return ws
        }
    }
}
