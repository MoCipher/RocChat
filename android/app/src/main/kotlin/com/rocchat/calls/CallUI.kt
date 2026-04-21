package com.rocchat.calls

import android.view.SurfaceView
import android.view.ViewGroup
import android.hardware.camera2.CameraManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.rocchat.ui.RocColors

/**
 * RocChat Android — Call UI Composables
 */

// MARK: - Call Overlay (full-screen, shown during active call)

@Composable
fun CallOverlay() {
    val status = CallManager.callStatus
    if (status == "idle") return

    // Dismiss soft keyboard when entering an active call
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(status) {
        keyboard?.hide()
        focus.clearFocus(force = true)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.9f)),
        contentAlignment = Alignment.Center
    ) {
        // Video preview layer — show local camera when video call and camera on
        if (CallManager.callType == "video" && !CallManager.isCameraOff && status == "connected") {
            val context = LocalContext.current
            AndroidView(
                factory = { ctx ->
                    SurfaceView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                        CallManager.attachLocalVideoSurface(ctx, holder)
                    }
                },
                modifier = Modifier.fillMaxSize()
            )
        }

        // Remote video frame (JPEG-over-WS from web/iOS peer).
        val remoteBmp = CallManager.remoteVideoBitmap
        if (CallManager.callType == "video" && status == "connected") {
            if (remoteBmp != null) {
                androidx.compose.foundation.Image(
                    bitmap = remoteBmp.asImageBitmap(),
                    contentDescription = "Remote video",
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(16.dp)
                        .size(width = 160.dp, height = 120.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color.Black)
                )
            } else {
                // No video received yet — show avatar placeholder
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(16.dp)
                        .size(width = 160.dp, height = 120.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0xFF111111)),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        Box(
                            modifier = Modifier
                                .size(56.dp)
                                .clip(CircleShape)
                                .background(RocColors.RocGold),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = CallManager.remoteName.split(" ").mapNotNull { it.firstOrNull()?.toString() }.take(2).joinToString("").uppercase(),
                                color = Color.Black,
                                fontWeight = FontWeight.Bold,
                                fontSize = 20.sp
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        Text("No video", color = Color.White.copy(alpha = 0.5f), fontSize = 11.sp)
                    }
                }
            }
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Spacer(Modifier.weight(1f))

            // Avatar
            Box(
                modifier = Modifier
                    .size(100.dp)
                    .clip(CircleShape)
                    .background(RocColors.RocGold.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    initials(CallManager.remoteName),
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Bold,
                    color = RocColors.RocGold
                )
            }

            Spacer(Modifier.height(24.dp))
            Text(CallManager.remoteName, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Color.White)
            Spacer(Modifier.height(8.dp))

            // Status
            when (status) {
                "incoming" -> Text("Incoming ${CallManager.callType} call...", color = Color.White.copy(0.7f))
                "outgoing" -> Text("Calling...", color = Color.White.copy(0.7f))
                "connected" -> Text(formatDuration(CallManager.callDuration), color = Color.White.copy(0.7f))
            }

            Spacer(Modifier.weight(1f))

            // Controls
            when (status) {
                "incoming" -> IncomingControls()
                "outgoing", "connected" -> ActiveControls()
            }

            Spacer(Modifier.height(16.dp))
            Text("🔒 DTLS-SRTP encrypted", color = RocColors.Turquoise, fontSize = 11.sp)
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun IncomingControls() {
    Row(horizontalArrangement = Arrangement.spacedBy(48.dp)) {
        // Accept
        IconButton(
            onClick = { CallManager.acceptCall() },
            modifier = Modifier
                .size(64.dp)
                .clip(CircleShape)
                .background(Color(0xFF4CAF50))
        ) {
            Icon(Icons.Default.Phone, contentDescription = "Accept", tint = Color.White, modifier = Modifier.size(28.dp))
        }
        // Decline
        IconButton(
            onClick = { CallManager.declineCall() },
            modifier = Modifier
                .size(64.dp)
                .clip(CircleShape)
                .background(Color.Red)
        ) {
            Icon(Icons.Default.CallEnd, contentDescription = "Decline", tint = Color.White, modifier = Modifier.size(28.dp))
        }
    }
}

@Composable
private fun ActiveControls() {
    var showDiag by remember { mutableStateOf(false) }

    Row(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) {
        // Mute
        IconButton(
            onClick = { CallManager.toggleMute() },
            modifier = Modifier
                .size(52.dp)
                .clip(CircleShape)
                .background(if (CallManager.isMuted) Color.White.copy(0.3f) else Color.White.copy(0.1f))
        ) {
            Icon(
                if (CallManager.isMuted) Icons.Default.MicOff else Icons.Default.Mic,
                contentDescription = "Mute", tint = Color.White, modifier = Modifier.size(24.dp)
            )
        }

        // Camera (video only)
        if (CallManager.callType == "video") {
            IconButton(
                onClick = { CallManager.toggleCamera() },
                modifier = Modifier
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(if (CallManager.isCameraOff) Color.White.copy(0.3f) else Color.White.copy(0.1f))
            ) {
                Icon(
                    if (CallManager.isCameraOff) Icons.Default.VideocamOff else Icons.Default.Videocam,
                    contentDescription = "Camera", tint = Color.White, modifier = Modifier.size(24.dp)
                )
            }
        }

        // Hangup
        IconButton(
            onClick = { CallManager.endCall() },
            modifier = Modifier
                .size(64.dp)
                .clip(CircleShape)
                .background(Color.Red)
        ) {
            Icon(Icons.Default.CallEnd, contentDescription = "End", tint = Color.White, modifier = Modifier.size(28.dp))
        }

        // Diagnostics
        if (CallManager.callStatus == "connected") {
            IconButton(
                onClick = { showDiag = true },
                modifier = Modifier
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(0.1f))
            ) {
                Icon(Icons.Default.Info, contentDescription = "Diagnostics", tint = Color.White, modifier = Modifier.size(24.dp))
            }
        }
    }

    if (showDiag) {
        CallDiagnosticsSheet(onDismiss = { showDiag = false })
    }
}

// MARK: - Call History Tab

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallsHistoryTab() {
    val history = CallManager.callHistory

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Calls", fontWeight = FontWeight.Bold) })

        if (history.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Phone, contentDescription = null, modifier = Modifier.size(48.dp), tint = RocColors.RocGold.copy(alpha = 0.3f))
                    Spacer(Modifier.height(12.dp))
                    Text("No recent calls", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    Text("Voice and video calls are end-to-end encrypted.", color = RocColors.TextSecondary, fontSize = 14.sp, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(12.dp))
                    Text("🔒 DTLS-SRTP + E2E signaling + verification", color = RocColors.Turquoise, fontSize = 11.sp)
                }
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(history) { record ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        // Avatar
                        Box(
                            modifier = Modifier.size(40.dp).clip(CircleShape).background(RocColors.RocGold.copy(alpha = 0.12f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(initials(record.remoteName), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = RocColors.RocGold)
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(record.remoteName, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            Row {
                                Text(
                                    "${if (record.direction == "incoming") "↙" else "↗"} ${record.callType} · ${if (record.status == "completed") formatDuration(record.duration) else record.status}",
                                    fontSize = 12.sp,
                                    color = if (record.status == "missed") Color.Red else RocColors.TextSecondary
                                )
                            }
                        }
                        Icon(
                            if (record.callType == "video") Icons.Default.Videocam else Icons.Default.Phone,
                            contentDescription = null,
                            tint = RocColors.RocGold,
                            modifier = Modifier.size(16.dp)
                        )
                    }
                    HorizontalDivider(modifier = Modifier.padding(start = 68.dp), color = Color.White.copy(alpha = 0.06f))
                }
            }
        }
    }
}

private fun initials(name: String): String {
    return name.split(" ").mapNotNull { it.firstOrNull()?.uppercase() }.take(2).joinToString("")
}

private fun formatDuration(seconds: Int): String {
    return "%02d:%02d".format(seconds / 60, seconds % 60)
}

// MARK: - Call Diagnostics Sheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CallDiagnosticsSheet(onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text("Call Diagnostics", fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.padding(bottom = 12.dp))
            DiagRow("Call Type", CallManager.callType.replaceFirstChar { it.uppercase() })
            DiagRow("Duration", formatDuration(CallManager.callDuration))
            DiagRow("Estimated RTT", "%.0f ms".format(CallManager.diagRttMs))
            if (CallManager.callType == "video") {
                DiagRow("Target FPS", "${CallManager.diagFps} fps")
                DiagRow("JPEG Quality", "${CallManager.diagQuality}%")
            }
            DiagRow("Voice Jitter (EMA)", "%.1f ms".format(CallManager.diagAudioJitterMs))
            DiagRow("Voice Late Frames", CallManager.diagAudioLateFrames.toString())
            DiagRow("Transport", "WebSocket (RocChat relay)")
            DiagRow("Encryption", "AES-256-GCM")
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun DiagRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, color = Color.Gray, modifier = Modifier.weight(1f))
        Text(value, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, fontSize = 13.sp)
    }
}
