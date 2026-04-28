package com.rocchat

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.rocchat.ui.RocChatTheme
import com.rocchat.ui.RocColors
import com.rocchat.ui.AppThemePreference
import com.rocchat.auth.AuthScreen
import com.rocchat.auth.BiometricHelper
import com.rocchat.chat.MainScreen
import com.rocchat.crypto.SecureStorage
import com.rocchat.network.APIClient
import com.rocchat.push.PushManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        APIClient.initialize(this)
        enableEdgeToEdge()

        // Prevent screenshots & screen recording
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )

        // Create notification channel
        PushManager.createNotificationChannel(this)

        // Root detection advisory check
        val rootResult = RootDetectionHelper.check()
        if (rootResult.isRooted) {
            // We don't block — just warn the user about elevated risk
            android.util.Log.w("RocChat", "Root indicators detected: ${rootResult.reasons}")
            // Will show advisory dialog once the Compose UI is up (via a state flag)
        }
        val deviceIsRooted = rootResult.isRooted
        setContent {
            val prefs = getSharedPreferences("rocchat", MODE_PRIVATE)
            val appThemePref = when (prefs.getString("app_theme", "system")) {
                "dark" -> AppThemePreference.DARK
                "light" -> AppThemePreference.LIGHT
                else -> AppThemePreference.SYSTEM
            }
            val fontScalePref = (prefs.getString("app_font_scale", "1.0") ?: "1.0").toFloatOrNull() ?: 1f
            RocChatTheme(appTheme = appThemePref, fontScale = fontScalePref.coerceIn(0.9f, 1.2f)) {
                val hasSession = SecureStorage.get(this@MainActivity, "session_token", "rocchat") != null
                var isAuthenticated by remember { mutableStateOf(hasSession) }
                var biometricLocked by remember {
                    mutableStateOf(
                        hasSession &&
                        BiometricHelper.isBiometricEnabled(this@MainActivity) &&
                        BiometricHelper.isBiometricAvailable(this@MainActivity)
                    )
                }
                var showSplash by remember { mutableStateOf(true) }

                // Dismiss splash after 0.8s
                LaunchedEffect(Unit) {
                    delay(800)
                    showSplash = false
                }

                Box(modifier = Modifier.fillMaxSize()) {
                    // Main content underneath
                    // Restore token on launch and register push
                    LaunchedEffect(isAuthenticated) {
                    val token = SecureStorage.get(this@MainActivity, "session_token", "rocchat")
                    if (token != null) {
                        APIClient.sessionToken = token
                        APIClient.refreshToken = SecureStorage.get(this@MainActivity, "refresh_token", "rocchat")
                    }
                    if (isAuthenticated) {
                        val userId = prefs.getString("user_id", null)
                        if (userId != null) {
                            PushManager.registerAndSubscribe(this@MainActivity, userId)
                        }
                        // Key maintenance: SPK rotation + prekey replenishment
                        com.rocchat.crypto.KeyRotationManager.performMaintenance(this@MainActivity)

                        // Always-on user-inbox WS — call routing registered once (see InboxWebSocket).
                        com.rocchat.calls.InboxWebSocket.ensureDefaultCallRouting(this@MainActivity)
                    }
                }

                // Re-lock when returning from background
                val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
                DisposableEffect(lifecycleOwner) {
                    val observer = LifecycleEventObserver { _, event ->
                        if (event == Lifecycle.Event.ON_STOP) {
                            if (BiometricHelper.isBiometricEnabled(this@MainActivity) &&
                                BiometricHelper.isBiometricAvailable(this@MainActivity) &&
                                isAuthenticated) {
                                biometricLocked = true
                            }
                        }
                    }
                    lifecycleOwner.lifecycle.addObserver(observer)
                    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
                }

                when {
                    biometricLocked -> {
                        BiometricLockScreen(
                            onFallback = {
                                biometricLocked = false
                                APIClient.sessionToken = null
                                APIClient.refreshToken = null
                                APIClient.clearPersistedAuth()
                                prefs.edit().clear().apply()
                                isAuthenticated = false
                            }
                        )
                        LaunchedEffect(Unit) {
                            // Root advisory shown once per app session before biometric
                            if (deviceIsRooted) {
                                // Shown after biometric so we don't block the lock screen
                            }
                            BiometricHelper.authenticate(
                                this@MainActivity,
                                onSuccess = { biometricLocked = false; isAuthenticated = true },
                                onFailure = {
                                    biometricLocked = false
                                    APIClient.sessionToken = null
                                    APIClient.refreshToken = null
                                    APIClient.clearPersistedAuth()
                                    prefs.edit().clear().apply()
                                    isAuthenticated = false
                                },
                            )
                        }
                    }
                    isAuthenticated -> {
                        var showRootWarning by remember { mutableStateOf(deviceIsRooted) }
                        if (showRootWarning) {
                            AlertDialog(
                                onDismissRequest = { showRootWarning = false },
                                title = { Text("Security Advisory") },
                                text = { Text("This device appears to be rooted or running a custom OS build. Rooting removes important security boundaries that protect your encryption keys. For maximum security, use RocChat on an unmodified device.") },
                                confirmButton = { TextButton(onClick = { showRootWarning = false }) { Text("I Understand") } },
                            )
                        }
                        MainScreen(
                            onLogout = {
                                // Server-side session invalidation
                                kotlinx.coroutines.MainScope().launch {
                                    try { APIClient.postPublic("/auth/logout", org.json.JSONObject()) } catch (_: Exception) {}
                                }
                                com.rocchat.calls.InboxWebSocket.disconnect()
                                APIClient.sessionToken = null
                                APIClient.refreshToken = null
                                APIClient.clearPersistedAuth()
                                prefs.edit().clear().apply()
                                isAuthenticated = false
                            }
                        )
                    }
                    else -> {
                        AuthScreen(
                            onSuccess = { isAuthenticated = true }
                        )
                    }
                }

                    // Splash overlay
                    AnimatedVisibility(
                        visible = showSplash,
                        exit = fadeOut(animationSpec = tween(500)),
                        modifier = Modifier.zIndex(999f)
                    ) {
                        RocSplashScreen()
                    }
                }
            }
        }
    }
}

@Composable
fun BiometricLockScreen(onFallback: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(RocColors.MidnightAzure),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("🔒", fontSize = 64.sp)
            Spacer(Modifier.height(16.dp))
            Text(
                "RocChat is Locked",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = RocColors.RocGold
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Use biometrics to unlock",
                fontSize = 14.sp,
                color = RocColors.TextSecondary
            )
            Spacer(Modifier.height(32.dp))
            TextButton(onClick = onFallback) {
                Text("Use Passphrase Instead", color = RocColors.RocGold)
            }
        }
    }
}

@Composable
fun RocSplashScreen() {
    val warmBg1 = Color(0xFF1A1410)
    val warmBg2 = Color(0xFF0F0D0A)
    val gold = Color(0xFFD4AF37)
    val turquoise = Color(0xFF40E0D0)

    // Spinner rotation
    val infiniteTransition = rememberInfiniteTransition(label = "splash")
    val spinAngle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(animation = tween(800, easing = LinearEasing)),
        label = "spin"
    )
    val ringScale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(
            animation = tween(1500, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "ring"
    )

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.linearGradient(colors = listOf(warmBg1, warmBg2, warmBg1))),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            // Security rings + icon
            Box(contentAlignment = Alignment.Center) {
                Canvas(modifier = Modifier.size(170.dp)) {
                    val center = Offset(size.width / 2, size.height / 2)
                    // Ring 3
                    drawCircle(color = gold.copy(alpha = 0.06f * ringScale), radius = 85.dp.toPx() * ringScale, center = center, style = Stroke(1.5f))
                    // Ring 2
                    drawCircle(color = gold.copy(alpha = 0.12f * ringScale), radius = 70.dp.toPx() * ringScale, center = center, style = Stroke(1.5f))
                    // Ring 1
                    drawCircle(color = gold.copy(alpha = 0.2f * ringScale), radius = 55.dp.toPx() * ringScale, center = center, style = Stroke(1.5f))
                }
                // Placeholder icon text (real app would use the SVG resource)
                Text("R", fontSize = 42.sp, fontWeight = FontWeight.Bold, color = gold)
            }

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                "RocChat",
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = gold
            )

            Spacer(modifier = Modifier.height(4.dp))

            Text(
                "End-to-end encrypted",
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                color = turquoise
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Spinner
            Canvas(
                modifier = Modifier
                    .size(24.dp)
                    .rotate(spinAngle)
            ) {
                drawArc(
                    color = gold,
                    startAngle = 0f,
                    sweepAngle = 252f,
                    useCenter = false,
                    style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round),
                    topLeft = Offset.Zero,
                    size = Size(size.width, size.height)
                )
            }
        }
    }
}
