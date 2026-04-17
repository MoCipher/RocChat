package com.rocchat.chat

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import com.rocchat.ui.RocColors
import kotlinx.coroutines.delay
import java.io.File
import java.util.concurrent.Executor

private fun fmtDuration(seconds: Int): String = "%d:%02d".format(seconds / 60, seconds % 60)

@Composable
fun RecordingBarCompose(
    elapsed: Int,
    levels: List<Float>,
    onCancel: () -> Unit,
    onSend: () -> Unit,
) {
    val infinite = rememberInfiniteTransition(label = "rec-dot")
    val dotAlpha by infinite.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Reverse),
        label = "dot-a",
    )
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onCancel) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(RocColors.Danger.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Delete, contentDescription = "Cancel", tint = RocColors.Danger)
            }
        }
        Spacer(Modifier.width(8.dp))
        Row(
            modifier = Modifier.weight(1f)
                .clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(10.dp).clip(CircleShape).background(RocColors.Danger)
                    .graphicsLayer { alpha = dotAlpha },
            )
            Spacer(Modifier.width(8.dp))
            Text(
                fmtDuration(elapsed),
                color = RocColors.RocGold,
                fontSize = 13.sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
            )
            Spacer(Modifier.width(10.dp))
            WaveformCompose(levels = levels, modifier = Modifier.weight(1f).height(32.dp))
        }
        Spacer(Modifier.width(8.dp))
        IconButton(onClick = onSend) {
            Box(
                Modifier.size(44.dp).clip(CircleShape).background(RocColors.RocGold),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Send, contentDescription = "Send", tint = Color.White)
            }
        }
    }
}

@Composable
private fun WaveformCompose(levels: List<Float>, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        levels.forEach { lvl ->
            val h by animateFloatAsStateSafe(targetValue = lvl.coerceIn(0.08f, 1f))
            Box(
                Modifier
                    .width(3.dp)
                    .fillMaxHeight(h)
                    .clip(RoundedCornerShape(2.dp))
                    .background(RocColors.RocGold),
            )
        }
    }
}

@Composable
private fun animateFloatAsStateSafe(targetValue: Float): State<Float> =
    androidx.compose.animation.core.animateFloatAsState(
        targetValue = targetValue,
        animationSpec = tween(120, easing = LinearEasing),
        label = "wave",
    )

@Composable
fun AudioPreviewBarCompose(
    filePath: String,
    duration: Int,
    onDiscard: () -> Unit,
    onSend: () -> Unit,
) {
    var isPlaying by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf(0f) }
    val player = remember { MediaPlayer() }
    val handler = remember { Handler(Looper.getMainLooper()) }
    var prepared by remember { mutableStateOf(false) }

    DisposableEffect(filePath) {
        try {
            player.setDataSource(filePath)
            player.prepare()
            prepared = true
        } catch (_: Exception) {}
        player.setOnCompletionListener {
            isPlaying = false
            progress = 0f
        }
        onDispose {
            try { player.stop() } catch (_: Exception) {}
            try { player.release() } catch (_: Exception) {}
        }
    }

    LaunchedEffect(isPlaying) {
        while (isPlaying) {
            if (prepared) {
                val d = player.duration.coerceAtLeast(1)
                progress = player.currentPosition.toFloat() / d
            }
            delay(50)
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onDiscard) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(RocColors.Danger.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Delete, contentDescription = "Discard", tint = RocColors.Danger)
            }
        }
        Spacer(Modifier.width(8.dp))
        Row(
            modifier = Modifier.weight(1f)
                .clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                modifier = Modifier.size(32.dp),
                onClick = {
                    if (!prepared) return@IconButton
                    if (isPlaying) {
                        player.pause(); isPlaying = false
                    } else {
                        player.start(); isPlaying = true
                    }
                },
            ) {
                Icon(
                    if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                    contentDescription = null,
                    tint = RocColors.RocGold,
                )
            }
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp))
                .background(RocColors.RocGold.copy(alpha = 0.2f))) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(progress.coerceIn(0f, 1f))
                    .background(RocColors.RocGold))
            }
            Spacer(Modifier.width(8.dp))
            Text(fmtDuration(duration), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(8.dp))
        IconButton(onClick = onSend) {
            Box(
                Modifier.size(44.dp).clip(CircleShape).background(RocColors.RocGold),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Send, contentDescription = "Send", tint = Color.White)
            }
        }
    }
}

// ── Full-screen video recorder dialog ──

@Composable
fun VideoMessageRecorderDialog(
    onResult: (File?, Int) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor: Executor = remember { ContextCompat.getMainExecutor(context) }

    var camFront by remember { mutableStateOf(true) }
    var recording by remember { mutableStateOf(false) }
    var elapsed by remember { mutableStateOf(0) }
    var pendingFile by remember { mutableStateOf<File?>(null) }
    var pendingDuration by remember { mutableStateOf(0) }
    var videoCapture by remember { mutableStateOf<VideoCapture<Recorder>?>(null) }
    var activeRecording by remember { mutableStateOf<Recording?>(null) }
    val previewView = remember { PreviewView(context) }

    val hasPerms = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    LaunchedEffect(camFront, hasPerms) {
        if (!hasPerms) return@LaunchedEffect
        try {
            val providerFuture = ProcessCameraProvider.getInstance(context)
            providerFuture.addListener({
                val provider = providerFuture.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val recorder = Recorder.Builder()
                    .setQualitySelector(QualitySelector.from(Quality.HD))
                    .build()
                val vc = VideoCapture.withOutput(recorder)
                videoCapture = vc
                val selector = if (camFront) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                try {
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, selector, preview, vc)
                } catch (_: Exception) {}
            }, executor)
        } catch (_: Exception) {}
    }

    LaunchedEffect(recording) {
        if (!recording) return@LaunchedEffect
        elapsed = 0
        while (recording) {
            delay(1000)
            elapsed += 1
            if (elapsed >= 120) {
                activeRecording?.stop()
                break
            }
        }
    }

    Dialog(
        onDismissRequest = { onResult(null, 0) },
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = true),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

            Column(Modifier.fillMaxSize().padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = {
                        activeRecording?.stop(); activeRecording = null
                        pendingFile?.delete()
                        onResult(null, 0)
                    }) {
                        Box(Modifier.size(40.dp).clip(CircleShape).background(Color.Black.copy(0.5f)),
                            contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.Close, contentDescription = "Close", tint = Color.White)
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    if (recording) {
                        Row(
                            Modifier.clip(RoundedCornerShape(20.dp)).background(Color.Black.copy(0.5f))
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(10.dp).clip(CircleShape).background(RocColors.Danger))
                            Spacer(Modifier.width(6.dp))
                            Text(fmtDuration(elapsed), color = Color.White, fontSize = 14.sp)
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = { camFront = !camFront }) {
                        Box(Modifier.size(40.dp).clip(CircleShape).background(Color.Black.copy(0.5f)),
                            contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.Videocam, contentDescription = "Flip", tint = Color.White)
                        }
                    }
                }

                Spacer(Modifier.weight(1f))

                if (pendingFile != null) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = {
                            pendingFile?.delete(); pendingFile = null; pendingDuration = 0
                        }) {
                            Box(Modifier.size(64.dp).clip(CircleShape).background(Color.Black.copy(0.5f)),
                                contentAlignment = Alignment.Center) {
                                Icon(Icons.Default.Refresh, contentDescription = "Retake", tint = Color.White)
                            }
                        }
                        IconButton(onClick = {
                            val f = pendingFile; val d = pendingDuration
                            pendingFile = null
                            onResult(f, d)
                        }) {
                            Box(Modifier.size(72.dp).clip(CircleShape).background(RocColors.RocGold),
                                contentAlignment = Alignment.Center) {
                                Icon(Icons.Default.Send, contentDescription = "Send", tint = Color.White)
                            }
                        }
                    }
                } else {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        IconButton(onClick = {
                            if (recording) {
                                activeRecording?.stop()
                            } else {
                                val vc = videoCapture ?: return@IconButton
                                val file = File(context.cacheDir, "video_note_${System.currentTimeMillis()}.mp4")
                                val out = FileOutputOptions.Builder(file).build()
                                val pending = vc.output.prepareRecording(context, out)
                                try { pending.withAudioEnabled() } catch (_: Exception) {}
                                activeRecording = pending.start(executor) { event ->
                                    when (event) {
                                        is VideoRecordEvent.Start -> {
                                            recording = true
                                        }
                                        is VideoRecordEvent.Finalize -> {
                                            val dur = elapsed.coerceAtLeast(1)
                                            recording = false
                                            activeRecording = null
                                            if (!event.hasError() && file.exists() && file.length() > 0) {
                                                pendingFile = file
                                                pendingDuration = dur
                                            } else {
                                                file.delete()
                                            }
                                        }
                                        else -> {}
                                    }
                                }
                            }
                        }) {
                            Box(
                                Modifier.size(88.dp).clip(CircleShape)
                                    .background(Color.White.copy(alpha = if (recording) 0f else 0.15f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Box(
                                    Modifier.size(if (recording) 36.dp else 64.dp)
                                        .clip(if (recording) RoundedCornerShape(6.dp) else CircleShape)
                                        .background(if (recording) RocColors.Danger else Color.White),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
