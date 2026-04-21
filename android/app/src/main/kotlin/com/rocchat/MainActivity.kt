package com.rocchat

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.rocchat.ui.RocChatTheme
import com.rocchat.ui.RocColors
import com.rocchat.auth.AuthScreen
import com.rocchat.auth.BiometricHelper
import com.rocchat.chat.MainScreen
import com.rocchat.crypto.SecureStorage
import com.rocchat.network.APIClient
import com.rocchat.push.PushManager
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
        setContent {
            RocChatTheme {
                val prefs = getSharedPreferences("rocchat", MODE_PRIVATE)
                val hasSession = SecureStorage.get(this@MainActivity, "session_token", "rocchat") != null
                var isAuthenticated by remember { mutableStateOf(hasSession) }
                var biometricLocked by remember {
                    mutableStateOf(
                        hasSession &&
                        BiometricHelper.isBiometricEnabled(this@MainActivity) &&
                        BiometricHelper.isBiometricAvailable(this@MainActivity)
                    )
                }

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
                        MainScreen(
                            onLogout = {
                                // Server-side session invalidation
                                kotlinx.coroutines.MainScope().launch {
                                    try { APIClient.postPublic("/auth/logout", org.json.JSONObject()) } catch (_: Exception) {}
                                }
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
