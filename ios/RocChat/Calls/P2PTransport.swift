/**
 * RocChat iOS — RocP2P Transport
 *
 * Custom peer-to-peer voice transport with ZERO third-party dependencies:
 *   • RFC 5389 STUN client for reflexive-candidate gathering
 *   • Raw UDP via Apple's Network.framework
 *   • UDP simultaneous-open hole-punching
 *   • AES-256-GCM packet encryption (CryptoKit), key derived from the existing
 *     Double Ratchet session shared secret via HKDF-SHA256
 *   • 12-byte nonce = 4-byte salt || 8-byte big-endian sequence counter
 *
 * Candidate exchange rides over the existing encrypted WebSocket signaling.
 * Falls back to the WebSocket audio-relay path if ICE fails within 3 seconds.
 *
 * This is "Wireguard-style" for voice: identity is already proven via X3DH,
 * so we skip DTLS entirely. Simpler, smaller attack surface, still E2E secure.
 */

import Foundation
import Network
import CryptoKit

// MARK: - Public API

/// Represents one endpoint candidate (host/srflx/relay).
struct P2PCandidate: Codable, Equatable {
    enum CandidateType: String, Codable { case host, srflx }
    let type: CandidateType
    let host: String
    let port: UInt16
    let priority: UInt32
}

protocol P2PTransportDelegate: AnyObject {
    /// Emits locally-gathered candidates that should be sent to the peer over WS.
    func p2pDidGatherCandidate(_ candidate: P2PCandidate)
    /// Hole-punching succeeded — audio frames are now flowing P2P.
    func p2pDidConnect()
    /// Fatal failure — caller should fall back to relay.
    func p2pDidFail(reason: String)
    /// Received and already-decrypted PCM audio frame.
    func p2pDidReceiveAudio(_ pcm: Data)
    /// Received and already-decrypted video frame (encoded bytes, codec-agnostic).
    func p2pDidReceiveVideo(_ encoded: Data)
}

extension P2PTransportDelegate {
    // Default no-op so older callers compile.
    func p2pDidReceiveVideo(_ encoded: Data) {}
}

final class P2PTransport {
    weak var delegate: P2PTransportDelegate?
    /// When used in a group call mesh, identifies which remote peer this transport belongs to.
    var groupPeerUserId: String?

    // Independent STUN servers — no Google, no surveillance
    static let stunServers: [(host: String, port: UInt16)] = [
        ("stun.stunprotocol.org", 3478),
        ("stun.nextcloud.com", 3478)
    ]

    private let queue = DispatchQueue(label: "rocchat.p2p", qos: .userInitiated)
    private var listener: NWListener?
    private var connection: NWConnection?
    private var localPort: UInt16 = 0
    private var sendSalt: Data = Data(count: 4)
    private var recvSalt: Data = Data(count: 4)
    private var sendKey: SymmetricKey?
    private var recvKey: SymmetricKey?
    private var sendSeq: UInt64 = 0
    private var peerHost: String?
    private var peerPort: UInt16 = 0
    private var holePunchTimer: Timer?
    private var connected = false

    // MARK: - Start

    /// Kicks off candidate gathering. `sharedSecret` should be 32 bytes from
    /// the Double Ratchet session (e.g. current sending chain key).
    /// `isInitiator` controls salt ordering so both sides use the same keys.
    func start(sharedSecret: Data, isInitiator: Bool) {
        queue.async { [weak self] in
            guard let self = self else { return }
            do {
                try self.deriveKeys(sharedSecret: sharedSecret, isInitiator: isInitiator)
                try self.openLocalSocket()
                self.gatherHostCandidates()
                self.gatherSrflxCandidates()
            } catch {
                self.delegate?.p2pDidFail(reason: "P2P start failed: \(error)")
            }
        }
    }

    /// Peer's candidates arrived via WS. Attempt hole-punching toward the best one.
    func addRemoteCandidate(_ candidate: P2PCandidate) {
        queue.async { [weak self] in
            guard let self = self, !self.connected else { return }
            self.peerHost = candidate.host
            self.peerPort = candidate.port
            self.beginHolePunch()
        }
    }

    func stop() {
        queue.async { [weak self] in
            self?.holePunchTimer?.invalidate()
            self?.holePunchTimer = nil
            self?.connection?.cancel()
            self?.connection = nil
            self?.listener?.cancel()
            self?.listener = nil
            self?.connected = false
        }
    }

    /// Send one PCM-16 audio frame. Fire-and-forget UDP.
    func sendAudio(_ pcm: Data) {
        sendEncrypted(pcm, magic: 0x52)
    }

    /// Send one encoded video frame. Fire-and-forget UDP.
    func sendVideo(_ encoded: Data) {
        sendEncrypted(encoded, magic: 0x56)
    }

    private func sendEncrypted(_ payload: Data, magic: UInt8) {
        queue.async { [weak self] in
            guard let self = self, self.connected,
                  let key = self.sendKey,
                  let conn = self.connection else { return }
            self.sendSeq &+= 1
            var nonceBytes = Data()
            nonceBytes.append(self.sendSalt)
            var seqBE = self.sendSeq.bigEndian
            withUnsafeBytes(of: &seqBE) { nonceBytes.append(contentsOf: $0) }
            guard let nonce = try? AES.GCM.Nonce(data: nonceBytes),
                  let sealed = try? AES.GCM.seal(payload, using: key, nonce: nonce) else { return }
            // Wire format: [1 byte magic] [8 byte seq] [ciphertext] [16 byte tag]
            var frame = Data()
            frame.append(magic)
            frame.append(nonceBytes.suffix(8)) // seq
            frame.append(sealed.ciphertext)
            frame.append(sealed.tag)
            conn.send(content: frame, completion: .contentProcessed { _ in })
        }
    }

    // MARK: - Key derivation

    private func deriveKeys(sharedSecret: Data, isInitiator: Bool) throws {
        let salt = Data("rocchat-p2p-voice-v1".utf8)
        let ikm = SymmetricKey(data: sharedSecret)
        let okm = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: salt,
            info: Data("rocchat.p2p".utf8),
            outputByteCount: 72 // 32 key A + 32 key B + 4 salt A + 4 salt B
        )
        let okmData = okm.withUnsafeBytes { Data($0) }
        let keyA = SymmetricKey(data: okmData.subdata(in: 0..<32))
        let keyB = SymmetricKey(data: okmData.subdata(in: 32..<64))
        let saltA = okmData.subdata(in: 64..<68)
        let saltB = okmData.subdata(in: 68..<72)
        if isInitiator {
            sendKey = keyA; recvKey = keyB
            sendSalt = saltA; recvSalt = saltB
        } else {
            sendKey = keyB; recvKey = keyA
            sendSalt = saltB; recvSalt = saltA
        }
    }

    // MARK: - Local socket

    private func openLocalSocket() throws {
        let params = NWParameters.udp
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = listener.port {
                self?.localPort = port.rawValue
            }
        }
        listener.newConnectionHandler = { [weak self] newConn in
            self?.handleInboundConnection(newConn)
        }
        listener.start(queue: queue)
    }

    private func handleInboundConnection(_ newConn: NWConnection) {
        newConn.stateUpdateHandler = { [weak self] state in
            guard case .ready = state else { return }
            self?.markConnected(with: newConn, fromRemote: true)
            self?.receiveLoop(on: newConn)
        }
        newConn.start(queue: queue)
    }

    private func markConnected(with conn: NWConnection, fromRemote: Bool) {
        guard !connected else { return }
        connected = true
        connection = conn
        holePunchTimer?.invalidate()
        holePunchTimer = nil
        delegate?.p2pDidConnect()
    }

    // MARK: - Host candidate

    private func gatherHostCandidates() {
        // Enumerate local IPv4 interfaces (IPv6 deferred for now).
        var addrs: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrs) == 0, let first = addrs else { return }
        defer { freeifaddrs(addrs) }
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            let flags = Int32(cur.pointee.ifa_flags)
            let up = (flags & IFF_UP) != 0 && (flags & IFF_LOOPBACK) == 0
            if up, let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET) {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len),
                               &host, socklen_t(host.count),
                               nil, 0, NI_NUMERICHOST) == 0 {
                    let ip = String(cString: host)
                    if !ip.hasPrefix("169.254.") && localPort != 0 {
                        let c = P2PCandidate(type: .host, host: ip, port: localPort, priority: 1_000_000)
                        delegate?.p2pDidGatherCandidate(c)
                    }
                }
            }
            ptr = cur.pointee.ifa_next
        }
    }

    // MARK: - STUN client (RFC 5389 minimal)

    private func gatherSrflxCandidates() {
        for server in Self.stunServers {
            sendStunBindingRequest(to: server.host, port: server.port)
        }
    }

    private func sendStunBindingRequest(to host: String, port: UInt16) {
        guard let listener = listener else { return }
        // Open a short-lived NWConnection reusing the same local UDP port.
        let params = NWParameters.udp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .init("0.0.0.0"),
            port: .init(rawValue: listener.port?.rawValue ?? 0) ?? .any
        )
        let conn = NWConnection(
            host: .init(host), port: .init(rawValue: port) ?? .any,
            using: params
        )
        let txId = Self.randomBytes(12)
        let request = Self.stunBindingRequest(transactionId: txId)
        conn.stateUpdateHandler = { [weak self, weak conn] state in
            guard case .ready = state, let conn = conn else { return }
            conn.send(content: request, completion: .contentProcessed { _ in })
            self?.receiveStunResponse(on: conn, txId: txId)
        }
        conn.start(queue: queue)
    }

    private func receiveStunResponse(on conn: NWConnection, txId: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1500) { [weak self] data, _, _, _ in
            defer { conn.cancel() }
            guard let self = self, let data = data,
                  let reflexive = Self.parseStunXorMappedAddress(data, expectedTxId: txId)
            else { return }
            let c = P2PCandidate(
                type: .srflx,
                host: reflexive.host,
                port: reflexive.port,
                priority: 500_000
            )
            self.delegate?.p2pDidGatherCandidate(c)
        }
    }

    private static let stunMagicCookie: UInt32 = 0x2112A442

    private static func stunBindingRequest(transactionId: Data) -> Data {
        precondition(transactionId.count == 12)
        var pkt = Data()
        // Type (Binding Request = 0x0001), length = 0
        pkt.append(contentsOf: [0x00, 0x01, 0x00, 0x00])
        var cookie = stunMagicCookie.bigEndian
        withUnsafeBytes(of: &cookie) { pkt.append(contentsOf: $0) }
        pkt.append(transactionId)
        return pkt
    }

    private static func parseStunXorMappedAddress(_ data: Data, expectedTxId: Data)
        -> (host: String, port: UInt16)?
    {
        guard data.count >= 20 else { return nil }
        let type = UInt16(data[0]) << 8 | UInt16(data[1])
        guard type == 0x0101 else { return nil } // Binding Success Response
        let length = Int(UInt16(data[2]) << 8 | UInt16(data[3]))
        let cookie = (UInt32(data[4]) << 24) | (UInt32(data[5]) << 16) | (UInt32(data[6]) << 8) | UInt32(data[7])
        guard cookie == stunMagicCookie else { return nil }
        guard data.subdata(in: 8..<20) == expectedTxId else { return nil }
        guard data.count >= 20 + length else { return nil }

        var offset = 20
        while offset + 4 <= 20 + length {
            let attrType = UInt16(data[offset]) << 8 | UInt16(data[offset + 1])
            let attrLen = Int(UInt16(data[offset + 2]) << 8 | UInt16(data[offset + 3]))
            let valueStart = offset + 4
            guard valueStart + attrLen <= data.count else { return nil }
            if attrType == 0x0020 { // XOR-MAPPED-ADDRESS
                // family = data[valueStart + 1], xPort = data[valueStart+2..+4]
                guard attrLen >= 8, data[valueStart + 1] == 0x01 else { return nil } // IPv4 only
                let xPortHi = UInt16(data[valueStart + 2])
                let xPortLo = UInt16(data[valueStart + 3])
                let xPort = (xPortHi << 8) | xPortLo
                let port = UInt16(xPort ^ UInt16(stunMagicCookie >> 16))

                var ipBytes = [UInt8](repeating: 0, count: 4)
                for i in 0..<4 {
                    let cookieByte = UInt8((stunMagicCookie >> (8 * (3 - i))) & 0xFF)
                    ipBytes[i] = data[valueStart + 4 + i] ^ cookieByte
                }
                let ip = "\(ipBytes[0]).\(ipBytes[1]).\(ipBytes[2]).\(ipBytes[3])"
                return (ip, port)
            }
            // Attributes are 32-bit padded
            let padded = (attrLen + 3) & ~3
            offset = valueStart + padded
        }
        return nil
    }

    // MARK: - Hole punching

    private func beginHolePunch() {
        guard let host = peerHost, peerPort != 0 else { return }
        let params = NWParameters.udp
        params.allowLocalEndpointReuse = true
        if let lp = listener?.port {
            params.requiredLocalEndpoint = NWEndpoint.hostPort(
                host: .init("0.0.0.0"), port: lp
            )
        }
        let conn = NWConnection(
            host: .init(host), port: .init(rawValue: peerPort) ?? .any,
            using: params
        )
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.markConnected(with: conn, fromRemote: false)
                self?.receiveLoop(on: conn)
            case .failed, .cancelled:
                break
            default:
                break
            }
        }
        conn.start(queue: queue)

        // Send punching probes every 200 ms for 3 s
        var attempts = 0
        holePunchTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self, weak conn] t in
            guard let self = self, let conn = conn else { t.invalidate(); return }
            if self.connected || attempts >= 15 {
                t.invalidate()
                if !self.connected { self.delegate?.p2pDidFail(reason: "ICE timeout") }
                return
            }
            attempts += 1
            // Small keepalive — 1 byte marker, not encrypted (pre-connection)
            conn.send(content: Data([0xFF]), completion: .contentProcessed { _ in })
        }
        if let t = holePunchTimer {
            RunLoop.main.add(t, forMode: .common)
        }
    }

    // MARK: - Receive loop

    private func receiveLoop(on conn: NWConnection) {
        conn.receiveMessage { [weak self, weak conn] data, _, _, _ in
            guard let self = self, let conn = conn else { return }
            if let data = data, !data.isEmpty {
                self.handleInboundFrame(data)
            }
            self.receiveLoop(on: conn)
        }
    }

    private func handleInboundFrame(_ data: Data) {
        // Drop keepalive
        if data.count == 1 { return }
        guard data.count >= 1 + 8 + 16, let key = recvKey else { return }
        let magic = data[0]
        guard magic == 0x52 || magic == 0x56 else { return }
        let seq = data.subdata(in: 1..<9)
        let body = data.subdata(in: 9..<(data.count - 16))
        let tag = data.subdata(in: (data.count - 16)..<data.count)
        var nonceBytes = Data()
        nonceBytes.append(recvSalt)
        nonceBytes.append(seq)
        guard let nonce = try? AES.GCM.Nonce(data: nonceBytes),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: body, tag: tag),
              let plain = try? AES.GCM.open(box, using: key) else { return }
        if magic == 0x52 {
            delegate?.p2pDidReceiveAudio(plain)
        } else {
            delegate?.p2pDidReceiveVideo(plain)
        }
    }

    // MARK: - Util

    private static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }
}
