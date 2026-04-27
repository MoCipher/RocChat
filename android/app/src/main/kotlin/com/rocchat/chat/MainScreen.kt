package com.rocchat.chat

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn as AndroidOptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.layout.imePadding
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.rocchat.calls.CallManager
import com.rocchat.calls.CallOverlay
import com.rocchat.calls.CallsHistoryTab
import com.rocchat.crypto.GroupSessionManager
import com.rocchat.crypto.SessionManager
import com.rocchat.network.APIClient
import com.rocchat.network.NativeWebSocket
import com.rocchat.ui.RocColors
import com.rocchat.ui.chatThemes
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import com.rocchat.crypto.SecureStorage

// ── Encrypted metadata helpers (typing, presence, read receipts) ──
// Key: SHA256(identityKey + ":meta:" + conversationId) → AES-GCM-256
// Format: base64(iv) + "." + base64(ciphertext+tag) — matches web/iOS encryptMeta()

private fun getMetaKeyBytes(context: Context, conversationId: String): ByteArray {
    val vkB64 = SecureStorage.get(context, "rocchat_vault_key")
    if (vkB64 != null) {
        val vk = android.util.Base64.decode(vkB64, android.util.Base64.NO_WRAP)
        val info = "rocchat:meta:$conversationId"
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(vk)
        val expandMac = javax.crypto.Mac.getInstance("HmacSHA256")
        expandMac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
        return expandMac.doFinal(info.toByteArray() + byteArrayOf(0x01)).copyOf(32)
    }
    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
    val idKey = prefs.getString("identity_pub", conversationId) ?: conversationId
    val raw = "$idKey:meta:$conversationId".toByteArray(Charsets.UTF_8)
    return MessageDigest.getInstance("SHA-256").digest(raw)
}

private fun encryptMeta(context: Context, conversationId: String, data: JSONObject): String? {
    return try {
        val keyBytes = getMetaKeyBytes(context, conversationId)
        val key = SecretKeySpec(keyBytes, "AES")
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(data.toString().toByteArray(Charsets.UTF_8))
        android.util.Base64.encodeToString(iv, android.util.Base64.NO_WRAP) + "." +
                android.util.Base64.encodeToString(ct, android.util.Base64.NO_WRAP)
    } catch (_: Exception) { null }
}

private fun decryptMeta(context: Context, conversationId: String, payload: String): JSONObject? {
    return try {
        val parts = payload.split(".", limit = 2)
        if (parts.size != 2) return null
        val iv = android.util.Base64.decode(parts[0], android.util.Base64.DEFAULT)
        val ct = android.util.Base64.decode(parts[1], android.util.Base64.DEFAULT)
        if (iv.size != 12) return null
        val keyBytes = getMetaKeyBytes(context, conversationId)
        val key = SecretKeySpec(keyBytes, "AES")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        val plain = cipher.doFinal(ct)
        JSONObject(String(plain, Charsets.UTF_8))
    } catch (_: Exception) { null }
}

// Profile field encryption: HKDF(vaultKey, "rocchat:profile:encrypt") → AES-GCM-256
// Vault key is passphrase-derived and NEVER leaves the device, so the
// server cannot derive this key.
internal fun hkdfProfileKey(ikm: ByteArray, info: String): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
    val prk = mac.doFinal(ikm)
    val expandMac = Mac.getInstance("HmacSHA256")
    expandMac.init(SecretKeySpec(prk, "HmacSHA256"))
    expandMac.update(info.toByteArray(Charsets.UTF_8))
    expandMac.update(byteArrayOf(1))
    return expandMac.doFinal()
}

internal fun profileEncryptionKey(context: Context): SecretKeySpec {
    val vkB64 = SecureStorage.get(context, "rocchat_vault_key")
    if (vkB64 != null) {
        val vk = android.util.Base64.decode(vkB64, android.util.Base64.NO_WRAP)
        val keyBytes = hkdfProfileKey(vk, "rocchat:profile:encrypt")
        return SecretKeySpec(keyBytes, "AES")
    }
    return legacyProfileKey(context)
}

internal fun legacyProfileKey(context: Context): SecretKeySpec {
    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
    val idKey = prefs.getString("identity_pub", "default") ?: "default"
    val keyBytes = MessageDigest.getInstance("SHA-256").digest("$idKey:profile:encrypt".toByteArray(Charsets.UTF_8))
    return SecretKeySpec(keyBytes, "AES")
}

internal fun encryptProfileField(context: Context, value: String): String {
    if (value.isEmpty()) return value
    return try {
        val key = profileEncryptionKey(context)
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        android.util.Base64.encodeToString(iv, android.util.Base64.NO_WRAP) + "." +
                android.util.Base64.encodeToString(ct, android.util.Base64.NO_WRAP)
    } catch (_: Exception) { value }
}

private fun decryptProfileField(context: Context, value: String): String {
    if (!value.contains(".")) return value
    return try {
        val parts = value.split(".", limit = 2)
        if (parts.size != 2) return value
        val iv = android.util.Base64.decode(parts[0], android.util.Base64.DEFAULT)
        val ct = android.util.Base64.decode(parts[1], android.util.Base64.DEFAULT)
        if (iv.size != 12 || ct.size < 16) return value
        // Try vault-derived key first, then legacy for backward compat
        val key = profileEncryptionKey(context)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            return String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (_: Exception) {
            val legacy = legacyProfileKey(context)
            val legacyCipher = Cipher.getInstance("AES/GCM/NoPadding")
            legacyCipher.init(Cipher.DECRYPT_MODE, legacy, GCMParameterSpec(128, iv))
            return String(legacyCipher.doFinal(ct), Charsets.UTF_8)
        }
    } catch (_: Exception) { value }
}

// ── Main Screen with 3 Tabs ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(onLogout: () -> Unit) {
    var selectedTab by remember { mutableIntStateOf(0) }
    // State for navigating into a conversation
    var openConversationId by remember { mutableStateOf<String?>(null) }
    var openConversationName by remember { mutableStateOf("") }
    var openRecipientUserId by remember { mutableStateOf("") }

    if (openConversationId != null) {
        ConversationScreen(
            conversationId = openConversationId!!,
            conversationName = openConversationName,
            recipientUserId = openRecipientUserId,
            onBack = { openConversationId = null },
        )
        return
    }

    val snackbarHostState = remember { SnackbarHostState() }
    val navItemColors = NavigationBarItemDefaults.colors(
        selectedIconColor = RocColors.RocGold,
        selectedTextColor = RocColors.RocGold,
        indicatorColor = RocColors.RocGold.copy(alpha = 0.12f),
    )

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    icon = { Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = "Chats") },
                    label = { Text("Chats") },
                    colors = navItemColors,
                )
                NavigationBarItem(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    icon = { Icon(Icons.Default.Phone, contentDescription = "Calls") },
                    label = { Text("Calls") },
                    colors = navItemColors,
                )
                NavigationBarItem(
                    selected = selectedTab == 2,
                    onClick = { selectedTab = 2 },
                    icon = { Icon(Icons.Default.Campaign, contentDescription = "Channels") },
                    label = { Text("Channels") },
                    colors = navItemColors,
                )
                NavigationBarItem(
                    selected = selectedTab == 3,
                    onClick = { selectedTab = 3 },
                    icon = { Icon(Icons.Default.Person, contentDescription = "Profile") },
                    label = { Text("Profile") },
                    colors = navItemColors,
                )
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (selectedTab) {
                0 -> ChatsTab(
                    onOpenConversation = { id, name, recipientId ->
                        openConversationId = id
                        openConversationName = name
                        openRecipientUserId = recipientId
                    },
                    snackbarHostState = snackbarHostState,
                )
                1 -> CallsHistoryTab()
                2 -> ChannelsTab()
                3 -> SettingsTab(onLogout = onLogout)
            }
            CallOverlay()
        }
    }
}

// ── Avatar Composable ──

@Composable
fun AvatarImage(name: String, avatarUrl: String?, size: Int = 52) {
    val initials = name.split(" ").mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }.take(2).joinToString("")
    val fullUrl = avatarUrl?.let { if (it.startsWith("http")) it else "https://chat.mocipher.com$it" }

    if (!fullUrl.isNullOrBlank()) {
        SubcomposeAsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(fullUrl)
                .crossfade(true)
                .build(),
            contentDescription = name,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(size.dp).clip(CircleShape),
            error = { FallbackAvatar(initials, size) },
            loading = { FallbackAvatar(initials, size) },
        )
    } else {
        FallbackAvatar(initials, size)
    }
}

@Composable
private fun FallbackAvatar(initials: String, size: Int) {
    Box(
        Modifier.size(size.dp).clip(CircleShape).background(
            brush = androidx.compose.ui.graphics.Brush.linearGradient(
                colors = listOf(RocColors.RocGoldLight, RocColors.RocGold, RocColors.RocGoldDark)
            )
        ),
        contentAlignment = Alignment.Center,
    ) {
        Text(initials, color = androidx.compose.ui.graphics.Color.White, fontWeight = FontWeight.Bold, fontSize = (size * 0.33).sp)
    }
}

private fun sniffMime(bytes: ByteArray, filename: String): String {
    val h = bytes.take(12)
    fun startsWith(vararg b: Int) = h.size >= b.size && b.indices.all { h[it] == b[it].toByte() }
    if (startsWith(0xFF, 0xD8, 0xFF))                            return "image/jpeg"
    if (startsWith(0x89, 0x50, 0x4E, 0x47))                     return "image/png"
    if (startsWith(0x47, 0x49, 0x46))                            return "image/gif"
    if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.size >= 12 &&
        bytes.slice(8..11) == listOf(0x57, 0x45, 0x42, 0x50).map { it.toByte() }) return "image/webp"
    if (bytes.size >= 8 && bytes.slice(4..7) == listOf(0x66, 0x74, 0x79, 0x70).map { it.toByte() }) return "video/mp4"
    if (startsWith(0x1A, 0x45, 0xDF, 0xA3))                     return "video/webm"
    if (startsWith(0xFF, 0xFB) || startsWith(0xFF, 0xF3) || startsWith(0x49, 0x44, 0x33)) return "audio/mpeg"
    if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.size >= 12 &&
        bytes.slice(8..11) == listOf(0x57, 0x41, 0x56, 0x45).map { it.toByte() }) return "audio/wav"
    if (startsWith(0x4F, 0x67, 0x67, 0x53))                     return "audio/ogg"
    val ext = filename.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "jpg", "jpeg" -> "image/jpeg"
        "png"  -> "image/png"
        "gif"  -> "image/gif"
        "webp" -> "image/webp"
        "mp4"  -> "video/mp4"
        "mov"  -> "video/quicktime"
        "webm" -> "video/webm"
        "mp3"  -> "audio/mpeg"
        "ogg"  -> "audio/ogg"
        "wav"  -> "audio/wav"
        "m4a"  -> "audio/mp4"
        "pdf"  -> "application/pdf"
        else   -> "application/octet-stream"
    }
}

private fun mediaTypePreview(type: String?): String = when (type) {
    "image"      -> "📷 Photo"
    "video"      -> "🎥 Video"
    "voice_note" -> "🎤 Voice message"
    "file"       -> "📎 File"
    "call_offer", "call_answer", "call_end" -> "📞 Call activity"
    else         -> "Encrypted message"
}

// ── Chats Tab: Conversation List ──

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ChatsTab(onOpenConversation: (String, String, String) -> Unit, snackbarHostState: SnackbarHostState = remember { SnackbarHostState() }) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var conversations by remember { mutableStateOf<List<APIClient.Conversation>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var showNewChat by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<APIClient.UserSearchResult>>(emptyList()) }
    var showNotifModePicker by remember { mutableStateOf(false) }
    var notifModeConvId by remember { mutableStateOf("") }

    // Folder state
    var folders by remember { mutableStateOf<List<Triple<String, String, String>>>(emptyList()) }
    var folderConvIds by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var selectedFolderId by remember { mutableStateOf<String?>(null) }
    var showFolderDialog by remember { mutableStateOf(false) }
    var longPressConvId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            conversations = APIClient.getConversations()
        } catch (e: Exception) {
            snackbarHostState.showSnackbar("Failed to load conversations")
        }
        try {
            val arr = APIClient.getArray("/features/folders")
            val fList = mutableListOf<Triple<String, String, String>>()
            val fConvMap = mutableMapOf<String, List<String>>()
            for (i in 0 until arr.length()) {
                val f = arr.getJSONObject(i)
                val id = f.getString("id")
                fList.add(Triple(id, f.getString("name"), f.optString("icon", "📁")))
                val cids = f.optJSONArray("conversation_ids") ?: JSONArray()
                val cidList = mutableListOf<String>()
                for (j in 0 until cids.length()) cidList.add(cids.getString(j))
                fConvMap[id] = cidList
            }
            folders = fList
            folderConvIds = fConvMap
        } catch (_: Exception) {}
        isLoading = false
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Chats", fontWeight = FontWeight.Bold) },
            actions = {
                IconButton(onClick = { showFolderDialog = true }) {
                    Icon(Icons.Default.Folder, contentDescription = "Manage folders", tint = RocColors.RocGold)
                }
                IconButton(onClick = { showNewChat = true }) {
                    Icon(Icons.Default.Edit, contentDescription = "New chat", tint = RocColors.RocGold)
                }
            },
        )

        // Search bar
        OutlinedTextField(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            placeholder = { Text("Search conversations...") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            trailingIcon = {
                if (searchQuery.isNotBlank()) {
                    IconButton(onClick = { searchQuery = "" }) {
                        Icon(Icons.Default.Close, contentDescription = "Clear")
                    }
                }
            },
            shape = RoundedCornerShape(20.dp),
        )

        if (folders.isNotEmpty()) {
            LazyRow(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    Surface(
                        onClick = { selectedFolderId = null },
                        shape = RoundedCornerShape(16.dp),
                        color = if (selectedFolderId == null) RocColors.RocGold else MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = if (selectedFolderId == null) androidx.compose.ui.graphics.Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
                    ) {
                        Text("All", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    }
                }
                items(folders.size) { index ->
                    val (fId, fName, fIcon) = folders[index]
                    Surface(
                        onClick = { selectedFolderId = if (selectedFolderId == fId) null else fId },
                        shape = RoundedCornerShape(16.dp),
                        color = if (selectedFolderId == fId) RocColors.RocGold else MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = if (selectedFolderId == fId) androidx.compose.ui.graphics.Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
                    ) {
                        Text("$fIcon $fName", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    }
                }
            }
        }

        if (isLoading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = RocColors.RocGold)
            }
        } else if (conversations.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Email, contentDescription = null, modifier = Modifier.size(48.dp), tint = RocColors.RocGold.copy(alpha = 0.3f))
                    Spacer(Modifier.height(12.dp))
                    Text("No conversations yet", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    Text("Start a new conversation to begin messaging securely.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(12.dp))
                    Text("🔒 End-to-end encrypted", color = RocColors.Turquoise, style = MaterialTheme.typography.labelSmall)
                }
            }
        } else {
            val userId = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                .getString("user_id", "") ?: ""

            val filteredConversations = run {
                var list = if (selectedFolderId != null) {
                    val ids = folderConvIds[selectedFolderId] ?: emptyList()
                    conversations.filter { it.id in ids }
                } else conversations
                // Apply search filter
                if (searchQuery.isNotBlank()) {
                    list = list.filter { conv ->
                        val name = conv.name ?: conv.members.joinToString(", ") { it.displayName.ifBlank { it.username } }
                        name.contains(searchQuery, ignoreCase = true)
                    }
                }
                list
            }

            var isRefreshing by remember { mutableStateOf(false) }
            PullToRefreshBox(
                isRefreshing = isRefreshing,
                onRefresh = {
                    scope.launch {
                        isRefreshing = true
                        try { conversations = APIClient.getConversations() } catch (e: Exception) {
                            snackbarHostState.showSnackbar("Network error — pull to retry")
                        }
                        isRefreshing = false
                    }
                },
            ) {
            LazyColumn {
                items(filteredConversations, key = { it.id }) { conv ->
                    val name = conv.name ?: conv.members
                        .filter { it.userId != userId }
                        .joinToString(", ") { it.displayName.ifBlank { it.username } }
                        .ifBlank { "Unknown" }
                    val other = conv.members.firstOrNull { it.userId != userId }
                    val dismissState = rememberSwipeToDismissBoxState(
                        confirmValueChange = { value ->
                            when (value) {
                                SwipeToDismissBoxValue.EndToStart -> {
                                    scope.launch {
                                        try {
                                            APIClient.deleteConversation(conv.id)
                                            conversations = conversations.filter { it.id != conv.id }
                                        } catch (_: Exception) {}
                                    }
                                    true
                                }
                                SwipeToDismissBoxValue.StartToEnd -> {
                                    notifModeConvId = conv.id
                                    showNotifModePicker = true
                                    false // don't dismiss, show picker
                                }
                                else -> false
                            }
                        }
                    )

                    SwipeToDismissBox(
                        state = dismissState,
                        backgroundContent = {
                            val direction = dismissState.dismissDirection
                            val color = when (direction) {
                                SwipeToDismissBoxValue.EndToStart -> RocColors.Danger
                                SwipeToDismissBoxValue.StartToEnd -> RocColors.RocGold
                                else -> androidx.compose.ui.graphics.Color.Transparent
                            }
                            val icon = when (direction) {
                                SwipeToDismissBoxValue.EndToStart -> Icons.Default.Delete
                                SwipeToDismissBoxValue.StartToEnd -> if (conv.muted) Icons.Default.VolumeUp else Icons.Default.VolumeOff
                                else -> Icons.Default.Delete
                            }
                            val alignment = when (direction) {
                                SwipeToDismissBoxValue.EndToStart -> Alignment.CenterEnd
                                else -> Alignment.CenterStart
                            }
                            Box(
                                Modifier.fillMaxSize().background(color).padding(horizontal = 20.dp),
                                contentAlignment = alignment,
                            ) {
                                Icon(icon, contentDescription = null, tint = androidx.compose.ui.graphics.Color.White)
                            }
                        },
                    ) {
                        Box {
                            ListItem(
                                headlineContent = {
                                    Text(name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        color = MaterialTheme.colorScheme.onSurface)
                                },
                                supportingContent = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text("🔒 ", fontSize = 10.sp)
                                        Text(mediaTypePreview(conv.lastMessageType), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                                    }
                                },
                                leadingContent = {
                                    AvatarImage(name = name, avatarUrl = other?.avatarUrl, size = 52)
                                },
                                trailingContent = {
                                    Column(horizontalAlignment = Alignment.End) {
                                        conv.lastMessageAt?.let {
                                            Text(formatRelativeTime(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        if (conv.muted) {
                                            Spacer(Modifier.height(4.dp))
                                            Icon(Icons.Default.VolumeOff, contentDescription = "Muted",
                                                modifier = Modifier.size(14.dp), tint = RocColors.TextSecondary)
                                        }
                                    }
                                },
                                modifier = Modifier.combinedClickable(
                                    onClick = {
                                        val recipientId = conv.members.firstOrNull { it.userId != userId }?.userId ?: ""
                                        onOpenConversation(conv.id, name, recipientId)
                                    },
                                    onLongClick = { longPressConvId = conv.id },
                                ),
                            )
                            DropdownMenu(
                                expanded = longPressConvId == conv.id,
                                onDismissRequest = { longPressConvId = null },
                            ) {
                                if (folders.isNotEmpty()) {
                                    Text("Add to Folder", modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                                        fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = RocColors.TextSecondary)
                                    folders.forEach { (fId, fName, fIcon) ->
                                        DropdownMenuItem(
                                            text = { Text("$fIcon $fName") },
                                            onClick = {
                                                scope.launch {
                                                    try {
                                                        APIClient.post("/features/folders/$fId/chats",
                                                            JSONObject().put("conversation_id", conv.id))
                                                        folderConvIds = folderConvIds.toMutableMap().apply {
                                                            this[fId] = (this[fId] ?: emptyList()) + conv.id
                                                        }
                                                    } catch (_: Exception) {}
                                                }
                                                longPressConvId = null
                                            },
                                        )
                                    }
                                    val inFolders = folders.filter { (fId, _, _) -> folderConvIds[fId]?.contains(conv.id) == true }
                                    if (inFolders.isNotEmpty()) {
                                        HorizontalDivider()
                                        inFolders.forEach { (fId, fName, fIcon) ->
                                            DropdownMenuItem(
                                                text = { Text("Remove from $fIcon $fName", color = RocColors.Danger) },
                                                onClick = {
                                                    scope.launch {
                                                        try {
                                                            APIClient.delete("/features/folders/$fId/chats/${conv.id}")
                                                            folderConvIds = folderConvIds.toMutableMap().apply {
                                                                this[fId] = (this[fId] ?: emptyList()) - conv.id
                                                            }
                                                        } catch (_: Exception) {}
                                                    }
                                                    longPressConvId = null
                                                },
                                            )
                                        }
                                    }
                                } else {
                                    Text("No folders yet", modifier = Modifier.padding(12.dp),
                                        color = RocColors.TextSecondary, fontSize = 14.sp)
                                }
                            }
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(start = 76.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                }
            }
            }
        }
    }

    // Notification Mode Picker
    if (showNotifModePicker) {
        AlertDialog(
            onDismissRequest = { showNotifModePicker = false },
            title = { Text("Notification Mode") },
            text = {
                Column {
                    listOf(
                        "normal" to "Normal — All notifications",
                        "quiet" to "Quiet — Badge only, no sound",
                        "focus" to "Focus — @mentions & replies only",
                        "emergency" to "Emergency — Calls ring only",
                        "silent" to "Silent — No notifications"
                    ).forEach { (mode, label) ->
                        TextButton(
                            onClick = {
                                scope.launch {
                                    try {
                                        APIClient.post("/messages/conversations/$notifModeConvId/notification-mode",
                                            org.json.JSONObject().put("mode", mode))
                                        conversations = APIClient.getConversations()
                                    } catch (_: Exception) {}
                                }
                                showNotifModePicker = false
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(label, color = if (mode == "normal") RocColors.RocGold else MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showNotifModePicker = false }) {
                    Text("Cancel")
                }
            }
        )
    }

    // Folder Management Dialog
    if (showFolderDialog) {
        var newFolderName by remember { mutableStateOf("") }
        var newFolderIcon by remember { mutableStateOf("📁") }
        val iconPresets = listOf("📁", "💼", "👥", "🏠", "⭐", "🔒", "💬", "🎮", "📚", "🛒")

        AlertDialog(
            onDismissRequest = { showFolderDialog = false },
            title = { Text("Chat Folders") },
            text = {
                Column {
                    folders.forEach { (fId, fName, fIcon) ->
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("$fIcon $fName", modifier = Modifier.weight(1f))
                            IconButton(onClick = {
                                scope.launch {
                                    try {
                                        APIClient.delete("/features/folders/$fId")
                                        folders = folders.filter { it.first != fId }
                                        folderConvIds = folderConvIds - fId
                                        if (selectedFolderId == fId) selectedFolderId = null
                                    } catch (_: Exception) {}
                                }
                            }) {
                                Icon(Icons.Default.Delete, contentDescription = "Delete folder",
                                    tint = RocColors.Danger, modifier = Modifier.size(20.dp))
                            }
                        }
                    }
                    if (folders.isNotEmpty()) HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                    Text("Create Folder", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = newFolderName,
                        onValueChange = { newFolderName = it },
                        label = { Text("Folder name") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("Icon", fontSize = 13.sp, color = RocColors.TextSecondary)
                    Spacer(Modifier.height(4.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        items(iconPresets.size) { idx ->
                            Surface(
                                onClick = { newFolderIcon = iconPresets[idx] },
                                shape = RoundedCornerShape(8.dp),
                                color = if (newFolderIcon == iconPresets[idx]) RocColors.RocGold.copy(alpha = 0.2f)
                                    else MaterialTheme.colorScheme.surfaceVariant,
                                border = if (newFolderIcon == iconPresets[idx]) BorderStroke(2.dp, RocColors.RocGold) else null,
                            ) {
                                Text(iconPresets[idx], modifier = Modifier.padding(8.dp), fontSize = 20.sp)
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (newFolderName.isNotBlank()) {
                            scope.launch {
                                try {
                                    val result = APIClient.post("/features/folders",
                                        JSONObject().put("name", newFolderName).put("icon", newFolderIcon))
                                    val id = result.getString("id")
                                    folders = folders + Triple(id, newFolderName, newFolderIcon)
                                    folderConvIds = folderConvIds + (id to emptyList())
                                    newFolderName = ""
                                    newFolderIcon = "📁"
                                } catch (_: Exception) {}
                            }
                        }
                    },
                    enabled = newFolderName.isNotBlank(),
                ) {
                    Text("Create", color = if (newFolderName.isNotBlank()) RocColors.RocGold else RocColors.TextSecondary)
                }
            },
            dismissButton = {
                TextButton(onClick = { showFolderDialog = false }) { Text("Done") }
            },
        )
    }

    // New Chat Dialog
    if (showNewChat) {
        var chatMode by remember { mutableStateOf("direct") }
        var selectedUsers by remember { mutableStateOf<List<APIClient.UserSearchResult>>(emptyList()) }
        var groupName by remember { mutableStateOf("") }
        var newChatSearch by remember { mutableStateOf("") }
        var newChatResults by remember { mutableStateOf<List<APIClient.UserSearchResult>>(emptyList()) }

        AlertDialog(
            onDismissRequest = { showNewChat = false },
            title = { Text("New Conversation") },
            text = {
                Column {
                    // Direct / Group toggle
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = chatMode == "direct", onClick = { chatMode = "direct"; selectedUsers = emptyList() }, label = { Text("Direct") })
                        FilterChip(selected = chatMode == "group", onClick = { chatMode = "group" }, label = { Text("Group") })
                    }
                    Spacer(Modifier.height(8.dp))
                    if (chatMode == "group") {
                        OutlinedTextField(
                            value = groupName,
                            onValueChange = { groupName = it },
                            label = { Text("Group Name") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                        )
                        Spacer(Modifier.height(4.dp))
                        if (selectedUsers.isNotEmpty()) {
                            Text("Members: ${selectedUsers.joinToString(", ") { it.displayName }}", fontSize = 12.sp, color = RocColors.TextSecondary)
                            Spacer(Modifier.height(4.dp))
                        }
                    }
                    OutlinedTextField(
                        value = newChatSearch,
                        onValueChange = { q ->
                            newChatSearch = q
                            if (q.length >= 3) {
                                scope.launch {
                                    try {
                                        newChatResults = APIClient.searchUsers(q.removePrefix("@"))
                                    } catch (_: Exception) {}
                                }
                            }
                        },
                        label = { Text("Search @username") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    newChatResults.forEach { user ->
                        ListItem(
                            headlineContent = { Text(user.displayName) },
                            supportingContent = { Text("@${user.username}") },
                            modifier = Modifier.clickable {
                                if (chatMode == "direct") {
                                    scope.launch {
                                        try {
                                            val convId = APIClient.createConversation("direct", listOf(user.userId))
                                            onOpenConversation(convId, user.displayName, user.userId)
                                            showNewChat = false
                                        } catch (_: Exception) {}
                                    }
                                } else {
                                    if (selectedUsers.none { it.userId == user.userId }) {
                                        selectedUsers = selectedUsers + user
                                    }
                                }
                            },
                        )
                    }
                }
            },
            confirmButton = {
                if (chatMode == "group" && selectedUsers.size >= 2) {
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                val encMeta = encryptProfileField(context, groupName.trim())
                                val convId = APIClient.createConversation("group", selectedUsers.map { it.userId }, encMeta)
                                onOpenConversation(convId, groupName.ifBlank { "Group" }, "")
                                showNewChat = false
                            } catch (_: Exception) {}
                        }
                    }) { Text("Create Group") }
                }
            },
            dismissButton = {
                TextButton(onClick = { showNewChat = false }) { Text("Cancel") }
            },
        )
    }
}

// ── Conversation Screen: Messages + Composer ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(conversationId: String, conversationName: String, recipientUserId: String = "", onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val convSnackbarHostState = remember { SnackbarHostState() }
    var messages by remember { mutableStateOf<List<APIClient.ChatMessage>>(emptyList()) }
    var inputText by remember { mutableStateOf("") }
    var isSending by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
    val userId = prefs.getString("user_id", "") ?: ""
    var ws by remember { mutableStateOf<NativeWebSocket?>(null) }
    var disappearTimer by remember { mutableIntStateOf(prefs.getInt("disappear_$conversationId", 0)) }
    var showDisappearMenu by remember { mutableStateOf(false) }
    var showSafetyDialog by remember { mutableStateOf(false) }
    var showScheduleDialog by remember { mutableStateOf(false) }
    var safetyNumberText by remember { mutableStateOf("") }
    var isRecordingVoice by remember { mutableStateOf(false) }
    var recordingElapsed by remember { mutableIntStateOf(0) }
    var recordingLevels by remember { mutableStateOf(List(32) { 0.1f }) }
    var pendingAudioPath by remember { mutableStateOf<String?>(null) }
    var pendingAudioDuration by remember { mutableIntStateOf(0) }
    var showVideoRecorder by remember { mutableStateOf(false) }
    var isOffline by remember { mutableStateOf(false) }
    var editingMessageId by remember { mutableStateOf<String?>(null) }
    var replyingTo by remember { mutableStateOf<APIClient.ChatMessage?>(null) }
    var forwardingMessage by remember { mutableStateOf<APIClient.ChatMessage?>(null) }
    var showForwardDialog by remember { mutableStateOf(false) }
    var searchText by remember { mutableStateOf("") }
    var isSearching by remember { mutableStateOf(false) }
    var isRemoteTyping by remember { mutableStateOf(false) }
    var remoteOnlineStatus by remember { mutableStateOf("") }
    var lastTypingSent by remember { mutableStateOf(0L) }
    var showThemePicker by remember { mutableStateOf(false) }
    var chatTheme by remember { mutableStateOf(prefs.getString("theme_$conversationId", "default") ?: "default") }
    var showStickerPicker by remember { mutableStateOf(false) }
    var showVaultComposer by remember { mutableStateOf(false) }
    var vaultType by remember { mutableStateOf("password") }
    var vaultLabel by remember { mutableStateOf("") }
    var vaultFields by remember { mutableStateOf(mutableMapOf<String, String>()) }
    var vaultViewOnce by remember { mutableStateOf(false) }
    var showPinnedMessages by remember { mutableStateOf(false) }
    var pinnedMessages by remember { mutableStateOf<List<APIClient.ChatMessage>>(emptyList()) }
    var showMediaGallery by remember { mutableStateOf(false) }
    var showGroupAdmin by remember { mutableStateOf(false) }
    var groupMembers by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    val haptics = LocalHapticFeedback.current

    // Backup import file picker
    val backupImportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null && backupPassphrase.length >= 12) {
            scope.launch {
                backupStatus = "Importing..."
                try {
                    val bytes = context.contentResolver.openInputStream(uri)?.readBytes() ?: throw Exception("Cannot read file")
                    val header = "ROCCHAT-BACKUP-2"
                    val headerBytes = header.toByteArray()
                    if (bytes.size < headerBytes.size + 16 + 12 + 16) throw Exception("Invalid backup file")
                    val fileHeader = String(bytes.sliceArray(0 until headerBytes.size))
                    if (fileHeader != header) throw Exception("Not a RocChat backup")
                    val salt = bytes.sliceArray(headerBytes.size until headerBytes.size + 16)
                    val iv = bytes.sliceArray(headerBytes.size + 16 until headerBytes.size + 28)
                    val ciphertext = bytes.sliceArray(headerBytes.size + 28 until bytes.size)
                    val md = java.security.MessageDigest.getInstance("SHA-256")
                    md.update(backupPassphrase.toByteArray())
                    md.update(salt)
                    val keyBytes = md.digest()
                    val key = javax.crypto.spec.SecretKeySpec(keyBytes, "AES")
                    val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(javax.crypto.Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, iv))
                    val plain = cipher.doFinal(ciphertext)
                    val json = JSONObject(String(plain))
                    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit()
                    json.keys().forEach { k -> prefs.putString(k, json.getString(k)) }
                    prefs.apply()
                    backupStatus = "✅ Backup restored successfully"
                } catch (e: Exception) {
                    backupStatus = "Import failed: ${e.message}"
                }
            }
        }
    }

    // File/photo picker
    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        uri?.let {
            scope.launch {
                try {
                    val inputStream = context.contentResolver.openInputStream(it) ?: return@launch
                    val data = inputStream.readBytes()
                    inputStream.close()
                    val mime = context.contentResolver.getType(it) ?: "application/octet-stream"
                    val filename = it.lastPathSegment ?: "file"
                    // Upload encrypted
                    val encrypted = SessionManager.encryptFileData(context, data)
                    val blobId = APIClient.uploadMedia(encrypted)
                    val payload = JSONObject().apply {
                        put("type", "file")
                        put("blob_id", blobId)
                        put("filename", filename)
                        put("mime", mime)
                        put("size", data.size)
                    }
                    val plaintext = payload.toString()
                    if (recipientUserId.isNotEmpty()) {
                        val env = SessionManager.encryptMessage(context, conversationId, recipientUserId, plaintext)
                        APIClient.sendMessage(conversationId, env.ciphertext, env.iv, env.ratchetHeader, "file")
                    } else {
                        val groupEnvelope = GroupSessionManager.getInstance(context).encrypt(conversationId, plaintext.toByteArray(), userId)
                        APIClient.sendMessage(conversationId, groupEnvelope.ciphertext, "", groupEnvelope.ratchetHeader, "file")
                    }
                    messages = messages + APIClient.ChatMessage(
                        id = "local-${System.currentTimeMillis()}", conversationId = conversationId,
                        senderId = userId, ciphertext = "📎 $filename", iv = "", ratchetHeader = "",
                        messageType = "file", createdAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).format(Date())
                    )
                } catch (_: Exception) {}
            }
        }
    }

    // Load messages
    LaunchedEffect(conversationId) {
        try {
            val raw = APIClient.getMessages(conversationId)
            messages = raw.map { msg ->
                if (msg.ratchetHeader.isNotEmpty()) {
                    val displayText = if (GroupSessionManager.isGroupEncrypted(msg.ratchetHeader)) {
                        try {
                            val rhJson = JSONObject(msg.ratchetHeader)
                            val senderId = rhJson.optString("senderId", "")
                            String(GroupSessionManager.getInstance(context).decrypt(conversationId, senderId, msg.ciphertext, msg.ratchetHeader))
                        } catch (_: Exception) { "[Unable to decrypt]" }
                    } else if (msg.iv.isNotEmpty()) {
                        try {
                            SessionManager.decryptMessage(context, conversationId, msg.ciphertext, msg.iv, msg.ratchetHeader)
                        } catch (_: Exception) { "[Unable to decrypt]" }
                    } else "[Unable to decrypt]"
                    msg.copy(ciphertext = displayText)
                } else msg
            }
            // Send encrypted read receipt for last message from the other user
            val lastFromOther = messages.lastOrNull { it.senderId != userId }
            if (lastFromOther != null) {
                val enc = encryptMeta(context, conversationId, JSONObject().apply {
                    put("message_id", lastFromOther.id)
                })
                if (enc != null) {
                    ws?.send(JSONObject().apply {
                        put("type", "read_receipt")
                        put("payload", JSONObject().apply { put("e", enc) })
                    }.toString())
                }
            }
        } catch (e: Exception) {
            convSnackbarHostState.showSnackbar("Failed to load messages")
        }
    }

    // Scroll to bottom when messages change
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    // WebSocket connection with automatic reconnection
    DisposableEffect(conversationId) {
        if (APIClient.sessionToken == null) return@DisposableEffect onDispose {}
        var reconnectAttempt = 0
        var reconnectJob: kotlinx.coroutines.Job? = null

        suspend fun connectWs() {
            val ticketJson = try {
                APIClient.post("/ws/ticket", JSONObject())
            } catch (_: Exception) { null }
            val ticket = ticketJson?.optString("ticket", null)
            if (ticket.isNullOrEmpty()) return
            val wsUrl = "wss://rocchat-api.spoass.workers.dev/api/ws/$conversationId?userId=$userId&deviceId=android&ticket=$ticket"
            val listener = object : NativeWebSocket.Listener {
                override fun onOpen(ws: NativeWebSocket) {
                    reconnectAttempt = 0
                }
                override fun onMessage(ws: NativeWebSocket, text: String) {
                    try {
                        val data = JSONObject(text)
                        when (data.optString("type")) {
                            "message" -> {
                                val payload = data.getJSONObject("payload")
                                val ct = payload.optString("ciphertext", "")
                                val ivStr = payload.optString("iv", "")
                                val rh = payload.optString("ratchet_header", "")
                                val displayText = if (rh.isNotEmpty()) {
                                    if (GroupSessionManager.isGroupEncrypted(rh)) {
                                        try {
                                            val rhJson = JSONObject(rh)
                                            val senderId = rhJson.optString("senderId", "")
                                            String(GroupSessionManager.getInstance(context).decrypt(conversationId, senderId, ct, rh))
                                        } catch (_: Exception) { "[Unable to decrypt]" }
                                    } else if (ivStr.isNotEmpty()) {
                                        try { SessionManager.decryptMessage(context, conversationId, ct, ivStr, rh) } catch (_: Exception) { "[Unable to decrypt]" }
                                    } else "[Unable to decrypt]"
                                } else "[Unable to decrypt]"
                                val newMsg = APIClient.ChatMessage(
                                    id = payload.optString("id", "ws-${System.currentTimeMillis()}"),
                                    conversationId = conversationId,
                                    senderId = payload.optString("fromUserId", payload.optString("sender_id", "")),
                                    ciphertext = displayText,
                                    iv = "",
                                    ratchetHeader = "",
                                    messageType = payload.optString("message_type", "text"),
                                    createdAt = payload.optString("created_at", Date().toString()),
                                )
                                messages = messages + newMsg
                                // Send encrypted delivery receipt back
                                if (newMsg.senderId != userId) {
                                    val enc = encryptMeta(context, conversationId, JSONObject().apply {
                                        put("message_id", newMsg.id)
                                    })
                                    if (enc != null) {
                                        ws?.send(JSONObject().apply {
                                            put("type", "delivery_receipt")
                                            put("payload", JSONObject().apply { put("e", enc) })
                                        }.toString())
                                    }
                                }
                            }
                            "delivery_receipt", "read_receipt" -> {
                                val payload = data.getJSONObject("payload")
                                val enc = payload.optString("e", "")
                                if (enc.isNotEmpty()) {
                                    val msgId = decryptMeta(context, conversationId, enc)?.optString("message_id") ?: ""
                                    val newStatus = if (data.optString("type") == "read_receipt") "read" else "delivered"
                                    if (msgId.isNotEmpty()) {
                                        messages = messages.map { if (it.id == msgId) it.copy(status = newStatus) else it }
                                    }
                                }
                            }
                            "typing" -> {
                                val payload = data.getJSONObject("payload")
                                val enc = payload.optString("e", "")
                                if (enc.isNotEmpty()) {
                                    val meta = decryptMeta(context, conversationId, enc)
                                    val isTyping = meta?.optBoolean("isTyping", false) ?: false
                                    if (isTyping) {
                                        isRemoteTyping = true
                                        scope.launch {
                                            delay(4000)
                                            isRemoteTyping = false
                                        }
                                    } else {
                                        isRemoteTyping = false
                                    }
                                }
                            }
                            "presence" -> {
                                val payload = data.getJSONObject("payload")
                                val enc = payload.optString("e", "")
                                if (enc.isNotEmpty()) {
                                    val meta = decryptMeta(context, conversationId, enc)
                                    val status = meta?.optString("status") ?: ""
                                    if (status.isNotEmpty()) remoteOnlineStatus = status
                                }
                            }
                            "reaction" -> {
                                val payload = data.getJSONObject("payload")
                                val msgId = payload.optString("message_id")
                                val encReaction = payload.optString("encrypted_reaction", "")
                                val emoji = if (encReaction.isNotEmpty()) decryptProfileField(context, encReaction) else ""
                                messages = messages.map {
                                    if (it.id == msgId) {
                                        val cur = it.reactions ?: ""
                                        it.copy(reactions = if (cur.isEmpty()) emoji else "$cur,$emoji")
                                    } else it
                                }
                            }
                            "message_edit" -> {
                                val payload = data.getJSONObject("payload")
                                val msgId = payload.optString("message_id")
                                val newCt = payload.optString("ciphertext", "")
                                val newIv = payload.optString("iv", "")
                                val newRh = payload.optString("ratchet_header", "")
                                messages = messages.map {
                                    if (it.id == msgId) {
                                        val displayText = if (newRh.isNotEmpty()) {
                                            if (GroupSessionManager.isGroupEncrypted(newRh)) {
                                                try {
                                                    val rhJson = JSONObject(newRh)
                                                    val senderId = rhJson.optString("senderId", "")
                                                    String(GroupSessionManager.getInstance(context).decrypt(conversationId, senderId, newCt, newRh))
                                                } catch (_: Exception) { "[Unable to decrypt]" }
                                            } else if (newIv.isNotEmpty()) {
                                                try { SessionManager.decryptMessage(context, conversationId, newCt, newIv, newRh) }
                                                catch (_: Exception) { "[Unable to decrypt]" }
                                            } else "[Unable to decrypt]"
                                        } else "[Unable to decrypt]"
                                        it.copy(ciphertext = "$displayText (edited)")
                                    } else it
                                }
                            }
                            "message_delete" -> {
                                val payload = data.getJSONObject("payload")
                                val msgId = payload.optString("message_id")
                                messages = messages.filter { it.id != msgId }
                            }
                            "message_pin" -> {
                                // Pin notification — no UI update needed in chat list
                            }
                            "call_offer" -> {
                                val payload = data.getJSONObject("payload")
                                CallManager.handleIncomingOffer(payload, conversationId, ws)
                            }
                            "call_answer" -> CallManager.handleCallAnswer(data.getJSONObject("payload"))
                            "call_ice" -> CallManager.handleIceCandidate(data.getJSONObject("payload"))
                            "call_end" -> CallManager.handleCallEnd(data.getJSONObject("payload"))
                            "call_audio" -> CallManager.handleCallAudio(data.getJSONObject("payload"))
                            "call_video" -> CallManager.handleCallVideo(data.getJSONObject("payload"))
                            "call_p2p_candidate" -> CallManager.handleP2PCandidate(data.getJSONObject("payload"))
                        }
                    } catch (_: Exception) {}
                }
                override fun onClosed(ws: NativeWebSocket, code: Int, reason: String) {
                    if (code != 1000) {
                        // Reconnect with exponential backoff + jitter
                        reconnectJob = scope.launch {
                            val delay = minOf(30000L, (1000L shl minOf(reconnectAttempt, 5)) + (0..500).random())
                            reconnectAttempt++
                            kotlinx.coroutines.delay(delay)
                            try { connectWs() } catch (_: Exception) {}
                        }
                    }
                }
                override fun onFailure(ws: NativeWebSocket, error: Throwable) {
                    reconnectJob = scope.launch {
                        val delay = minOf(30000L, (1000L shl minOf(reconnectAttempt, 5)) + (0..500).random())
                        reconnectAttempt++
                        kotlinx.coroutines.delay(delay)
                        try { connectWs() } catch (_: Exception) {}
                    }
                }
            }
            try {
                ws = NativeWebSocket.connect(wsUrl, listener)
            } catch (_: Exception) {
                reconnectJob = scope.launch {
                    val delay = minOf(30000L, (1000L shl minOf(reconnectAttempt, 5)) + (0..500).random())
                    reconnectAttempt++
                    kotlinx.coroutines.delay(delay)
                    try { connectWs() } catch (_: Exception) {}
                }
            }
        }

        scope.launch { connectWs() }
        // Flush any queued offline messages
        scope.launch {
            val flushed = flushMessageQueue(context)
            if (flushed) isOffline = false
        }
        onDispose {
            reconnectJob?.cancel()
            ws?.close(1000, "bye")
            ws = null
        }
    }

    // Screenshot detection (Android 14+ ScreenCaptureCallback, older via ContentObserver)
    DisposableEffect(conversationId) {
        val activity = context as? android.app.Activity
        if (android.os.Build.VERSION.SDK_INT >= 34 && activity != null) {
            val callback = android.app.Activity.ScreenCaptureCallback {
                scope.launch {
                    try {
                        // Encrypt the screenshot alert through the Double Ratchet session
                        if (recipientUserId.isNotEmpty()) {
                            val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, "📸 Screenshot taken")
                            val body = org.json.JSONObject().apply {
                                put("conversation_id", conversationId)
                                put("ciphertext", envelope.ciphertext)
                                put("iv", envelope.iv)
                                put("ratchet_header", envelope.ratchetHeader)
                                put("message_type", "screenshot_alert")
                            }
                            APIClient.post("/messages/send", body)
                        }
                    } catch (_: Exception) {}
                }
            }
            activity.registerScreenCaptureCallback(activity.mainExecutor, callback)
            onDispose { activity.unregisterScreenCaptureCallback(callback) }
        } else {
            // Fallback for Android < 14: ContentObserver on Screenshots
            val observer = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
                private var lastTimestamp = System.currentTimeMillis()
                override fun onChange(selfChange: Boolean, uri: android.net.Uri?) {
                    super.onChange(selfChange, uri)
                    val now = System.currentTimeMillis()
                    if (now - lastTimestamp < 2000) return // debounce
                    lastTimestamp = now
                    // Check if path contains "screenshot"
                    val path = uri?.path?.lowercase() ?: return
                    if (!path.contains("screenshot")) return
                    scope.launch {
                        try {
                            if (recipientUserId.isNotEmpty()) {
                                val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, "📸 Screenshot taken")
                                val body = org.json.JSONObject().apply {
                                    put("conversation_id", conversationId)
                                    put("ciphertext", envelope.ciphertext)
                                    put("iv", envelope.iv)
                                    put("ratchet_header", envelope.ratchetHeader)
                                    put("message_type", "screenshot_alert")
                                }
                                APIClient.post("/messages/send", body)
                            }
                        } catch (_: Exception) {}
                    }
                }
            }
            try {
                context.contentResolver.registerContentObserver(
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    true, observer
                )
            } catch (_: Exception) {}
            onDispose {
                context.contentResolver.unregisterContentObserver(observer)
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(convSnackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(conversationName, style = MaterialTheme.typography.titleMedium)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (remoteOnlineStatus.isNotEmpty()) {
                                Surface(
                                    shape = CircleShape,
                                    color = if (remoteOnlineStatus == "online") Color.Green else Color.Gray,
                                    modifier = Modifier.size(8.dp),
                                ) {}
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    if (remoteOnlineStatus == "online") "Online" else "Offline",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (remoteOnlineStatus == "online") Color.Green else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(Modifier.width(6.dp))
                            }
                            Text("🔒 E2EE", style = MaterialTheme.typography.labelSmall, color = RocColors.Turquoise)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (recipientUserId.isEmpty()) {
                        // Group conversation — group call button
                        IconButton(onClick = {
                            ws?.let { w ->
                                scope.launch {
                                    try {
                                        val convData = APIClient.get("/messages/conversations/$conversationId")
                                        val membersArr = convData.optJSONArray("members")
                                        val memberIds = if (membersArr != null) (0 until membersArr.length()).map { membersArr.getJSONObject(it).getString("user_id") } else emptyList()
                                        CallManager.startGroupCall(conversationId, "voice", w, memberIds)
                                    } catch (_: Exception) {
                                        CallManager.startGroupCall(conversationId, "voice", w, emptyList())
                                    }
                                }
                            }
                        }) {
                            Icon(Icons.Default.Phone, contentDescription = "Group Call", tint = RocColors.RocGold)
                        }
                    } else {
                        IconButton(onClick = {
                            ws?.let { CallManager.startCall(conversationId, userId, conversationName, "voice", it) }
                        }) {
                            Icon(Icons.Default.Phone, contentDescription = "Call", tint = RocColors.RocGold)
                        }
                        IconButton(onClick = {
                            ws?.let { CallManager.startCall(conversationId, userId, conversationName, "video", it) }
                        }) {
                            Icon(Icons.Default.Videocam, contentDescription = "Video", tint = RocColors.RocGold)
                        }
                    }
                    IconButton(onClick = { showDisappearMenu = true }) {
                        Icon(
                            Icons.Default.Timer,
                            contentDescription = "Disappearing",
                            tint = if (disappearTimer > 0) RocColors.Turquoise else RocColors.RocGold,
                        )
                    }
                    IconButton(onClick = { showSafetyDialog = true }) {
                        Icon(Icons.Default.Security, contentDescription = "Safety Number", tint = RocColors.RocGold)
                    }
                    IconButton(onClick = { showThemePicker = true }) {
                        Icon(Icons.Default.Palette, contentDescription = "Chat Theme", tint = RocColors.RocGold)
                    }
                    IconButton(onClick = {
                        scope.launch {
                            try {
                                val data = APIClient.get("/messages/conversations/$conversationId/pins")
                                val pins = data.optJSONArray("pins")
                                pinnedMessages = if (pins != null) (0 until pins.length()).map { i ->
                                    val m = pins.getJSONObject(i)
                                    APIClient.ChatMessage(m.getString("id"), conversationId, m.optString("sender_id", ""), m.optString("ciphertext", ""), m.optString("iv", ""), m.optString("ratchet_header", ""), m.optString("message_type", "text"), m.optString("created_at", ""), null, "sent")
                                } else emptyList()
                            } catch (_: Exception) {}
                        }
                        showPinnedMessages = true
                    }) {
                        Icon(Icons.Default.PushPin, contentDescription = "Pinned", tint = RocColors.RocGold)
                    }
                    IconButton(onClick = { showMediaGallery = true }) {
                        Icon(Icons.Default.Photo, contentDescription = "Media Gallery", tint = RocColors.RocGold)
                    }
                    IconButton(onClick = { isSearching = !isSearching }) {
                        Icon(Icons.Default.Search, contentDescription = "Search messages", tint = RocColors.RocGold)
                    }
                },
            )
        },
    ) { padding ->
        val activeThemeBg = chatThemes.firstOrNull { it.key == chatTheme }?.bgColor ?: Color.Transparent
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).imePadding()
                .then(if (chatTheme != "default") Modifier.background(activeThemeBg) else Modifier),
        ) {
            // Encryption banner
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(RocColors.Turquoise.copy(alpha = 0.08f))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Default.Lock, contentDescription = null, modifier = Modifier.size(14.dp), tint = RocColors.Turquoise)
                Spacer(Modifier.width(6.dp))
                Text("Messages are end-to-end encrypted", style = MaterialTheme.typography.labelSmall, color = RocColors.Turquoise)
            }

            // Search bar
            if (isSearching) {
                OutlinedTextField(
                    value = searchText,
                    onValueChange = { searchText = it },
                    placeholder = { Text("Search messages...") },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    singleLine = true,
                    trailingIcon = {
                        IconButton(onClick = { searchText = ""; isSearching = false }) {
                            Icon(Icons.Default.Close, "Close search")
                        }
                    },
                    shape = RoundedCornerShape(20.dp),
                )
            }

            // Messages
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                state = listState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                val filteredMessages = messages.filter { msg ->
                    val ea = msg.expiresAt
                    val notExpired = ea == null || ea > (System.currentTimeMillis() / 1000)
                    if (searchText.isNotEmpty()) {
                        notExpired && msg.ciphertext.contains(searchText, ignoreCase = true)
                    } else notExpired
                }

                // Date separators + message grouping
                val groupedItems = buildMessageListItems(filteredMessages, userId)

                groupedItems.forEach { listItem ->
                    when (listItem) {
                        is MessageListItem.DateHeader -> {
                            item(key = "date-${listItem.label}") {
                                Box(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = listItem.label,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier
                                            .background(
                                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                                                shape = RoundedCornerShape(12.dp),
                                            )
                                            .padding(horizontal = 12.dp, vertical = 4.dp),
                                    )
                                }
                            }
                        }
                        is MessageListItem.Msg -> {
                            val msg = listItem.message
                            val groupPosition = listItem.groupPosition
                            val showTimestamp = listItem.showTimestamp
                            val spacing = if (listItem.tightSpacing) 1.dp else 4.dp
                            item(key = msg.id) {
                                Spacer(Modifier.height(spacing))
                                val isMine = msg.senderId == userId
                    if (msg.messageType == "screenshot_alert") {
                        val senderName = if (msg.senderId == userId) "You"
                            else groupMembers.firstOrNull { it.optString("user_id") == msg.senderId }
                                ?.run { optString("display_name").ifBlank { optString("username") } }
                                ?: conversationName
                        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Text(
                                text = "📸 $senderName took a screenshot",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                                modifier = Modifier
                                    .background(MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(50))
                                    .padding(horizontal = 12.dp, vertical = 4.dp),
                            )
                        }
                        return@item
                    }
                    MessageBubble(
                        msg = msg,
                        isMine = isMine,
                        groupPosition = groupPosition,
                        showTimestamp = showTimestamp,
                        onReact = { emoji ->
                            scope.launch { try { APIClient.post("/messages/${msg.id}/react", JSONObject().put("encrypted_reaction", encryptProfileField(context, emoji))) } catch (_: Exception) {} }
                        },
                        onEdit = { editingMessageId = msg.id; inputText = msg.ciphertext },
                        onDelete = {
                            scope.launch {
                                try { APIClient.delete("/messages/${msg.id}"); messages = messages.filter { it.id != msg.id } } catch (_: Exception) {}
                            }
                        },
                        onPin = {
                            scope.launch { try { APIClient.post("/messages/conversations/$conversationId/pin/${msg.id}", JSONObject()) } catch (_: Exception) {} }
                        },
                        onReply = { replyingTo = msg },
                        onForward = { forwardingMessage = msg; showForwardDialog = true },
                        onBlock = {
                            scope.launch { try { APIClient.post("/contacts/block", JSONObject().put("userId", msg.senderId).put("blocked", true)) } catch (_: Exception) {} }
                        },
                    )
                            } // item
                        } // Msg
                    } // when
                } // forEach
            }

            // Typing indicator
            if (isRemoteTyping) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BouncingDotsIndicator()
                }
            }

            // Reply preview banner
            replyingTo?.let { reply ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(RocColors.RocGold.copy(alpha = 0.08f))
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .width(3.dp)
                            .height(32.dp)
                            .background(RocColors.RocGold, RoundedCornerShape(1.5.dp))
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (reply.senderId == userId) "Replying to yourself" else "Replying to message",
                            style = MaterialTheme.typography.labelSmall,
                            color = RocColors.RocGold,
                        )
                        Text(
                            if (reply.ciphertext.isBlank()) "🔒 Encrypted" else reply.ciphertext,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    IconButton(onClick = { replyingTo = null }) {
                        Icon(Icons.Default.Close, contentDescription = "Cancel reply",
                             tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }

            // Composer
            if (pendingAudioPath != null) {
                AudioPreviewBarCompose(
                    filePath = pendingAudioPath!!,
                    duration = pendingAudioDuration,
                    onDiscard = {
                        java.io.File(pendingAudioPath!!).delete()
                        pendingAudioPath = null; pendingAudioDuration = 0
                    },
                    onSend = {
                        val path = pendingAudioPath!!
                        val dur = pendingAudioDuration
                        pendingAudioPath = null; pendingAudioDuration = 0
                        sendPreparedVoiceNote(context, conversationId, recipientUserId, scope, userId, path, dur) {
                            messages = messages + it
                        }
                    },
                )
            } else if (isRecordingVoice) {
                RecordingBarCompose(
                    elapsed = recordingElapsed,
                    levels = recordingLevels,
                    onCancel = {
                        cancelVoiceRecording()
                        isRecordingVoice = false
                        recordingElapsed = 0
                        recordingLevels = List(32) { 0.1f }
                    },
                    onSend = {
                        val (path, dur) = finishVoiceRecordingToPreview() ?: (null to 0)
                        isRecordingVoice = false
                        recordingLevels = List(32) { 0.1f }
                        if (path != null) {
                            pendingAudioPath = path
                            pendingAudioDuration = dur
                        }
                        recordingElapsed = 0
                    },
                )
            } else {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Attachment menu
                    var showAttachMenu by remember { mutableStateOf(false) }
                    Box {
                        IconButton(onClick = { showAttachMenu = true }) {
                            Icon(Icons.Default.Add, contentDescription = "Attach", tint = RocColors.RocGold)
                        }
                        DropdownMenu(expanded = showAttachMenu, onDismissRequest = { showAttachMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Photo & Video") },
                                leadingIcon = { Icon(Icons.Default.Image, null) },
                                onClick = { showAttachMenu = false; photoPickerLauncher.launch("image/*") }
                            )
                            DropdownMenuItem(
                                text = { Text("Document") },
                                leadingIcon = { Icon(Icons.Default.Description, null) },
                                onClick = { showAttachMenu = false; photoPickerLauncher.launch("*/*") }
                            )
                            DropdownMenuItem(
                                text = { Text("Voice Note") },
                                leadingIcon = { Icon(Icons.Default.Mic, null) },
                                onClick = { showAttachMenu = false; startVoiceRecording(context) { isRecordingVoice = true } }
                            )
                            DropdownMenuItem(
                                text = { Text("Video Message") },
                                leadingIcon = { Icon(Icons.Default.Videocam, null) },
                                onClick = { showAttachMenu = false; showVideoRecorder = true }
                            )
                            DropdownMenuItem(
                                text = { Text("Vault Item") },
                                leadingIcon = { Icon(Icons.Default.Lock, null) },
                                onClick = { showAttachMenu = false; showVaultComposer = true }
                            )
                        }
                    }
                OutlinedTextField(
                    value = inputText,
                    onValueChange = { newVal ->
                        inputText = newVal
                        // Send encrypted typing indicator (throttled to 3s)
                        val now = System.currentTimeMillis()
                        if (now - lastTypingSent > 3000) {
                            lastTypingSent = now
                            val enc = encryptMeta(context, conversationId, JSONObject().apply {
                                put("isTyping", true)
                            })
                            if (enc != null) {
                                ws?.send(JSONObject().apply {
                                    put("type", "typing")
                                    put("payload", JSONObject().apply { put("e", enc) })
                                }.toString())
                            }
                        }
                    },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Type a message...") },
                    maxLines = 4,
                    shape = RoundedCornerShape(24.dp),
                    trailingIcon = {
                        IconButton(onClick = { showStickerPicker = !showStickerPicker }, modifier = Modifier.size(32.dp)) {
                            Icon(Icons.Default.EmojiEmotions, contentDescription = "Emoji", tint = RocColors.RocGold.copy(alpha = 0.7f), modifier = Modifier.size(20.dp))
                        }
                    },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(
                        onSend = {
                            if (inputText.isNotBlank() && !isSending) {
                                val text = inputText.trim()
                                inputText = ""
                                isSending = true
                                val replyToId = replyingTo?.id
                                replyingTo = null
                                val localId = "queued-${System.currentTimeMillis()}"
                                scope.launch {
                                    // Edit mode
                                    val editId = editingMessageId
                                    if (editId != null) {
                                        editingMessageId = null
                                        try {
                                            val encPayload = JSONObject()
                                            if (recipientUserId.isNotEmpty()) {
                                                val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, text)
                                                encPayload.put("ciphertext", envelope.ciphertext)
                                                encPayload.put("iv", envelope.iv)
                                                encPayload.put("ratchet_header", envelope.ratchetHeader)
                                                encPayload.put("message_type", "text")
                                            } else {
                                                val groupEnvelope = GroupSessionManager.getInstance(context).encrypt(conversationId, text.toByteArray(), userId)
                                                encPayload.put("ciphertext", groupEnvelope.ciphertext)
                                                encPayload.put("iv", "")
                                                encPayload.put("ratchet_header", groupEnvelope.ratchetHeader)
                                                encPayload.put("message_type", "text")
                                            }
                                            APIClient.post("/messages/$editId", JSONObject().put("encrypted", encPayload.toString()), method = "PATCH")
                                            messages = messages.map { if (it.id == editId) it.copy(ciphertext = text) else it }
                                        } catch (_: Exception) {}
                                        isSending = false
                                        return@launch
                                    }
                                    try {
                                        if (recipientUserId.isNotEmpty()) {
                                            val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, text)
                                            APIClient.sendMessage(conversationId, envelope.ciphertext, envelope.iv, envelope.ratchetHeader, "text", disappearTimer, replyTo = replyToId)
                                        } else {
                                            val groupEnvelope = GroupSessionManager.getInstance(context).encrypt(conversationId, text.toByteArray(), userId)
                                            APIClient.sendMessage(conversationId, groupEnvelope.ciphertext, "", groupEnvelope.ratchetHeader, "text", disappearTimer, replyTo = replyToId)
                                        }
                                        messages = messages + APIClient.ChatMessage(
                                            id = "local-${System.currentTimeMillis()}",
                                            conversationId = conversationId,
                                            senderId = userId,
                                            ciphertext = text,
                                            iv = "", ratchetHeader = "",
                                            messageType = "text",
                                            createdAt = Date().toString(),
                                        )
                                    } catch (_: Exception) {
                                        queueMessage(context, localId, conversationId, text, recipientUserId)
                                        messages = messages + APIClient.ChatMessage(
                                            id = localId, conversationId = conversationId,
                                            senderId = userId, ciphertext = "⏳ $text",
                                            iv = "", ratchetHeader = "", messageType = "text",
                                            createdAt = Date().toString(),
                                        )
                                        isOffline = true
                                    }
                                    isSending = false
                                }
                            }
                        },
                    ),
                )
                Spacer(Modifier.width(8.dp))
                val sendActive = inputText.isNotBlank() && !isSending
                val sendScale by animateFloatAsState(if (sendActive) 1f else 0.9f, label = "sendScale")
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .graphicsLayer { scaleX = sendScale; scaleY = sendScale }
                        .background(
                            if (sendActive) RocColors.RocGold else RocColors.TextSecondary.copy(alpha = 0.25f),
                            CircleShape,
                        )
                        .clickable(enabled = sendActive) {
                        if (inputText.isNotBlank() && !isSending) {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            val text = inputText.trim()
                            inputText = ""
                            isSending = true
                            val replyToId = replyingTo?.id
                            replyingTo = null
                            val localId = "queued-${System.currentTimeMillis()}"
                            scope.launch {
                                try {
                                    if (recipientUserId.isNotEmpty()) {
                                        val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, text)
                                        APIClient.sendMessage(conversationId, envelope.ciphertext, envelope.iv, envelope.ratchetHeader, "text", disappearTimer, replyTo = replyToId)
                                    } else {
                                        APIClient.sendMessage(conversationId, text, "", "", "text", disappearTimer, replyTo = replyToId)
                                    }
                                    messages = messages + APIClient.ChatMessage(
                                        id = "local-${System.currentTimeMillis()}",
                                        conversationId = conversationId,
                                        senderId = userId,
                                        ciphertext = text,
                                        iv = "", ratchetHeader = "",
                                        messageType = "text",
                                        createdAt = Date().toString(),
                                    )
                                } catch (_: Exception) {
                                    queueMessage(context, localId, conversationId, text, recipientUserId)
                                    messages = messages + APIClient.ChatMessage(
                                        id = localId, conversationId = conversationId,
                                        senderId = userId, ciphertext = "⏳ $text",
                                        iv = "", ratchetHeader = "", messageType = "text",
                                        createdAt = Date().toString(),
                                    )
                                    isOffline = true
                                }
                                isSending = false
                            }
                        }
                    },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.ArrowUpward,
                        contentDescription = "Send",
                        tint = if (sendActive) Color.White else RocColors.TextSecondary,
                        modifier = Modifier.size(20.dp),
                    )
                }
                IconButton(
                    onClick = { showScheduleDialog = true },
                    enabled = inputText.isNotBlank(),
                ) {
                    Icon(
                        Icons.Default.Schedule,
                        contentDescription = "Schedule",
                        tint = if (inputText.isNotBlank()) RocColors.RocGold else RocColors.TextSecondary,
                    )
                }
            }
            } // else: not recording / not preview
        }
    }

    // Drive waveform + timer while recording
    LaunchedEffect(isRecordingVoice) {
        if (!isRecordingVoice) return@LaunchedEffect
        recordingElapsed = 0
        val window = ArrayDeque<Float>(32).apply { repeat(32) { addLast(0.1f) } }
        while (isRecordingVoice) {
            delay(100)
            val amp = pollRecordingAmplitude()
            window.removeFirst()
            window.addLast(amp)
            recordingLevels = window.toList()
            // Timer tick each 10 frames (~1s)
            if ((System.currentTimeMillis() / 1000).toInt() != voiceRecordingStartTime.toInt()) {
                recordingElapsed = ((System.currentTimeMillis() - voiceRecordingStartTime) / 1000).toInt()
            }
            if (recordingElapsed >= 300) {
                val (p, d) = finishVoiceRecordingToPreview() ?: (null to 0)
                if (p != null) {
                    pendingAudioPath = p; pendingAudioDuration = d
                }
                break
            }
        }
    }

    if (showVideoRecorder) {
        VideoMessageRecorderDialog { file, duration ->
            showVideoRecorder = false
            if (file != null) {
                sendVideoNote(context, conversationId, recipientUserId, scope, userId, file, duration) {
                    messages = messages + it
                }
            }
        }
    }

    // Disappearing messages dialog
    if (showDisappearMenu) {
        val options = listOf(
            "Off" to 0, "5 minutes" to 300, "1 hour" to 3600,
            "24 hours" to 86400, "7 days" to 604800, "30 days" to 2592000,
        )
        AlertDialog(
            onDismissRequest = { showDisappearMenu = false },
            title = { Text("Disappearing Messages") },
            text = {
                Column {
                    Text("New messages will auto-delete after the selected time.",
                        fontSize = 13.sp, color = RocColors.TextSecondary)
                    Spacer(Modifier.height(12.dp))
                    options.forEach { (label, value) ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    disappearTimer = value
                                    prefs.edit().putInt("disappear_$conversationId", value).apply()
                                    showDisappearMenu = false
                                }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = disappearTimer == value,
                                onClick = {
                                    disappearTimer = value
                                    prefs.edit().putInt("disappear_$conversationId", value).apply()
                                    showDisappearMenu = false
                                },
                                colors = RadioButtonDefaults.colors(selectedColor = RocColors.RocGold),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(label)
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showDisappearMenu = false }) { Text("Cancel") }
            },
        )
    }

    // Schedule message dialog
    if (showScheduleDialog) {
        val scheduleOptions = listOf(
            "In 1 hour" to 3600L,
            "In 3 hours" to 10800L,
            "Tomorrow morning (9 AM)" to run {
                val cal = java.util.Calendar.getInstance()
                cal.add(java.util.Calendar.DAY_OF_YEAR, 1)
                cal.set(java.util.Calendar.HOUR_OF_DAY, 9)
                cal.set(java.util.Calendar.MINUTE, 0)
                cal.set(java.util.Calendar.SECOND, 0)
                (cal.timeInMillis - System.currentTimeMillis()) / 1000
            },
            "Tomorrow evening (6 PM)" to run {
                val cal = java.util.Calendar.getInstance()
                cal.add(java.util.Calendar.DAY_OF_YEAR, 1)
                cal.set(java.util.Calendar.HOUR_OF_DAY, 18)
                cal.set(java.util.Calendar.MINUTE, 0)
                cal.set(java.util.Calendar.SECOND, 0)
                (cal.timeInMillis - System.currentTimeMillis()) / 1000
            },
        )
        AlertDialog(
            onDismissRequest = { showScheduleDialog = false },
            title = { Text("Schedule Message") },
            text = {
                Column {
                    scheduleOptions.forEach { (label, offsetSecs) ->
                        TextButton(onClick = {
                            val text = inputText.trim()
                            if (text.isNotBlank()) {
                                inputText = ""
                                showScheduleDialog = false
                                val scheduledAt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US).apply {
                                    timeZone = java.util.TimeZone.getTimeZone("UTC")
                                }.format(java.util.Date(System.currentTimeMillis() + offsetSecs * 1000))
                                scope.launch {
                                    try {
                                        APIClient.post("/features/scheduled", org.json.JSONObject().apply {
                                            put("conversation_id", conversationId)
                                            put("ciphertext", text)
                                            put("scheduled_at", scheduledAt)
                                        })
                                    } catch (_: Exception) {}
                                }
                            }
                        }) {
                            Text(label, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showScheduleDialog = false }) { Text("Cancel") }
            },
        )
    }

    // Safety Number Dialog
    if (showSafetyDialog) {
        LaunchedEffect(Unit) {
            try {
                val myKeyB64 = context.getSharedPreferences("rocchat", 0)
                    .getString("identity_pub", null) ?: return@LaunchedEffect
                val resp = APIClient.get("/keys/bundle/$recipientUserId")
                val bundle = resp.optJSONObject("bundle")
                val theirKeyB64 = bundle?.optString("identity_key") ?: return@LaunchedEffect
                val myKey = android.util.Base64.decode(myKeyB64, android.util.Base64.NO_WRAP)
                val theirKey = android.util.Base64.decode(theirKeyB64, android.util.Base64.NO_WRAP)
                val sorted = if (compareByteArrays(myKey, theirKey) < 0) myKey + theirKey else theirKey + myKey
                val digest = java.security.MessageDigest.getInstance("SHA-512")
                val hash = digest.digest(sorted)
                val groups = mutableListOf<String>()
                var i = 0
                while (groups.size < 12 && i + 3 < hash.size) {
                    val num = ((hash[i].toInt() and 0xFF shl 24) or
                            (hash[i + 1].toInt() and 0xFF shl 16) or
                            (hash[i + 2].toInt() and 0xFF shl 8) or
                            (hash[i + 3].toInt() and 0xFF)).toUInt()
                    groups.add(String.format("%05d", (num % 100000u).toInt()))
                    i += 5
                }
                safetyNumberText = groups.joinToString(" ")
            } catch (_: Exception) {}
        }

        // Vault composer
        if (showVaultComposer) {
            AlertDialog(
                onDismissRequest = { showVaultComposer = false },
                title = { Text("Share Vault Item") },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        // Type selector
                        listOf("password" to "🔑 Password", "wifi" to "📶 WiFi", "card" to "💳 Card", "note" to "📝 Note").forEach { (key, label) ->
                            Row(
                                modifier = Modifier.fillMaxWidth().clickable { vaultType = key; vaultFields = mutableMapOf() }.padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = vaultType == key, onClick = { vaultType = key; vaultFields = mutableMapOf() })
                                Spacer(Modifier.width(4.dp))
                                Text(label)
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = vaultLabel, onValueChange = { vaultLabel = it }, label = { Text("Label") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        Spacer(Modifier.height(8.dp))
                        when (vaultType) {
                            "password" -> {
                                OutlinedTextField(value = vaultFields["username"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("username", it) } }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                OutlinedTextField(value = vaultFields["password"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("password", it) } }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                OutlinedTextField(value = vaultFields["url"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("url", it) } }, label = { Text("URL (optional)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                            }
                            "wifi" -> {
                                OutlinedTextField(value = vaultFields["ssid"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("ssid", it) } }, label = { Text("Network Name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                OutlinedTextField(value = vaultFields["password"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("password", it) } }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                            }
                            "card" -> {
                                OutlinedTextField(value = vaultFields["number"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("number", it) } }, label = { Text("Card Number") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                OutlinedTextField(value = vaultFields["expiry"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("expiry", it) } }, label = { Text("Expiry (MM/YY)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                OutlinedTextField(value = vaultFields["name"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("name", it) } }, label = { Text("Cardholder Name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                            }
                            "note" -> {
                                OutlinedTextField(value = vaultFields["text"] ?: "", onValueChange = { vaultFields = vaultFields.toMutableMap().apply { put("text", it) } }, label = { Text("Note") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = vaultViewOnce, onCheckedChange = { vaultViewOnce = it })
                            Text("View once", modifier = Modifier.padding(start = 4.dp))
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = vaultLabel.isNotBlank(),
                        onClick = {
                            scope.launch {
                                try {
                                    val fieldsJson = JSONObject(vaultFields.toMap())
                                    val encoded = android.util.Base64.encodeToString(fieldsJson.toString().toByteArray(), android.util.Base64.NO_WRAP)
                                    val vault = JSONObject().apply {
                                        put("type", "vault_item")
                                        put("vaultType", vaultType)
                                        put("label", vaultLabel)
                                        put("encryptedPayload", encoded)
                                        put("viewOnce", vaultViewOnce)
                                        put("timestamp", System.currentTimeMillis() / 1000)
                                    }
                                    val body = JSONObject().apply {
                                        put("conversation_id", conversationId)
                                        put("message_type", "vault_item")
                                        put("encrypted", vault.toString())
                                    }
                                    APIClient.post("/messages/send", body)
                                } catch (_: Exception) {}
                            }
                            showVaultComposer = false; vaultLabel = ""; vaultFields = mutableMapOf(); vaultViewOnce = false
                        },
                    ) { Text("Send") }
                },
                dismissButton = { TextButton(onClick = { showVaultComposer = false }) { Text("Cancel") } },
            )
        }

        // Emoji/Sticker Picker panel
        if (showStickerPicker) {
            val emojiCategories = listOf(
                "Smileys" to listOf("😀","😂","🤣","😊","😍","🥰","😘","😜","🤪","😎","🥳","😇","🤩","🥺","😭","😤","🤯","🫡","🫶","❤️","🔥","✨","💯","👏","🙌","👊","✊","🤝","💪","🕊️"),
                "Roc Spirit" to listOf("🪶","🦅","🏔️","⛰️","🌄","🌅","🌍","🕊️","✊","🔒","🛡️","💛","🖤","🤎","❤️‍🔥","🏴","🪧","📢","🎯","⚡","🌊","🌿","🌱","🫂","🤲","🙏","💎","👑","🦁","🇵🇸"),
                "Gestures" to listOf("👍","👎","👋","🤙","✌️","🤞","🫰","🤟","🤘","👆","👇","👉","👈","🫵","🖐️","✋","🤚","👐","🤲","🙏","💅","🫶","🤝","👊","✊","🤛","🤜","🫳","🫴","💪"),
                "Objects" to listOf("🔒","🔑","🗝️","🛡️","⚔️","🏴","📱","💻","🖥️","⌨️","🎵","🎶","📷","🎬","📖","✏️","📌","🔗","💰","🪙","🎁","🏆","🎖️","🧭","⏰","💡","🔋","📡","🌐","🗺️"),
                "Flags" to listOf("🏴","🏳️","🏁","🚩","🏳️‍🌈","🏴‍☠️","🇵🇸","🇱🇧","🇾🇪","🇸🇾","🇮🇶","🇱🇾","🇸🇩","🇸🇴","🇪🇬","🇯🇴","🇩🇿","🇹🇳","🇲🇦","🇲🇷","🇹🇷","🇮🇷","🇲🇾","🇮🇩","🇧🇩","🇵🇰","🇿🇦","🇧🇷","🇨🇺","🇻🇪"),
            )
            var selectedCat by remember { mutableIntStateOf(0) }
            Surface(
                modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                tonalElevation = 2.dp,
            ) {
                Column {
                    ScrollableTabRow(selectedTabIndex = selectedCat, edgePadding = 4.dp) {
                        emojiCategories.forEachIndexed { i, (name, _) ->
                            Tab(selected = selectedCat == i, onClick = { selectedCat = i }, text = { Text(name, fontSize = 11.sp) })
                        }
                    }
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(7),
                        modifier = Modifier.fillMaxWidth().padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        items(emojiCategories[selectedCat].second) { emoji ->
                            Text(
                                emoji,
                                fontSize = 26.sp,
                                modifier = Modifier
                                    .clickable {
                                        inputText += emoji
                                        showStickerPicker = false
                                    }
                                    .padding(4.dp),
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
            }
        }

        // Theme picker
        if (showThemePicker) {
            AlertDialog(
                onDismissRequest = { showThemePicker = false },
                title = { Text("Chat Theme") },
                text = {
                    LazyColumn(modifier = Modifier.heightIn(max = 350.dp)) {
                        items(chatThemes, key = { it.key }) { theme ->
                            ListItem(
                                headlineContent = { Text(theme.label) },
                                leadingContent = {
                                    Surface(shape = CircleShape, color = if (theme.key == "default") RocColors.RocGold else theme.swatch, modifier = Modifier.size(32.dp)) {}
                                },
                                trailingContent = {
                                    if (chatTheme == theme.key) Icon(Icons.Default.Check, contentDescription = null, tint = RocColors.RocGold)
                                },
                                modifier = Modifier.clickable {
                                    chatTheme = theme.key
                                    prefs.edit().putString("theme_$conversationId", theme.key).apply()
                                    scope.launch {
                                        try { APIClient.post("/messages/conversations/$conversationId/theme", JSONObject().apply { put("theme", theme.key) }) } catch (_: Exception) {}
                                    }
                                    showThemePicker = false
                                },
                            )
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showThemePicker = false }) { Text("Cancel") } },
            )
        }

        // Pinned Messages dialog
        if (showPinnedMessages) {
            AlertDialog(
                onDismissRequest = { showPinnedMessages = false },
                title = { Text("Pinned Messages") },
                text = {
                    if (pinnedMessages.isEmpty()) {
                        Text("No pinned messages", color = RocColors.TextSecondary)
                    } else {
                        LazyColumn(modifier = Modifier.heightIn(max = 350.dp)) {
                            items(pinnedMessages, key = { it.id }) { msg ->
                                Column(modifier = Modifier.padding(vertical = 4.dp)) {
                                    Text(msg.ciphertext.ifBlank { "🔒 Encrypted" }, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                    Text(formatRelativeTime(msg.createdAt), fontSize = 11.sp, color = RocColors.TextSecondary)
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showPinnedMessages = false }) { Text("Done") } },
            )
        }

        // Media Gallery dialog
        if (showMediaGallery) {
            val mediaMessages = messages.filter { msg ->
                try { JSONObject(msg.ciphertext).has("blobId") } catch (_: Exception) { false }
            }
            AlertDialog(
                onDismissRequest = { showMediaGallery = false },
                title = { Text("Media") },
                text = {
                    if (mediaMessages.isEmpty()) {
                        Text("No media shared", color = RocColors.TextSecondary)
                    } else {
                        LazyColumn(modifier = Modifier.heightIn(max = 400.dp)) {
                            items(mediaMessages, key = { it.id }) { msg ->
                                val blobId = try { JSONObject(msg.ciphertext).optString("blobId", "") } catch (_: Exception) { "" }
                                val filename = try { JSONObject(msg.ciphertext).optString("filename", "File") } catch (_: Exception) { "File" }
                                ListItem(
                                    headlineContent = { Text(filename) },
                                    supportingContent = { Text(formatRelativeTime(msg.createdAt), fontSize = 11.sp) },
                                    leadingContent = { Icon(Icons.Default.InsertDriveFile, contentDescription = null, tint = RocColors.RocGold) },
                                )
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showMediaGallery = false }) { Text("Done") } },
            )
        }

        // Group Admin dialog
        if (showGroupAdmin) {
            AlertDialog(
                onDismissRequest = { showGroupAdmin = false },
                title = { Text("Group Members (${groupMembers.size})") },
                text = {
                    LazyColumn(modifier = Modifier.heightIn(max = 400.dp)) {
                        items(groupMembers.size) { idx ->
                            val member = groupMembers[idx]
                            val name = member.optString("display_name", member.optString("username", "Unknown"))
                            val role = member.optString("role", "member")
                            val memberId = member.optString("user_id", "")
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(name)
                                    Text(role, fontSize = 12.sp, color = RocColors.TextSecondary)
                                }
                                if (memberId != userId) {
                                    IconButton(onClick = {
                                        scope.launch {
                                            try { APIClient.post("/groups/$conversationId/promote", JSONObject().put("user_id", memberId).put("role", "admin")) } catch (_: Exception) {}
                                            try { val arr = APIClient.getArray("/groups/$conversationId/members"); groupMembers = (0 until arr.length()).map { arr.getJSONObject(it) } } catch (_: Exception) {}
                                        }
                                    }, modifier = Modifier.size(32.dp)) {
                                        Icon(Icons.Default.ArrowUpward, contentDescription = "Promote", tint = RocColors.RocGold, modifier = Modifier.size(18.dp))
                                    }
                                    IconButton(onClick = {
                                        scope.launch {
                                            try { APIClient.post("/groups/$conversationId/kick", JSONObject().put("user_id", memberId)) } catch (_: Exception) {}
                                            try { val arr = APIClient.getArray("/groups/$conversationId/members"); groupMembers = (0 until arr.length()).map { arr.getJSONObject(it) } } catch (_: Exception) {}
                                        }
                                    }, modifier = Modifier.size(32.dp)) {
                                        Icon(Icons.Default.PersonRemove, contentDescription = "Remove", tint = RocColors.Danger, modifier = Modifier.size(18.dp))
                                    }
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showGroupAdmin = false }) { Text("Done") } },
            )
        }

        if (safetyNumberText.isNotEmpty()) {
            AlertDialog(
                onDismissRequest = { showSafetyDialog = false; safetyNumberText = "" },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Security, contentDescription = null, tint = RocColors.Turquoise)
                        Spacer(Modifier.width(8.dp))
                        Text("Safety Number")
                    }
                },
                text = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Compare this number with $conversationName to verify end-to-end encryption.",
                            fontSize = 13.sp, color = RocColors.TextSecondary,
                        )
                        Spacer(Modifier.height(16.dp))
                        val groups = safetyNumberText.split(" ")
                        for (row in groups.chunked(4)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceEvenly,
                            ) {
                                row.forEach { group ->
                                    Text(
                                        group,
                                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                                        fontWeight = FontWeight.Medium,
                                        fontSize = 18.sp,
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "If both of you see the same number, your messages are secure.",
                            fontSize = 12.sp, color = RocColors.TextSecondary,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Safety Number", safetyNumberText))
                    }) { Text("Copy") }
                },
                dismissButton = {
                    TextButton(onClick = { showSafetyDialog = false; safetyNumberText = "" }) { Text("Close") }
                },
            )
        }

        // Forward message dialog
        if (showForwardDialog && forwardingMessage != null) {
            var fwdConversations by remember { mutableStateOf<List<APIClient.Conversation>>(emptyList()) }
            LaunchedEffect(Unit) {
                try { fwdConversations = APIClient.getConversations() } catch (_: Exception) {}
            }
            AlertDialog(
                onDismissRequest = { showForwardDialog = false; forwardingMessage = null },
                title = { Text("Forward Message") },
                text = {
                    if (fwdConversations.isEmpty()) {
                        Text("No conversations available", color = RocColors.TextSecondary)
                    } else {
                        LazyColumn(modifier = Modifier.heightIn(max = 300.dp)) {
                            items(fwdConversations.filter { it.id != conversationId }, key = { it.id }) { conv ->
                                val name = conv.name ?: conv.members.joinToString(", ") { it.displayName.ifBlank { it.username } }.ifBlank { "Unknown" }
                                ListItem(
                                    headlineContent = { Text(name) },
                                    modifier = Modifier.clickable {
                                        scope.launch {
                                            try {
                                                val fwdMsg = forwardingMessage ?: return@launch
                                                val plaintext = "↪ Forwarded: ${fwdMsg.ciphertext}"
                                                val isGroup = conv.type == "group"
                                                val recipientId = conv.members.firstOrNull { it.userId != userId }?.userId ?: ""

                                                if (!isGroup && recipientId.isNotEmpty()) {
                                                    val envelope = SessionManager.encryptMessage(context, conv.id, recipientId, plaintext)
                                                    APIClient.sendMessage(conv.id, envelope.ciphertext, envelope.iv, envelope.ratchetHeader, fwdMsg.messageType)
                                                } else if (isGroup) {
                                                    val groupEnvelope = GroupSessionManager.getInstance(context).encrypt(conv.id, plaintext.toByteArray(), userId)
                                                    APIClient.sendMessage(conv.id, groupEnvelope.ciphertext, "", groupEnvelope.ratchetHeader, fwdMsg.messageType)
                                                }
                                            } catch (_: Exception) {}
                                            showForwardDialog = false
                                            forwardingMessage = null
                                        }
                                    },
                                )
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = {
                    TextButton(onClick = { showForwardDialog = false; forwardingMessage = null }) { Text("Cancel") }
                },
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    msg: APIClient.ChatMessage,
    isMine: Boolean,
    groupPosition: GroupPosition = GroupPosition.SOLO,
    showTimestamp: Boolean = true,
    onReact: (String) -> Unit = {},
    onEdit: () -> Unit = {},
    onDelete: () -> Unit = {},
    onPin: () -> Unit = {},
    onReply: () -> Unit = {},
    onForward: () -> Unit = {},
    onBlock: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var viewOnceOpened by remember { mutableStateOf(false) }
    var showViewOnceModal by remember { mutableStateOf(false) }
    var revealedBitmap by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    var showContextMenu by remember { mutableStateOf(false) }
    var swipeOffset by remember { mutableStateOf(0f) }
    var didTriggerReply by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val animatedOffset by animateFloatAsState(
        targetValue = swipeOffset,
        label = "swipeOffset",
    )

    // Parse file message JSON
    val fileMsg: org.json.JSONObject? = remember(msg.ciphertext) {
        try {
            val j = org.json.JSONObject(msg.ciphertext)
            if (j.has("blobId")) j else null
        } catch (_: Exception) { null }
    }
    val isViewOnce = fileMsg?.optBoolean("viewOnce", false) == true
    val viewedKey = "rocchat_viewed_${msg.id}"
    val alreadyViewed = remember {
        context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getBoolean(viewedKey, false)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .offset { IntOffset(animatedOffset.toInt(), 0) }
            .pointerInput(msg.id) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        swipeOffset = 0f
                        didTriggerReply = false
                    },
                    onDragCancel = {
                        swipeOffset = 0f
                        didTriggerReply = false
                    },
                ) { _, dragAmount ->
                    val next = (swipeOffset + dragAmount).coerceIn(
                        if (isMine) -with(density) { 120.dp.toPx() } else 0f,
                        if (isMine) 0f else with(density) { 120.dp.toPx() },
                    )
                    swipeOffset = next
                    val threshold = with(density) { 60.dp.toPx() }
                    if (!didTriggerReply && kotlin.math.abs(next) > threshold) {
                        didTriggerReply = true
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        onReply()
                    }
                }
            },
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
    ) {
        val cornerFull = 18.dp
        val cornerSmall = 4.dp
        val bubbleShape = when (groupPosition) {
            GroupPosition.SOLO -> RoundedCornerShape(
                topStart = cornerFull, topEnd = cornerFull,
                bottomStart = if (isMine) cornerFull else cornerSmall,
                bottomEnd = if (isMine) cornerSmall else cornerFull,
            )
            GroupPosition.FIRST -> RoundedCornerShape(
                topStart = cornerFull, topEnd = cornerFull,
                bottomStart = if (isMine) cornerFull else cornerSmall,
                bottomEnd = if (isMine) cornerSmall else cornerFull,
            )
            GroupPosition.MIDDLE -> RoundedCornerShape(
                topStart = if (isMine) cornerFull else cornerSmall,
                topEnd = if (isMine) cornerSmall else cornerFull,
                bottomStart = if (isMine) cornerFull else cornerSmall,
                bottomEnd = if (isMine) cornerSmall else cornerFull,
            )
            GroupPosition.LAST -> RoundedCornerShape(
                topStart = if (isMine) cornerFull else cornerSmall,
                topEnd = if (isMine) cornerSmall else cornerFull,
                bottomStart = if (isMine) cornerFull else cornerSmall,
                bottomEnd = if (isMine) cornerSmall else cornerFull,
            )
        }
        Surface(
            shape = bubbleShape,
            color = if (isMine) RocColors.RocGold.copy(alpha = 0.12f)
                    else MaterialTheme.colorScheme.surface,
            shadowElevation = 1.dp,
            modifier = Modifier.widthIn(max = 280.dp)
                .combinedClickable(
                    onClick = {},
                    onLongClick = { showContextMenu = true }
                ),
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                if (isViewOnce) {
                    if (alreadyViewed || viewOnceOpened) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Visibility, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(6.dp))
                            Text("Opened", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    } else {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.clickable {
                                val blobId = fileMsg?.optString("blobId") ?: return@clickable
                                val fKey = fileMsg.optString("fileKey", "")
                                val fIv = fileMsg.optString("fileIv", "")
                                val fHash = fileMsg.optString("fileHash", "")
                                if (fKey.isEmpty() || fIv.isEmpty()) return@clickable
                                scope.launch {
                                    try {
                                        val encBytes = APIClient.getRawBytes("/media/$blobId")
                                        val keyBytes = android.util.Base64.decode(fKey, android.util.Base64.NO_WRAP)
                                        val ivBytes = android.util.Base64.decode(fIv, android.util.Base64.NO_WRAP)
                                        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                                        cipher.init(javax.crypto.Cipher.DECRYPT_MODE,
                                            javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                                            javax.crypto.spec.GCMParameterSpec(128, ivBytes))
                                        val plainBytes = cipher.doFinal(encBytes)
                                        // Integrity check
                                        if (fHash.isNotEmpty()) {
                                            val digest = java.security.MessageDigest.getInstance("SHA-256")
                                            val computed = android.util.Base64.encodeToString(digest.digest(plainBytes), android.util.Base64.NO_WRAP)
                                            if (computed != fHash) throw SecurityException("Media hash mismatch")
                                        }
                                        val bmp = android.graphics.BitmapFactory.decodeByteArray(plainBytes, 0, plainBytes.size)
                                        if (bmp != null) {
                                            revealedBitmap = bmp
                                            showViewOnceModal = true
                                        }
                                    } catch (_: Exception) {
                                        context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().putBoolean(viewedKey, true).apply()
                                        viewOnceOpened = true
                                    }
                                }
                            }
                        ) {
                            Icon(Icons.Default.RemoveRedEye, contentDescription = null, modifier = Modifier.size(24.dp), tint = RocColors.RocGold)
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text("View once photo", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text("Tap to open", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                } else if (msg.ciphertext.contains("\"type\":\"vault_item\"")) {
                    VaultItemCard(ciphertext = msg.ciphertext, messageId = msg.id)
                } else {
                    Text(
                        text = msg.ciphertext.ifBlank { "🔒 Encrypted" },
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    // Link preview
                    val url = remember(msg.ciphertext) { extractUrl(msg.ciphertext) }
                    if (url != null) {
                        LinkPreviewCard(url = url)
                    }
                }
                Row(
                    modifier = Modifier.align(Alignment.End).padding(top = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("🔒", fontSize = 8.sp)
                    Spacer(Modifier.width(4.dp))
                    if (showTimestamp) {
                    Text(
                        formatRelativeTime(msg.createdAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    }
                    if (isMine) {
                        Spacer(Modifier.width(4.dp))
                        when (msg.status) {
                            "read" -> Text("✓✓", style = MaterialTheme.typography.labelSmall, color = RocColors.Turquoise)
                            "delivered" -> Text("✓✓", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            else -> Text("✓", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }

                // Reactions display
                if (!msg.reactions.isNullOrBlank()) {
                    Row(
                        modifier = Modifier.padding(top = 2.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        val reactionList = msg.reactions.split(",").filter { it.isNotBlank() }
                        val grouped = reactionList.groupBy { it.trim() }
                        grouped.forEach { (emoji, list) ->
                            Text(
                                "$emoji ${list.size}",
                                fontSize = 12.sp,
                                modifier = Modifier
                                    .background(RocColors.RocGold.copy(alpha = 0.12f), shape = RoundedCornerShape(12.dp))
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }

                // Context menu
                DropdownMenu(expanded = showContextMenu, onDismissRequest = { showContextMenu = false }) {
                    listOf("❤️", "👍", "😂", "😮", "😢", "🙏").forEach { emoji ->
                        DropdownMenuItem(text = { Text(emoji) }, onClick = { showContextMenu = false; onReact(emoji) })
                    }
                    DropdownMenuItem(
                        text = { Text("Copy") },
                        leadingIcon = { Icon(Icons.Default.ContentCopy, null) },
                        onClick = {
                            showContextMenu = false
                            val clip = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                            clip.setPrimaryClip(android.content.ClipData.newPlainText("message", msg.ciphertext))
                        }
                    )
                    if (isMine) {
                        DropdownMenuItem(
                            text = { Text("Edit") },
                            leadingIcon = { Icon(Icons.Default.Edit, null) },
                            onClick = { showContextMenu = false; onEdit() }
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("Pin") },
                        leadingIcon = { Icon(Icons.Default.PushPin, null) },
                        onClick = { showContextMenu = false; onPin() }
                    )
                    DropdownMenuItem(
                        text = { Text("Forward") },
                        leadingIcon = { Icon(Icons.Default.Share, null) },
                        onClick = { showContextMenu = false; onForward() }
                    )
                    if (isMine) {
                        DropdownMenuItem(
                            text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                            leadingIcon = { Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { showContextMenu = false; onDelete() }
                        )
                    }
                    if (!isMine) {
                        DropdownMenuItem(
                            text = { Text("Block User", color = MaterialTheme.colorScheme.error) },
                            leadingIcon = { Icon(Icons.Default.Block, null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { showContextMenu = false; onBlock() }
                        )
                    }
                }
            }
        }
    }

    // View-once fullscreen modal
    if (showViewOnceModal && revealedBitmap != null) {
        androidx.compose.ui.window.Dialog(
            onDismissRequest = {
                showViewOnceModal = false
                revealedBitmap = null
                context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().putBoolean(viewedKey, true).apply()
                viewOnceOpened = true
            },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)
        ) {
            Box(
                modifier = Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable {
                    showViewOnceModal = false
                    revealedBitmap = null
                    context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().putBoolean(viewedKey, true).apply()
                    viewOnceOpened = true
                },
                contentAlignment = Alignment.Center,
            ) {
                val bmp = revealedBitmap
                if (bmp != null) {
                    Image(
                        bitmap = bmp.asImageBitmap(),
                        contentDescription = "View once media",
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        contentScale = ContentScale.Fit,
                    )
                }
                // Close button
                IconButton(
                    onClick = {
                        showViewOnceModal = false
                        revealedBitmap = null
                        context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().putBoolean(viewedKey, true).apply()
                        viewOnceOpened = true
                    },
                    modifier = Modifier.align(Alignment.TopEnd).padding(16.dp),
                ) {
                    Icon(Icons.Default.Close, contentDescription = "Close", tint = androidx.compose.ui.graphics.Color.White)
                }
                Text(
                    "This media will disappear when closed",
                    color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.6f),
                    fontSize = 12.sp,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp),
                )
            }
        }
    }
}

// ── Settings Tab ──

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SettingsTab(onLogout: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var discoverable by remember { mutableStateOf(true) }
    var readReceipts by remember { mutableStateOf(true) }
    var typingIndicators by remember { mutableStateOf(true) }
    var onlineVisibility by remember { mutableStateOf("everyone") }
    var whoCanAdd by remember { mutableStateOf("everyone") }
    var onlineExpanded by remember { mutableStateOf(false) }
    var whoCanAddExpanded by remember { mutableStateOf(false) }
    var ghostMode by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("loading...") }
    var displayName by remember { mutableStateOf("Loading...") }
    var statusText by remember { mutableStateOf("") }
    var showStatusDialog by remember { mutableStateOf(false) }
    var editStatusText by remember { mutableStateOf("") }
    var avatarUrl by remember { mutableStateOf<String?>(null) }
    var showQrScanner by remember { mutableStateOf(false) }
    var linkMessage by remember { mutableStateOf<String?>(null) }
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
        if (granted) showQrScanner = true
    }

    var isUploadingAvatar by remember { mutableStateOf(false) }

    // Invite link
    var inviteLink by remember { mutableStateOf<String?>(null) }
    var isGeneratingLink by remember { mutableStateOf(false) }

    // Chat import
    var importSource by remember { mutableStateOf("") }
    var importStatus by remember { mutableStateOf("") }

    // Device management
    var devicesList by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var verifyCode by remember { mutableStateOf<String?>(null) }
    var verifyInput by remember { mutableStateOf("") }
    var showBlockedList by remember { mutableStateOf(false) }
    var blockedContacts by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var showEditName by remember { mutableStateOf(false) }
    var editNameText by remember { mutableStateOf("") }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var identityKeyFingerprint by remember { mutableStateOf("") }
    var defaultDisappearTimer by remember { mutableIntStateOf(0) }
    var lastSeenVisibility by remember { mutableStateOf("everyone") }
    var photoVisibility by remember { mutableStateOf("everyone") }
    var screenshotDetect by remember { mutableStateOf(true) }
    var showRecoveryPhrase by remember { mutableStateOf(false) }
    var recoveryPhrase by remember { mutableStateOf("") }

    // Decoy conversations
    var showDecoyManager by remember { mutableStateOf(false) }
    var decoyConversations by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var decoyNameInput by remember { mutableStateOf("") }
    var decoyMessageInput by remember { mutableStateOf("") }

    // Custom emoji
    var showEmojiManager by remember { mutableStateOf(false) }
    var customEmojis by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var emojiShortcodeInput by remember { mutableStateOf("") }

    // Donation
    var showDonationSheet by remember { mutableStateOf(false) }
    var donorTier by remember { mutableStateOf("") }
    var donorSince by remember { mutableStateOf("") }

    // Encrypted backup
    var showBackupSheet by remember { mutableStateOf(false) }
    var backupPassphrase by remember { mutableStateOf("") }
    var backupStatus by remember { mutableStateOf("") }

    // Saved contacts
    var showSavedContacts by remember { mutableStateOf(false) }
    var savedContacts by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var showNicknameDialog by remember { mutableStateOf(false) }
    var editNicknameContactId by remember { mutableStateOf("") }
    var editNicknameText by remember { mutableStateOf("") }
    var appTheme by remember { mutableStateOf(context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getString("app_theme", "system") ?: "system") }

    val importFileLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null && importSource.isNotEmpty()) {
            scope.launch {
                try {
                    val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: return@launch
                    importStatus = "Parsing $importSource export..."
                    val parsed = mutableListOf<JSONObject>()
                    when (importSource) {
                        "whatsapp" -> {
                            val regex = Regex("""^(\d{1,2}/\d{1,2}/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*-\s*([^:]+):\s*(.+)$""")
                            text.lineSequence().forEach { line ->
                                regex.find(line)?.let { m ->
                                    parsed.add(JSONObject().apply {
                                        put("timestamp", m.groupValues[1])
                                        put("sender_name", m.groupValues[2].trim())
                                        put("body", m.groupValues[3])
                                    })
                                }
                            }
                        }
                        "telegram" -> {
                            val data = JSONObject(text)
                            val msgs = data.optJSONArray("messages") ?: return@launch
                            for (i in 0 until msgs.length()) {
                                val m = msgs.getJSONObject(i)
                                val body = m.optString("text", "")
                                if (body.isNotEmpty()) parsed.add(JSONObject().apply {
                                    put("timestamp", m.optString("date", ""))
                                    put("sender_name", m.optString("from", "Unknown"))
                                    put("body", body)
                                })
                            }
                        }
                        "signal" -> {
                            val data = JSONObject(text)
                            val msgs = data.optJSONArray("messages") ?: return@launch
                            for (i in 0 until msgs.length()) {
                                val m = msgs.getJSONObject(i)
                                val body = m.optString("body", "")
                                if (body.isNotEmpty()) parsed.add(JSONObject().apply {
                                    put("timestamp", m.optString("sent_at", m.optString("timestamp", "")))
                                    put("sender_name", m.optString("source", "Unknown"))
                                    put("body", body)
                                })
                            }
                        }
                    }
                    if (parsed.isEmpty()) { importStatus = "No messages found"; return@launch }
                    val convRes = APIClient.post("/messages/conversations", JSONObject().apply {
                        put("type", "direct"); put("member_ids", org.json.JSONArray()); put("name", "$importSource import")
                    })
                    val convId = convRes.optString("conversation_id", "")
                    if (convId.isEmpty()) { importStatus = "Failed to create conversation"; return@launch }
                    var total = 0
                    parsed.chunked(500).forEach { batch ->
                        val arr = org.json.JSONArray()
                        batch.forEach { arr.put(it) }
                        val res = APIClient.post("/features/import", JSONObject().apply {
                            put("source", importSource); put("conversation_id", convId); put("messages", arr)
                        })
                        total += res.optInt("imported", batch.size)
                        importStatus = "Imported $total of ${parsed.size} messages..."
                    }
                    importStatus = "✅ Imported $total messages from $importSource"
                } catch (_: Exception) { importStatus = "Import failed — check file format" }
            }
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) {
            scope.launch {
                isUploadingAvatar = true
                try {
                    val inputStream = context.contentResolver.openInputStream(uri)
                    val bytes = inputStream?.use { it.readBytes() } ?: return@launch
                    // Decode + downscale to max 512 + recompress as JPEG
                    val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = false }
                    val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return@launch
                    val maxDim = 512
                    val scaleF = minOf(maxDim.toFloat() / bmp.width, maxDim.toFloat() / bmp.height, 1f)
                    val scaled = if (scaleF < 1f) android.graphics.Bitmap.createScaledBitmap(
                        bmp, (bmp.width * scaleF).toInt(), (bmp.height * scaleF).toInt(), true
                    ) else bmp
                    val baos = java.io.ByteArrayOutputStream()
                    scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, baos)
                    val jpegBytes = baos.toByteArray()
                    // E2E encrypt the avatar before upload
                    val vkB64 = SecureStorage.get(context, "rocchat_vault_key")
                    val uploadBytes: ByteArray
                    val uploadContentType: String
                    if (vkB64 != null) {
                        val vk = android.util.Base64.decode(vkB64, android.util.Base64.NO_WRAP)
                        val avatarKeyBytes = hkdfProfileKey(vk, "rocchat:avatar:encrypt")
                        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
                        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(avatarKeyBytes, "AES"), GCMParameterSpec(128, iv))
                        val ct = cipher.doFinal(jpegBytes)
                        uploadBytes = iv + ct
                        uploadContentType = "application/octet-stream"
                    } else {
                        uploadBytes = jpegBytes
                        uploadContentType = "image/jpeg"
                    }
                    val resp = APIClient.uploadAvatar(uploadBytes, uploadContentType)
                    avatarUrl = resp.optString("avatar_url", null)
                } catch (_: Exception) {
                } finally {
                    isUploadingAvatar = false
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        try {
            val me = APIClient.getMe()
            username = me.optString("username", "unknown")
            displayName = decryptProfileField(context, me.optString("display_name", username))
            statusText = decryptProfileField(context, me.optString("status_text", ""))
            avatarUrl = me.optString("avatar_url", null)
            discoverable = me.optBoolean("discoverable", true)
            if (me.has("show_read_receipts")) readReceipts = me.optInt("show_read_receipts", 1) != 0
            if (me.has("show_typing_indicator")) typingIndicators = me.optInt("show_typing_indicator", 1) != 0
            if (me.has("show_online_to")) onlineVisibility = me.optString("show_online_to", "everyone")
            if (me.has("who_can_add")) whoCanAdd = me.optString("who_can_add", "everyone")
            if (me.has("show_last_seen_to")) lastSeenVisibility = me.optString("show_last_seen_to", "everyone")
            if (me.has("show_photo_to")) photoVisibility = me.optString("show_photo_to", "everyone")
            if (me.has("screenshot_detection")) screenshotDetect = me.optInt("screenshot_detection", 1) != 0
            ghostMode = !readReceipts && !typingIndicators && onlineVisibility == "nobody"
            if (me.has("default_disappear_timer")) defaultDisappearTimer = me.optInt("default_disappear_timer", 0)
            // Load identity key fingerprint
            val keyHex = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).getString("identity_key_public", null)
            if (keyHex != null) identityKeyFingerprint = keyHex.chunked(2).joinToString(" ").uppercase()
        } catch (_: Exception) {}
        // Load devices
        try {
            val arr = APIClient.getArray("/devices")
            devicesList = (0 until arr.length()).map { arr.getJSONObject(it) }
        } catch (_: Exception) {}
    }

    if (showQrScanner) {
        QrScannerScreen(
            onScan = { code ->
                showQrScanner = false
                // Parse rocchat://web-login?token=UUID
                if (code.startsWith("rocchat://web-login?token=")) {
                    val token = android.net.Uri.parse(code).getQueryParameter("token")
                    if (!token.isNullOrBlank()) {
                        scope.launch {
                            try {
                                APIClient.authorizeQrToken(token)
                                linkMessage = "✓ Device linked successfully"
                            } catch (_: Exception) {
                                linkMessage = "⚠ Failed to link device"
                            }
                        }
                    } else {
                        linkMessage = "⚠ Invalid QR code"
                    }
                } else {
                    linkMessage = "⚠ Not a valid RocChat QR code"
                }
            },
            onClose = { showQrScanner = false },
        )
        return
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Profile", fontWeight = FontWeight.Bold) })

        // ── Roc Family Hero Card ─────────────────────────────
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(
                    androidx.compose.ui.graphics.Brush.linearGradient(
                        colors = listOf(
                            RocColors.RocGold.copy(alpha = 0.22f),
                            Color(0xFF1493A0).copy(alpha = 0.18f),
                            Color.Black.copy(alpha = 0.05f),
                        )
                    )
                )
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 20.dp, horizontal = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Avatar with gold ring + edit badge
                Box(
                    modifier = Modifier
                        .size(104.dp)
                        .clickable {
                            photoPickerLauncher.launch(
                                androidx.activity.result.PickVisualMediaRequest(
                                    ActivityResultContracts.PickVisualMedia.ImageOnly
                                )
                            )
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    // Outer ring
                    Box(
                        modifier = Modifier
                            .size(104.dp)
                            .background(
                                androidx.compose.ui.graphics.Brush.sweepGradient(
                                    listOf(
                                        RocColors.RocGold,
                                        Color(0xFF1493A0),
                                        RocColors.RocGold,
                                    )
                                ),
                                CircleShape,
                            )
                    )
                    Box(
                        modifier = Modifier
                            .size(96.dp)
                            .background(Color.Black, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        AvatarImage(name = displayName, avatarUrl = avatarUrl, size = 92)
                    }
                    if (isUploadingAvatar) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(96.dp),
                            color = RocColors.RocGold,
                            strokeWidth = 3.dp,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .size(30.dp)
                            .align(Alignment.BottomEnd)
                            .background(RocColors.RocGold, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Default.PhotoCamera,
                            contentDescription = "Change photo",
                            modifier = Modifier.size(14.dp),
                            tint = Color.White,
                        )
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(displayName, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    IconButton(onClick = { editNameText = displayName; showEditName = true }, modifier = Modifier.size(24.dp)) {
                        Icon(Icons.Default.Edit, contentDescription = "Edit name", tint = RocColors.RocGold, modifier = Modifier.size(16.dp))
                    }
                }
                Text(
                    "@$username",
                    color = RocColors.TextSecondary,
                    fontSize = 14.sp,
                )
                Text(
                    if (statusText.isEmpty()) "Set a status..." else statusText,
                    color = if (statusText.isEmpty()) RocColors.TextSecondary else RocColors.TextPrimary,
                    fontSize = 12.sp,
                    modifier = Modifier.clickable { editStatusText = statusText; showStatusDialog = true },
                )

                // Voice of Freedom solidarity banner
                Box(
                    modifier = Modifier
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(50))
                        .background(RocColors.RocGold.copy(alpha = 0.12f))
                        .border(
                            1.dp,
                            RocColors.RocGold.copy(alpha = 0.4f),
                            androidx.compose.foundation.shape.RoundedCornerShape(50),
                        )
                        .padding(horizontal = 12.dp, vertical = 5.dp),
                ) {
                    Text(
                        "🕊️  Voice of Freedom  🇵🇸",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = RocColors.RocGold,
                    )
                }
            }
        }
        HorizontalDivider()

        // My QR Code
        var showMyQR by remember { mutableStateOf(false) }
        Text("My QR Code", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        ListItem(
            headlineContent = { Text(if (showMyQR) "Hide QR Code" else "Show My QR Code", fontWeight = FontWeight.Medium) },
            leadingContent = { Icon(Icons.Default.QrCode2, contentDescription = null, tint = RocColors.RocGold, modifier = Modifier.size(28.dp)) },
            modifier = Modifier.clickable { showMyQR = !showMyQR }
        )
        if (showMyQR) {
            val qrBitmap = remember(username) {
                try {
                    val writer = com.google.zxing.qrcode.QRCodeWriter()
                    val matrix = writer.encode("rocchat://user/$username", com.google.zxing.BarcodeFormat.QR_CODE, 512, 512)
                    val bmp = android.graphics.Bitmap.createBitmap(512, 512, android.graphics.Bitmap.Config.RGB_565)
                    for (x in 0 until 512) for (y in 0 until 512) bmp.setPixel(x, y, if (matrix.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
                    bmp
                } catch (_: Exception) { null }
            }
            qrBitmap?.let { bmp ->
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = "My QR Code",
                    modifier = Modifier.size(200.dp).padding(8.dp).align(Alignment.CenterHorizontally)
                )
            }
            Text("Others can scan this to add you", fontSize = 12.sp, color = RocColors.TextSecondary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        }
        HorizontalDivider()

        // Linked Devices
        Text("Linked Devices", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        ListItem(
            headlineContent = { Text("Scan QR Code", fontWeight = FontWeight.Medium) },
            supportingContent = { Text("Link RocChat Web or another device", color = RocColors.TextSecondary, fontSize = 13.sp) },
            leadingContent = {
                Icon(Icons.Default.QrCodeScanner, contentDescription = null, tint = RocColors.RocGold, modifier = Modifier.size(28.dp))
            },
            modifier = Modifier.clickable {
                if (hasCameraPermission) {
                    showQrScanner = true
                } else {
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                }
            },
        )
        if (linkMessage != null) {
            Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                val isSuccess = linkMessage?.contains("✓") == true
                Icon(
                    if (isSuccess) Icons.Default.CheckCircle else Icons.Default.Error,
                    contentDescription = null,
                    tint = if (isSuccess) RocColors.Success else RocColors.Danger,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(linkMessage ?: "", fontSize = 13.sp, color = if (isSuccess) RocColors.Success else RocColors.Danger)
            }
        }

        // Device list
        devicesList.forEach { d ->
            val devName = d.optString("device_name", "Unknown")
            val platform = d.optString("platform", "")
            val devIcon = if (platform == "ios" || platform == "android") "📱" else "💻"
            val devId = d.optString("id", "")
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("$devIcon $devName · $platform", fontSize = 14.sp, modifier = Modifier.weight(1f))
                IconButton(onClick = {
                    scope.launch {
                        try { APIClient.delete("/devices/$devId") } catch (_: Exception) {}
                        try {
                            val arr = APIClient.getArray("/devices")
                            devicesList = (0 until arr.length()).map { arr.getJSONObject(it) }
                        } catch (_: Exception) {}
                    }
                }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.Delete, contentDescription = "Remove", tint = RocColors.Danger, modifier = Modifier.size(18.dp))
                }
            }
        }

        // Verify device
        ListItem(
            headlineContent = { Text("Generate Verification Code", fontWeight = FontWeight.Medium) },
            supportingContent = { Text("6-digit code for new device", fontSize = 13.sp, color = RocColors.TextSecondary) },
            leadingContent = { Icon(Icons.Default.Key, contentDescription = null, tint = RocColors.RocGold, modifier = Modifier.size(24.dp)) },
            modifier = Modifier.clickable {
                scope.launch {
                    try {
                        val res = APIClient.post("/devices/verify/initiate", JSONObject())
                        verifyCode = res.optString("code", "")
                        // Poll for key transfer requests from new device
                        pollForKeyTransferRequests(scope, context)
                    } catch (_: Exception) {}
                }
            },
        )
        verifyCode?.let { code ->
            Text(
                code.chunked(3).joinToString(" "),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                fontSize = 28.sp,
                fontFamily = FontFamily.Monospace,
                color = RocColors.RocGold,
                letterSpacing = 6.sp,
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = verifyInput,
                onValueChange = { if (it.length <= 6 && it.all { c -> c.isDigit() }) verifyInput = it },
                label = { Text("Enter 6-digit code") },
                modifier = Modifier.weight(1f),
                singleLine = true,
            )
            Spacer(Modifier.width(8.dp))
            TextButton(
                enabled = verifyInput.length == 6,
                onClick = {
                    scope.launch {
                        try {
                            val res = APIClient.post("/devices/verify/confirm", JSONObject().apply { put("code", verifyInput) })
                            if (res.optBoolean("verified", false)) {
                                linkMessage = "✓ Verified — requesting keys..."
                                verifyInput = ""
                                // Request key transfer as new device
                                requestKeyTransferAsNewDevice(scope, context) { msg -> linkMessage = msg }
                            } else {
                                linkMessage = "Invalid or expired code"
                            }
                        } catch (_: Exception) { linkMessage = "Verification failed" }
                    }
                },
            ) { Text("Verify") }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

        // Invite Link
        Text("Invite Link", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        ListItem(
            headlineContent = { Text(if (isGeneratingLink) "Generating..." else if (inviteLink != null) "Regenerate" else "Generate Invite Link") },
            leadingContent = { Icon(Icons.Default.Link, contentDescription = null, tint = RocColors.RocGold) },
            modifier = Modifier.clickable(enabled = !isGeneratingLink) {
                isGeneratingLink = true
                scope.launch {
                    try {
                        val res = APIClient.get("/contacts/invite-link")
                        inviteLink = res.optString("link", "")
                    } catch (_: Exception) {}
                    isGeneratingLink = false
                }
            },
        )
        inviteLink?.let { link ->
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(link, fontSize = 12.sp, color = RocColors.Turquoise, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f), maxLines = 1)
                IconButton(onClick = {
                    val clip = android.content.ClipData.newPlainText("invite", link)
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(clip)
                }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.ContentCopy, contentDescription = "Copy", modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = {
                    val sendIntent = android.content.Intent().apply {
                        action = android.content.Intent.ACTION_SEND
                        putExtra(android.content.Intent.EXTRA_TEXT, link)
                        type = "text/plain"
                    }
                    context.startActivity(android.content.Intent.createChooser(sendIntent, "Share invite"))
                }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.Share, contentDescription = "Share", modifier = Modifier.size(18.dp))
                }
            }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

        // Import Chat History
        Text("Import Chat History", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        Text("Upload an exported chat file. Messages are re-encrypted with your RocChat keys.", modifier = Modifier.padding(horizontal = 16.dp), fontSize = 12.sp, color = RocColors.TextSecondary)
        listOf("whatsapp" to "📱 WhatsApp (.txt)", "telegram" to "✈️ Telegram (.json)", "signal" to "🔒 Signal (.json)").forEach { (source, label) ->
            ListItem(
                headlineContent = { Text(label) },
                modifier = Modifier.clickable {
                    importSource = source
                    importFileLauncher.launch(if (source == "whatsapp") "text/plain" else "application/json")
                },
            )
        }
        if (importStatus.isNotEmpty()) {
            Text(importStatus, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), fontSize = 12.sp, color = RocColors.Turquoise)
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

        // Blocked Contacts
        Text("Blocked Contacts", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        ListItem(
            headlineContent = { Text("View Blocked Users", fontWeight = FontWeight.Medium) },
            leadingContent = { Icon(Icons.Default.Block, contentDescription = null, tint = RocColors.RocGold) },
            modifier = Modifier.clickable {
                scope.launch {
                    try {
                        val arr = APIClient.getArray("/contacts")
                        blockedContacts = (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optInt("blocked", 0) == 1 }
                    } catch (_: Exception) {}
                }
                showBlockedList = true
            },
        )
        HorizontalDivider()

        // Default Disappearing Timer
        Text("Default Disappearing Timer", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        var timerExpanded by remember { mutableStateOf(false) }
        val timerOptions = listOf(0 to "Off", 300 to "5 min", 3600 to "1 hour", 86400 to "24 hours", 604800 to "7 days", 2592000 to "30 days")
        Box(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(modifier = Modifier.fillMaxWidth().clickable { timerExpanded = true }, verticalAlignment = Alignment.CenterVertically) {
                Text("New chats auto-delete", modifier = Modifier.weight(1f), fontSize = 14.sp)
                Text(timerOptions.firstOrNull { it.first == defaultDisappearTimer }?.second ?: "Off", color = RocColors.TextSecondary, fontSize = 14.sp)
                Icon(Icons.Default.ArrowDropDown, contentDescription = null, tint = RocColors.TextSecondary)
            }
            DropdownMenu(expanded = timerExpanded, onDismissRequest = { timerExpanded = false }) {
                timerOptions.forEach { (value, label) ->
                    DropdownMenuItem(
                        text = { Text(label) },
                        onClick = {
                            defaultDisappearTimer = value
                            timerExpanded = false
                            scope.launch { try { APIClient.updateSettings(mapOf("default_disappear_timer" to value)) } catch (_: Exception) {} }
                        },
                    )
                }
            }
        }
        HorizontalDivider()

        // Privacy header
        Text("Privacy", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)

        // Ghost Mode
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("👻 Ghost Mode", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                Text("No receipts, no typing, no online, 24h auto-delete", fontSize = 12.sp, color = RocColors.TextSecondary)
            }
            Switch(
                checked = ghostMode,
                onCheckedChange = { on ->
                    ghostMode = on
                    scope.launch {
                        try {
                            if (on) {
                                APIClient.updateSettings(mapOf("show_read_receipts" to 0, "show_typing_indicator" to 0, "show_online_to" to "nobody", "default_disappear_timer" to 86400))
                                readReceipts = false; typingIndicators = false; onlineVisibility = "nobody"
                            } else {
                                APIClient.updateSettings(mapOf("show_read_receipts" to 1, "show_typing_indicator" to 1, "show_online_to" to "everyone", "default_disappear_timer" to 0))
                                readReceipts = true; typingIndicators = true; onlineVisibility = "everyone"
                            }
                        } catch (_: Exception) {}
                    }
                },
                colors = SwitchDefaults.colors(checkedThumbColor = RocColors.RocGold, checkedTrackColor = RocColors.RocGold.copy(alpha = 0.3f)),
            )
        }

        SettingToggle("Discoverable by username", discoverable) {
            discoverable = it
            scope.launch { try { APIClient.updateSettings(mapOf("discoverable" to if (it) 1 else 0)) } catch (_: Exception) {} }
        }
        SettingToggle("Read receipts", readReceipts) {
            readReceipts = it
            scope.launch { try { APIClient.updateSettings(mapOf("show_read_receipts" to if (it) 1 else 0)) } catch (_: Exception) {} }
        }
        SettingToggle("Typing indicators", typingIndicators) {
            typingIndicators = it
            scope.launch { try { APIClient.updateSettings(mapOf("show_typing_indicator" to if (it) 1 else 0)) } catch (_: Exception) {} }
        }

        // Online visibility picker
        Box(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(modifier = Modifier.fillMaxWidth().clickable { onlineExpanded = true }, verticalAlignment = Alignment.CenterVertically) {
                Text("Online status visible to", modifier = Modifier.weight(1f), fontSize = 14.sp)
                Text(onlineVisibility.replaceFirstChar { it.uppercase() }, color = RocColors.TextSecondary, fontSize = 14.sp)
                Icon(Icons.Default.ArrowDropDown, contentDescription = null, tint = RocColors.TextSecondary)
            }
            DropdownMenu(expanded = onlineExpanded, onDismissRequest = { onlineExpanded = false }) {
                listOf("everyone", "contacts", "nobody").forEach { opt ->
                    DropdownMenuItem(
                        text = { Text(opt.replaceFirstChar { it.uppercase() }) },
                        onClick = {
                            onlineVisibility = opt
                            onlineExpanded = false
                            scope.launch { try { APIClient.updateSettings(mapOf("show_online_to" to opt)) } catch (_: Exception) {} }
                        },
                    )
                }
            }
        }

        // Who can add me picker
        Box(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(modifier = Modifier.fillMaxWidth().clickable { whoCanAddExpanded = true }, verticalAlignment = Alignment.CenterVertically) {
                Text("Who can add me", modifier = Modifier.weight(1f), fontSize = 14.sp)
                Text(whoCanAdd.replaceFirstChar { it.uppercase() }, color = RocColors.TextSecondary, fontSize = 14.sp)
                Icon(Icons.Default.ArrowDropDown, contentDescription = null, tint = RocColors.TextSecondary)
            }
            DropdownMenu(expanded = whoCanAddExpanded, onDismissRequest = { whoCanAddExpanded = false }) {
                listOf("everyone", "nobody").forEach { opt ->
                    DropdownMenuItem(
                        text = { Text(opt.replaceFirstChar { it.uppercase() }) },
                        onClick = {
                            whoCanAdd = opt
                            whoCanAddExpanded = false
                            scope.launch { try { APIClient.updateSettings(mapOf("who_can_add" to opt)) } catch (_: Exception) {} }
                        },
                    )
                }
            }
        }

        // Last seen visible to picker
        var lastSeenExpanded by remember { mutableStateOf(false) }
        Box(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(modifier = Modifier.fillMaxWidth().clickable { lastSeenExpanded = true }, verticalAlignment = Alignment.CenterVertically) {
                Text("Last seen visible to", modifier = Modifier.weight(1f), fontSize = 14.sp)
                Text(lastSeenVisibility.replaceFirstChar { it.uppercase() }, color = RocColors.TextSecondary, fontSize = 14.sp)
                Icon(Icons.Default.ArrowDropDown, contentDescription = null, tint = RocColors.TextSecondary)
            }
            DropdownMenu(expanded = lastSeenExpanded, onDismissRequest = { lastSeenExpanded = false }) {
                listOf("everyone", "contacts", "nobody").forEach { opt ->
                    DropdownMenuItem(
                        text = { Text(opt.replaceFirstChar { it.uppercase() }) },
                        onClick = {
                            lastSeenVisibility = opt
                            lastSeenExpanded = false
                            scope.launch { try { APIClient.updateSettings(mapOf("show_last_seen_to" to opt)) } catch (_: Exception) {} }
                        },
                    )
                }
            }
        }

        // Profile photo visible to picker
        var photoVisExpanded by remember { mutableStateOf(false) }
        Box(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(modifier = Modifier.fillMaxWidth().clickable { photoVisExpanded = true }, verticalAlignment = Alignment.CenterVertically) {
                Text("Profile photo visible to", modifier = Modifier.weight(1f), fontSize = 14.sp)
                Text(photoVisibility.replaceFirstChar { it.uppercase() }, color = RocColors.TextSecondary, fontSize = 14.sp)
                Icon(Icons.Default.ArrowDropDown, contentDescription = null, tint = RocColors.TextSecondary)
            }
            DropdownMenu(expanded = photoVisExpanded, onDismissRequest = { photoVisExpanded = false }) {
                listOf("everyone", "contacts", "nobody").forEach { opt ->
                    DropdownMenuItem(
                        text = { Text(opt.replaceFirstChar { it.uppercase() }) },
                        onClick = {
                            photoVisibility = opt
                            photoVisExpanded = false
                            scope.launch { try { APIClient.updateSettings(mapOf("show_photo_to" to opt)) } catch (_: Exception) {} }
                        },
                    )
                }
            }
        }

        // Link preview mode
        val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
        var linkPreviewMode by remember { mutableStateOf(prefs.getString("link_preview_mode", "server") ?: "server") }
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Link previews", fontSize = 14.sp)
                Text("Server hides IP; Client-side hides URLs from server", fontSize = 12.sp, color = RocColors.TextSecondary)
            }
            var expanded by remember { mutableStateOf(false) }
            Box {
                TextButton(onClick = { expanded = true }) {
                    Text(when (linkPreviewMode) { "client" -> "Client"; "disabled" -> "Off"; else -> "Server" })
                }
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    DropdownMenuItem(text = { Text("Server (default)") }, onClick = { linkPreviewMode = "server"; prefs.edit().putString("link_preview_mode", "server").apply(); expanded = false })
                    DropdownMenuItem(text = { Text("Client-side (private)") }, onClick = { linkPreviewMode = "client"; prefs.edit().putString("link_preview_mode", "client").apply(); expanded = false })
                    DropdownMenuItem(text = { Text("Disabled") }, onClick = { linkPreviewMode = "disabled"; prefs.edit().putString("link_preview_mode", "disabled").apply(); expanded = false })
                }
            }
        }

        // Screenshot detection toggle
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Screenshot detection", fontSize = 14.sp)
                Text("Notify when view-once messages are screenshotted", fontSize = 12.sp, color = RocColors.TextSecondary)
            }
            Switch(checked = screenshotDetect, onCheckedChange = { v ->
                screenshotDetect = v
                scope.launch { try { APIClient.updateSettings(mapOf("screenshot_detection" to if (v) 1 else 0)) } catch (_: Exception) {} }
            })
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
        Text("Quiet Hours", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        var quietEnabled by remember { mutableStateOf(false) }
        var quietStartHour by remember { mutableIntStateOf(22) }
        var quietStartMin by remember { mutableIntStateOf(0) }
        var quietEndHour by remember { mutableIntStateOf(7) }
        var quietEndMin by remember { mutableIntStateOf(0) }

        LaunchedEffect(Unit) {
            try {
                val qh = APIClient.get("/features/quiet-hours")
                val qs = qh.optString("quiet_start", "")
                val qe = qh.optString("quiet_end", "")
                if (qs.isNotEmpty() && qe.isNotEmpty()) {
                    quietEnabled = true
                    qs.split(":").let { quietStartHour = it[0].toInt(); quietStartMin = it[1].toInt() }
                    qe.split(":").let { quietEndHour = it[0].toInt(); quietEndMin = it[1].toInt() }
                }
            } catch (_: Exception) {}
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Enable Quiet Hours", fontSize = 15.sp)
                Text("Silence notifications during set hours", fontSize = 12.sp, color = RocColors.TextSecondary)
            }
            Switch(
                checked = quietEnabled,
                onCheckedChange = { on ->
                    quietEnabled = on
                    scope.launch {
                        try {
                            if (on) {
                                APIClient.post("/features/quiet-hours", org.json.JSONObject().apply {
                                    put("quiet_start", String.format("%02d:%02d", quietStartHour, quietStartMin))
                                    put("quiet_end", String.format("%02d:%02d", quietEndHour, quietEndMin))
                                }, "PUT")
                            } else {
                                APIClient.delete("/features/quiet-hours")
                            }
                        } catch (_: Exception) {}
                    }
                },
                colors = SwitchDefaults.colors(checkedThumbColor = RocColors.RocGold, checkedTrackColor = RocColors.RocGold.copy(alpha = 0.3f)),
            )
        }
        if (quietEnabled) {
            var showStartPicker by remember { mutableStateOf(false) }
            var showEndPicker by remember { mutableStateOf(false) }
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("From: ", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { showStartPicker = true }) {
                    Text(String.format("%02d:%02d", quietStartHour, quietStartMin), fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.width(16.dp))
                Text("To: ", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { showEndPicker = true }) {
                    Text(String.format("%02d:%02d", quietEndHour, quietEndMin), fontWeight = FontWeight.SemiBold)
                }
            }
            if (showStartPicker) {
                AlertDialog(
                    onDismissRequest = { showStartPicker = false },
                    title = { Text("Quiet hours start") },
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                            NumberPicker(value = quietStartHour, range = 0..23, onValueChange = { quietStartHour = it })
                            Text(" : ", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                            NumberPicker(value = quietStartMin, range = 0..59, onValueChange = { quietStartMin = it })
                        }
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            showStartPicker = false
                            scope.launch { try { APIClient.post("/features/quiet-hours", org.json.JSONObject().apply { put("quiet_start", String.format("%02d:%02d", quietStartHour, quietStartMin)); put("quiet_end", String.format("%02d:%02d", quietEndHour, quietEndMin)) }, "PUT") } catch (_: Exception) {} }
                        }) { Text("OK") }
                    },
                    dismissButton = { TextButton(onClick = { showStartPicker = false }) { Text("Cancel") } }
                )
            }
            if (showEndPicker) {
                AlertDialog(
                    onDismissRequest = { showEndPicker = false },
                    title = { Text("Quiet hours end") },
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                            NumberPicker(value = quietEndHour, range = 0..23, onValueChange = { quietEndHour = it })
                            Text(" : ", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                            NumberPicker(value = quietEndMin, range = 0..59, onValueChange = { quietEndMin = it })
                        }
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            showEndPicker = false
                            scope.launch { try { APIClient.post("/features/quiet-hours", org.json.JSONObject().apply { put("quiet_start", String.format("%02d:%02d", quietStartHour, quietStartMin)); put("quiet_end", String.format("%02d:%02d", quietEndHour, quietEndMin)) }, "PUT") } catch (_: Exception) {} }
                        }) { Text("OK") }
                    },
                    dismissButton = { TextButton(onClick = { showEndPicker = false }) { Text("Cancel") } }
                )
            }
        }

        // Keyword Alerts
        var alertKeywords by remember { mutableStateOf(listOf<String>()) }
        var newKeyword by remember { mutableStateOf("") }

        LaunchedEffect(Unit) {
            try {
                val qh = APIClient.get("/features/quiet-hours")
                val arr = qh.optJSONArray("alert_keywords")
                if (arr != null) {
                    alertKeywords = (0 until arr.length()).map { arr.getString(it) }
                }
            } catch (_: Exception) {}
        }

        Spacer(Modifier.height(8.dp))
        Text("Keyword Alerts", modifier = Modifier.padding(horizontal = 16.dp), fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = RocColors.RocGold)
        Text("Get notified even during Quiet Hours when a message contains these keywords.",
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp), fontSize = 11.sp, color = RocColors.TextSecondary)

        if (alertKeywords.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                alertKeywords.forEach { kw ->
                    InputChip(
                        selected = false,
                        onClick = {
                            alertKeywords = alertKeywords.filter { it != kw }
                            scope.launch {
                                try { APIClient.post("/features/quiet-hours", org.json.JSONObject().apply { put("alert_keywords", org.json.JSONArray(alertKeywords)) }, "PUT") } catch (_: Exception) {}
                            }
                        },
                        label = { Text(kw, fontSize = 12.sp) },
                        trailingIcon = { Icon(Icons.Default.Close, contentDescription = "Remove", modifier = Modifier.size(14.dp)) },
                    )
                }
            }
        }

        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = newKeyword,
                onValueChange = { newKeyword = it },
                modifier = Modifier.weight(1f).height(48.dp),
                placeholder = { Text("Add keyword...", fontSize = 12.sp) },
                textStyle = LocalTextStyle.current.copy(fontSize = 12.sp),
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    val kw = newKeyword.trim().lowercase()
                    if (kw.isNotEmpty() && kw !in alertKeywords && alertKeywords.size < 20) {
                        alertKeywords = alertKeywords + kw
                        newKeyword = ""
                        scope.launch {
                            try { APIClient.post("/features/quiet-hours", org.json.JSONObject().apply { put("alert_keywords", org.json.JSONArray(alertKeywords)) }, "PUT") } catch (_: Exception) {}
                        }
                    }
                }),
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = {
                    val kw = newKeyword.trim().lowercase()
                    if (kw.isNotEmpty() && kw !in alertKeywords && alertKeywords.size < 20) {
                        alertKeywords = alertKeywords + kw
                        newKeyword = ""
                        scope.launch {
                            try { APIClient.post("/features/quiet-hours", org.json.JSONObject().apply { put("alert_keywords", org.json.JSONArray(alertKeywords)) }, "PUT") } catch (_: Exception) {}
                        }
                    }
                },
                enabled = newKeyword.trim().isNotEmpty() && alertKeywords.size < 20,
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add", tint = RocColors.RocGold)
            }
        }
        if (alertKeywords.size >= 20) {
            Text("Maximum 20 keywords", modifier = Modifier.padding(horizontal = 16.dp), fontSize = 11.sp, color = RocColors.Danger)
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Appearance
        Text("Appearance", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("system" to "System", "dark" to "Dark", "light" to "Light").forEach { (key, label) ->
                FilterChip(
                    selected = appTheme == key,
                    onClick = {
                        appTheme = key
                        context.getSharedPreferences("rocchat", Context.MODE_PRIVATE).edit().putString("app_theme", key).apply()
                    },
                    label = { Text(label) },
                )
            }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Encryption
        Text("Encryption", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Lock, contentDescription = null, tint = RocColors.Turquoise)
            Spacer(Modifier.width(12.dp))
            Column {
                Text("End-to-end encrypted", color = RocColors.Turquoise, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("X25519 + AES-256-GCM + Double Ratchet", fontSize = 11.sp, color = RocColors.TextSecondary)
            }
        }
        if (identityKeyFingerprint.isNotEmpty()) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Text("Your Identity Key", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(identityKeyFingerprint, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = RocColors.TextSecondary)
            }
        }
        ListItem(
            headlineContent = { Text("Recovery Phrase", fontWeight = FontWeight.Medium) },
            leadingContent = { Icon(Icons.Default.Key, contentDescription = null, tint = RocColors.RocGold) },
            modifier = Modifier.clickable {
                if (recoveryPhrase.isEmpty()) {
                    val result = com.rocchat.crypto.BIP39.generate()
                    recoveryPhrase = result.mnemonic
                    // Derive recovery key and encrypt identity keys for server backup
                    val recoveryKey = com.rocchat.crypto.BIP39.deriveRecoveryKey(result.entropy)
                    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                    val identityPriv = prefs.getString("identity_key_private", null)
                    if (identityPriv != null) {
                        try {
                            val bundle = org.json.JSONObject().apply {
                                put("identityPrivate", identityPriv)
                            }
                            val encrypted = com.rocchat.crypto.BIP39.encryptForRecovery(
                                bundle.toString().toByteArray(), recoveryKey
                            )
                            val blob = android.util.Base64.encodeToString(encrypted, android.util.Base64.NO_WRAP)
                            // Upload recovery vault blob
                            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
                                try { apiClient.post("/recovery/vault", mapOf("blob" to blob)) } catch (_: Exception) {}
                            }
                        } catch (_: Exception) {}
                    }
                    prefs.edit().putString("recovery_phrase", recoveryPhrase).apply()
                }
                showRecoveryPhrase = true
            },
        )

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Premium Features
        Text("Premium Features", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.WorkspacePremium, contentDescription = null, tint = RocColors.RocGold, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(12.dp))
            Column {
                Text("RocChat Premium", fontWeight = FontWeight.SemiBold, color = RocColors.RocGold)
                Text("Chat themes, scheduled messages, chat folders & more", fontSize = 12.sp, color = RocColors.TextSecondary)
            }
        }
        listOf("Chat Themes" to Icons.Default.Palette, "Scheduled Messages" to Icons.Default.Schedule, "Chat Folders" to Icons.Default.Folder).forEach { (label, icon) ->
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = RocColors.TextSecondary, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(12.dp))
                Text(label, modifier = Modifier.weight(1f))
                Text("Free", fontSize = 12.sp, color = RocColors.Success)
            }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Power-User Features
        Text("Power-User Features", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        listOf(
            Triple("Decoy Conversations", Icons.Default.TheaterComedy, { showDecoyManager = true; val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE); val raw = prefs.getString("rocchat_decoy_convs", "[]") ?: "[]"; try { val arr = org.json.JSONArray(raw); decoyConversations = (0 until arr.length()).map { arr.getJSONObject(it) } } catch (_: Exception) {} }),
            Triple("Custom Emoji", Icons.Default.EmojiEmotions, { showEmojiManager = true; val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE); val raw = prefs.getString("rocchat_custom_emoji", "[]") ?: "[]"; try { val arr = org.json.JSONArray(raw); customEmojis = (0 until arr.length()).map { arr.getJSONObject(it) } } catch (_: Exception) {} }),
            Triple("Encrypted Backup", Icons.Default.Backup, { showBackupSheet = true }),
        ).forEach { (label, icon, action) ->
            Row(modifier = Modifier.fillMaxWidth().clickable { action() }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = RocColors.TextSecondary, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(12.dp))
                Text(label)
            }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Saved Contacts
        Text("Saved Contacts", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        Row(modifier = Modifier.fillMaxWidth().clickable { showSavedContacts = true; scope.launch { try { val data = APIClient.getArray("/features/contacts"); savedContacts = (0 until data.length()).map { data.getJSONObject(it) } } catch (_: Exception) {} } }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Contacts, contentDescription = null, tint = RocColors.TextSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("Manage Saved Contacts")
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Support RocChat
        Text("Support RocChat", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Text("💛 ", fontSize = 14.sp)
            Text("All features are free forever", fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        }
        Text(
            "RocChat is built with love. If you enjoy the app, consider supporting development with a donation.",
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            fontSize = 12.sp,
            color = RocColors.TextSecondary,
        )
        Row(modifier = Modifier.fillMaxWidth().clickable { showDonationSheet = true; scope.launch { try { val data = APIClient.get("/features/donor"); donorTier = data.optString("tier", ""); donorSince = data.optString("donor_since", "") } catch (_: Exception) {} } }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Favorite, contentDescription = null, tint = RocColors.RocGold, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("Donate", color = RocColors.RocGold)
        }
        if (donorTier.isNotEmpty()) {
            val badge = when (donorTier.lowercase()) { "coffee" -> "☕"; "feather" -> "🪶"; "wing" -> "🦅"; "mountain" -> "🏔️"; "patron" -> "👑"; else -> "💛" }
            Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Text(badge, fontSize = 20.sp)
                Spacer(Modifier.width(8.dp))
                Text("${donorTier.replaceFirstChar { it.uppercase() }} Supporter", color = RocColors.RocGold, fontWeight = FontWeight.SemiBold)
            }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Roc Bird status, Transparency, Supporters
        var showCanary by remember { mutableStateOf(false) }
        var showTransparency by remember { mutableStateOf(false) }
        var showSupporters by remember { mutableStateOf(false) }

        Row(
            modifier = Modifier.fillMaxWidth().clickable { showCanary = true }.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Shield, contentDescription = null, tint = RocColors.TextSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("Roc Bird Status")
        }
        Row(
            modifier = Modifier.fillMaxWidth().clickable { showTransparency = true }.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Description, contentDescription = null, tint = RocColors.TextSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("Transparency Reports")
        }
        Row(
            modifier = Modifier.fillMaxWidth().clickable { showSupporters = true }.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Favorite, contentDescription = null, tint = RocColors.TextSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("Supporters")
        }

        if (showCanary) {
            CanarySheet(onDismiss = { showCanary = false })
        }
        if (showTransparency) {
            TransparencySheet(onDismiss = { showTransparency = false })
        }
        if (showSupporters) {
            SupportersSheet(onDismiss = { showSupporters = false })
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // About
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text("Version", modifier = Modifier.weight(1f))
            Text("0.1.0", color = RocColors.TextSecondary)
        }
        Text(
            "Free & open for everyone",
            modifier = Modifier.padding(horizontal = 16.dp),
            fontSize = 13.sp,
            color = RocColors.TextSecondary,
        )
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Text("Part of the ", fontSize = 13.sp, color = RocColors.TextSecondary)
            Text("Roc Family", fontSize = 13.sp, color = RocColors.RocGold, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(24.dp))

        OutlinedButton(
            onClick = {
                scope.launch {
                    try {
                        val json = APIClient.get("/me/export")
                        val exportObj = json.getJSONObject("export")
                        val file = java.io.File(context.cacheDir, "rocchat-export-${System.currentTimeMillis() / 1000}.json")
                        file.writeText(exportObj.toString(2))
                        val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                        val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                            type = "application/json"
                            putExtra(android.content.Intent.EXTRA_STREAM, uri)
                            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        context.startActivity(android.content.Intent.createChooser(intent, "Export Data"))
                    } catch (_: Exception) {}
                }
            },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        ) {
            Text("Export My Data", color = RocColors.RocGold)
        }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = { showDeleteConfirm = true },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = RocColors.Danger),
            border = ButtonDefaults.outlinedButtonBorder(enabled = true),
        ) {
            Text("Delete Account")
        }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onLogout,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = RocColors.Danger),
            border = ButtonDefaults.outlinedButtonBorder(enabled = true),
        ) {
            Text("Sign Out")
        }

        // Edit Name dialog
        if (showEditName) {
            AlertDialog(
                onDismissRequest = { showEditName = false },
                title = { Text("Edit Display Name") },
                text = {
                    OutlinedTextField(value = editNameText, onValueChange = { editNameText = it }, label = { Text("Display name") }, singleLine = true)
                },
                confirmButton = {
                    TextButton(onClick = {
                        val newName = editNameText.trim()
                        if (newName.isNotEmpty()) {
                            displayName = newName
                            scope.launch { try { APIClient.updateSettings(mapOf("display_name" to encryptProfileField(context, newName))) } catch (_: Exception) {} }
                        }
                        showEditName = false
                    }) { Text("Save") }
                },
                dismissButton = { TextButton(onClick = { showEditName = false }) { Text("Cancel") } },
            )
        }

        // Status text edit
        if (showStatusDialog) {
            AlertDialog(
                onDismissRequest = { showStatusDialog = false },
                title = { Text("Set Status") },
                text = {
                    OutlinedTextField(value = editStatusText, onValueChange = { if (it.length <= 140) editStatusText = it }, label = { Text("What's on your mind?") }, singleLine = true)
                },
                confirmButton = {
                    TextButton(onClick = {
                        val text = editStatusText.trim().take(140)
                        statusText = text
                        scope.launch { try { APIClient.updateSettings(mapOf("status_text" to encryptProfileField(context, text))) } catch (_: Exception) {} }
                        showStatusDialog = false
                    }) { Text("Save") }
                },
                dismissButton = { TextButton(onClick = { showStatusDialog = false }) { Text("Cancel") } },
            )
        }

        // Delete Account confirmation
        if (showDeleteConfirm) {
            AlertDialog(
                onDismissRequest = { showDeleteConfirm = false },
                title = { Text("Delete Account") },
                text = { Text("This will permanently delete your account, all messages, and keys. This cannot be undone.") },
                confirmButton = {
                    TextButton(onClick = {
                        showDeleteConfirm = false
                        scope.launch {
                            try { APIClient.delete("/me") } catch (_: Exception) {}
                            onLogout()
                        }
                    }) { Text("Delete", color = RocColors.Danger) }
                },
                dismissButton = { TextButton(onClick = { showDeleteConfirm = false }) { Text("Cancel") } },
            )
        }

        // Blocked Contacts dialog
        if (showBlockedList) {
            AlertDialog(
                onDismissRequest = { showBlockedList = false },
                title = { Text("Blocked Contacts") },
                text = {
                    if (blockedContacts.isEmpty()) {
                        Text("No blocked contacts", color = RocColors.TextSecondary)
                    } else {
                        LazyColumn(modifier = Modifier.heightIn(max = 350.dp)) {
                            items(blockedContacts.size) { idx ->
                                val c = blockedContacts[idx]
                                val name = c.optString("display_name", c.optString("username", "Unknown"))
                                val blockedId = c.optString("user_id", c.optString("id", ""))
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(name, modifier = Modifier.weight(1f))
                                    TextButton(onClick = {
                                        scope.launch {
                                            try { APIClient.post("/contacts/block", JSONObject().put("userId", blockedId).put("blocked", false)) } catch (_: Exception) {}
                                            try {
                                                val arr = APIClient.getArray("/contacts")
                                                blockedContacts = (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optInt("blocked", 0) == 1 }
                                            } catch (_: Exception) {}
                                        }
                                    }) { Text("Unblock", color = RocColors.RocGold) }
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showBlockedList = false }) { Text("Done") } },
            )
        }

        // Recovery Phrase dialog
        if (showRecoveryPhrase) {
            AlertDialog(
                onDismissRequest = { showRecoveryPhrase = false },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Key, contentDescription = null, tint = RocColors.RocGold)
                        Spacer(Modifier.width(8.dp))
                        Text("Recovery Phrase")
                    }
                },
                text = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Write these words down and store them safely. They are the only way to recover your encryption keys.", fontSize = 12.sp, color = RocColors.TextSecondary)
                        Spacer(Modifier.height(16.dp))
                        val words = recoveryPhrase.split(" ")
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            for (row in words.chunked(3)) {
                                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                                    row.forEachIndexed { idx, word ->
                                        val wordIdx = words.indexOf(word) + 1
                                        Text(
                                            "$wordIdx. $word",
                                            fontSize = 13.sp,
                                            fontFamily = FontFamily.Monospace,
                                            modifier = Modifier
                                                .background(RocColors.RocGold.copy(alpha = 0.08f), shape = RoundedCornerShape(6.dp))
                                                .padding(horizontal = 8.dp, vertical = 4.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showRecoveryPhrase = false }) { Text("Done") } },
            )
        }

        // Decoy Conversations dialog
        if (showDecoyManager) {
            AlertDialog(
                onDismissRequest = { showDecoyManager = false },
                title = { Text("Decoy Conversations") },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        OutlinedTextField(value = decoyNameInput, onValueChange = { decoyNameInput = it }, label = { Text("Contact name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = decoyMessageInput, onValueChange = { decoyMessageInput = it }, label = { Text("Messages (sender|text per line)") }, modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp), maxLines = 6)
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = {
                            val name = decoyNameInput.trim()
                            if (name.isNotEmpty()) {
                                val msgs = org.json.JSONArray()
                                decoyMessageInput.lines().filter { it.isNotBlank() }.forEach { line ->
                                    val parts = line.split("|", limit = 2)
                                    val m = JSONObject()
                                    m.put("sender", if (parts.size > 1) parts[0] else "Them")
                                    m.put("text", if (parts.size > 1) parts[1] else line)
                                    msgs.put(m)
                                }
                                val decoy = JSONObject().put("id", "decoy_${java.util.UUID.randomUUID().toString().take(8)}").put("name", name).put("messages", msgs)
                                val list = decoyConversations.toMutableList()
                                list.add(decoy)
                                decoyConversations = list
                                val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                                prefs.edit().putString("rocchat_decoy_convs", org.json.JSONArray(list.map { it }).toString()).apply()
                                decoyNameInput = ""; decoyMessageInput = ""
                            }
                        }, modifier = Modifier.fillMaxWidth()) { Text("Add Decoy") }
                        Spacer(Modifier.height(12.dp))
                        if (decoyConversations.isEmpty()) {
                            Text("No decoy conversations", color = RocColors.TextSecondary, fontSize = 12.sp)
                        }
                        decoyConversations.forEachIndexed { idx, decoy ->
                            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(decoy.optString("name", "Unnamed"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                    Text("${decoy.optJSONArray("messages")?.length() ?: 0} messages", fontSize = 12.sp, color = RocColors.TextSecondary)
                                }
                                TextButton(onClick = {
                                    val list = decoyConversations.toMutableList()
                                    list.removeAt(idx)
                                    decoyConversations = list
                                    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                                    prefs.edit().putString("rocchat_decoy_convs", org.json.JSONArray(list.map { it }).toString()).apply()
                                }) { Text("Delete", color = RocColors.Danger) }
                            }
                            HorizontalDivider()
                        }
                        Spacer(Modifier.height(8.dp))
                        Text("Decoy conversations appear in your chat list with fake messages. Stored locally only.", fontSize = 11.sp, color = RocColors.TextSecondary)
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showDecoyManager = false }) { Text("Done") } },
            )
        }

        // Custom Emoji dialog
        if (showEmojiManager) {
            AlertDialog(
                onDismissRequest = { showEmojiManager = false },
                title = { Text("Custom Emoji (${customEmojis.size}/64)") },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        OutlinedTextField(value = emojiShortcodeInput, onValueChange = { emojiShortcodeInput = it.lowercase().replace(" ", "_") }, label = { Text("Shortcode") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        Text("Pick an image from your gallery, max 1MB. Use :shortcode: in messages.", fontSize = 12.sp, color = RocColors.TextSecondary)
                        Spacer(Modifier.height(12.dp))
                        if (customEmojis.isEmpty()) {
                            Text("No custom emoji yet", color = RocColors.TextSecondary, fontSize = 12.sp)
                        }
                        customEmojis.forEachIndexed { idx, emoji ->
                            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(":${emoji.optString("shortcode")}:", fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                                TextButton(onClick = {
                                    val list = customEmojis.toMutableList()
                                    list.removeAt(idx)
                                    customEmojis = list
                                    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                                    prefs.edit().putString("rocchat_custom_emoji", org.json.JSONArray(list.map { it }).toString()).apply()
                                }) { Text("Delete", color = RocColors.Danger) }
                            }
                            HorizontalDivider()
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showEmojiManager = false }) { Text("Done") } },
            )
        }

        // Donation dialog
        if (showDonationSheet) {
            AlertDialog(
                onDismissRequest = { showDonationSheet = false },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Favorite, contentDescription = null, tint = RocColors.RocGold)
                        Spacer(Modifier.width(8.dp))
                        Text("Support RocChat")
                    }
                },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        Text("All features are free forever. Donations support development and server costs.", fontSize = 12.sp, color = RocColors.TextSecondary)
                        Spacer(Modifier.height(12.dp))
                        if (donorTier.isNotEmpty()) {
                            val badge = when (donorTier.lowercase()) { "coffee" -> "☕"; "feather" -> "🪶"; "wing" -> "🦅"; "mountain" -> "🏔️"; "patron" -> "👑"; else -> "💛" }
                            Row(modifier = Modifier.fillMaxWidth().background(RocColors.RocGold.copy(alpha = 0.1f), RoundedCornerShape(12.dp)).padding(12.dp)) {
                                Text(badge, fontSize = 24.sp)
                                Spacer(Modifier.width(8.dp))
                                Column {
                                    Text("${donorTier.replaceFirstChar { it.uppercase() }} Supporter", fontWeight = FontWeight.SemiBold, color = RocColors.RocGold)
                                    if (donorSince.isNotEmpty()) Text("Since ${donorSince.take(10)}", fontSize = 12.sp, color = RocColors.TextSecondary)
                                }
                            }
                            Spacer(Modifier.height(12.dp))
                        }
                        listOf("coffee" to "☕ Coffee · \$3", "feather" to "🪶 Feather · \$5", "wing" to "🦅 Wing · \$10", "mountain" to "🏔️ Mountain · \$25", "patron" to "👑 Patron · \$50").forEach { (tier, label) ->
                            val amount = when (tier) { "coffee" -> 3; "feather" -> 5; "wing" -> 10; "mountain" -> 25; "patron" -> 50; else -> 0 }
                            OutlinedButton(onClick = {
                                scope.launch {
                                    try {
                                        APIClient.post("/billing/crypto/checkout", JSONObject().put("type", "crypto").put("amount", amount).put("recurring", false))
                                        APIClient.post("/features/donor", JSONObject().put("tier", tier))
                                        donorTier = tier
                                    } catch (_: Exception) {}
                                }
                            }, modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) { Text(label) }
                        }
                        if (donorTier.isNotEmpty()) {
                            Spacer(Modifier.height(12.dp))
                            TextButton(onClick = { scope.launch { try { APIClient.delete("/features/donor"); donorTier = "" } catch (_: Exception) {} } }) { Text("Remove Badge", color = RocColors.Danger) }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showDonationSheet = false }) { Text("Done") } },
            )
        }

        // Encrypted Backup dialog
        if (showBackupSheet) {
            AlertDialog(
                onDismissRequest = { showBackupSheet = false },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Backup, contentDescription = null, tint = RocColors.RocGold)
                        Spacer(Modifier.width(8.dp))
                        Text("Encrypted Backup")
                    }
                },
                text = {
                    Column {
                        Text("Export or import an encrypted backup of your keys, sessions, and settings.", fontSize = 12.sp, color = RocColors.TextSecondary)
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(value = backupPassphrase, onValueChange = { backupPassphrase = it }, label = { Text("Passphrase (12+ chars)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = {
                                if (backupPassphrase.length < 12) { backupStatus = "Passphrase must be 12+ characters"; return@Button }
                                scope.launch {
                                    backupStatus = "Exporting..."
                                    try {
                                        val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                                        val backup = JSONObject()
                                        listOf("identity_key_public", "identity_key_private", "recovery_phrase", "rocchat_custom_emoji", "rocchat_decoy_convs", "default_disappear_timer").forEach { key ->
                                            prefs.getString(key, null)?.let { backup.put(key, it) }
                                        }
                                        val plainBytes = backup.toString().toByteArray()
                                        val salt = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
                                        val md = java.security.MessageDigest.getInstance("SHA-256")
                                        md.update(backupPassphrase.toByteArray())
                                        md.update(salt)
                                        val keyBytes = md.digest()
                                        val key = javax.crypto.spec.SecretKeySpec(keyBytes, "AES")
                                        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
                                        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                                        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, iv))
                                        val encrypted = cipher.doFinal(plainBytes)
                                        val header = "ROCCHAT-BACKUP-2".toByteArray()
                                        val output = header + salt + iv + encrypted
                                        val filename = "rocchat-backup-${System.currentTimeMillis() / 1000}.enc"
                                        val file = java.io.File(context.cacheDir, filename)
                                        file.writeBytes(output)
                                        backupStatus = "✅ Backup saved: $filename"
                                    } catch (e: Exception) {
                                        backupStatus = "Export failed: ${e.message}"
                                    }
                                }
                            }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Default.Upload, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("Export")
                            }
                            OutlinedButton(onClick = {
                                if (backupPassphrase.length < 12) { backupStatus = "Passphrase must be 12+ characters"; return@OutlinedButton }
                                backupImportLauncher.launch("application/octet-stream")
                            }, modifier = Modifier.weight(1f)) {
                                Icon(Icons.Default.Download, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("Import")
                            }
                        }
                        if (backupStatus.isNotEmpty()) {
                            Spacer(Modifier.height(8.dp))
                            Text(backupStatus, fontSize = 12.sp, color = if (backupStatus.startsWith("✅")) RocColors.Success else RocColors.TextSecondary)
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showBackupSheet = false }) { Text("Done") } },
            )
        }

        // Saved Contacts dialog
        if (showSavedContacts) {
            AlertDialog(
                onDismissRequest = { showSavedContacts = false },
                title = { Text("Saved Contacts") },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        if (savedContacts.isEmpty()) {
                            Text("No saved contacts", color = RocColors.TextSecondary, fontSize = 12.sp)
                        }
                        savedContacts.forEach { contact ->
                            val name = contact.optString("display_name", contact.optString("username", "Unknown"))
                            val nickname = contact.optString("nickname", "")
                            val cid = contact.optString("contact_id", contact.optString("id", ""))
                            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(name, fontSize = 14.sp)
                                    if (nickname.isNotEmpty()) Text(nickname, fontSize = 12.sp, color = RocColors.RocGold)
                                }
                                TextButton(onClick = {
                                    editNicknameContactId = cid
                                    editNicknameText = nickname
                                    showNicknameDialog = true
                                }) { Text("Nickname") }
                                TextButton(onClick = {
                                    scope.launch {
                                        try { APIClient.delete("/features/contacts/$cid") } catch (_: Exception) {}
                                        try { val data = APIClient.getArray("/features/contacts"); savedContacts = (0 until data.length()).map { data.getJSONObject(it) } } catch (_: Exception) {}
                                    }
                                }) { Text("Remove", color = RocColors.Danger) }
                            }
                            HorizontalDivider()
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { showSavedContacts = false }) { Text("Done") } },
            )
        }

        // Nickname edit dialog
        if (showNicknameDialog) {
            AlertDialog(
                onDismissRequest = { showNicknameDialog = false },
                title = { Text("Set Nickname") },
                text = {
                    OutlinedTextField(
                        value = editNicknameText,
                        onValueChange = { editNicknameText = it },
                        label = { Text("Nickname") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        showNicknameDialog = false
                        scope.launch {
                            try {
                                val body = JSONObject().put("contact_id", editNicknameContactId).put("nickname", editNicknameText)
                                APIClient.post("/features/contacts", body)
                            } catch (_: Exception) {}
                            try { val data = APIClient.getArray("/features/contacts"); savedContacts = (0 until data.length()).map { data.getJSONObject(it) } } catch (_: Exception) {}
                        }
                    }) { Text("Save") }
                },
                dismissButton = { TextButton(onClick = { showNicknameDialog = false }) { Text("Cancel") } },
            )
        }
    }
}

// ── Vault Item Card ──

@Composable
fun VaultItemCard(ciphertext: String, messageId: String) {
    val context = LocalContext.current
    var revealed by remember { mutableStateOf(false) }
    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
    val viewedKey = "vault_viewed_$messageId"

    val vault = remember(ciphertext) {
        try {
            val json = JSONObject(ciphertext)
            mapOf(
                "vaultType" to json.optString("vaultType", ""),
                "label" to json.optString("label", ""),
                "encryptedPayload" to json.optString("encryptedPayload", ""),
                "viewOnce" to json.optBoolean("viewOnce", false).toString(),
            )
        } catch (_: Exception) { emptyMap() }
    }
    val vType = vault["vaultType"] ?: ""
    val label = vault["label"] ?: ""
    val viewOnce = vault["viewOnce"] == "true"
    val alreadyViewed = viewOnce && prefs.getBoolean(viewedKey, false)
    val icon = when (vType) { "password" -> "🔑"; "wifi" -> "📶"; "card" -> "💳"; "note" -> "📝"; else -> "🔐" }

    val fields = remember(vault["encryptedPayload"]) {
        try {
            val decoded = android.util.Base64.decode(vault["encryptedPayload"], android.util.Base64.NO_WRAP)
            val json = JSONObject(String(decoded))
            json.keys().asSequence().map { it to json.optString(it, "") }.toList()
        } catch (_: Exception) { emptyList() }
    }

    Surface(
        shape = RoundedCornerShape(10.dp),
        color = RocColors.RocGold.copy(alpha = 0.08f),
        modifier = Modifier.padding(4.dp),
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(icon, fontSize = 16.sp)
                Spacer(Modifier.width(6.dp))
                Text(label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                if (viewOnce) {
                    Spacer(Modifier.width(6.dp))
                    Text("👁 View once", fontSize = 11.sp, color = Color(0xFFFF9800))
                }
            }
            Spacer(Modifier.height(4.dp))
            if (alreadyViewed) {
                Text("Already viewed", fontSize = 12.sp, color = RocColors.TextSecondary)
            } else if (revealed) {
                fields.forEach { (key, value) ->
                    Row(modifier = Modifier.padding(vertical = 1.dp)) {
                        Text(key.replaceFirstChar { it.uppercase() }, fontSize = 12.sp, color = RocColors.TextSecondary, modifier = Modifier.width(80.dp))
                        if (vType == "card" && key == "number") {
                            Text("•••• ${value.takeLast(4)}", fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                        } else {
                            Text(value, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
                TextButton(onClick = {
                    val text = fields.joinToString("\n") { "${it.first}: ${it.second}" }
                    val clip = android.content.ClipData.newPlainText("vault", text)
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(clip)
                }) { Text("Copy All", color = RocColors.RocGold, fontSize = 12.sp) }
            } else {
                TextButton(onClick = {
                    revealed = true
                    if (viewOnce) prefs.edit().putBoolean(viewedKey, true).apply()
                }) { Text("Tap to reveal", color = RocColors.Turquoise, fontSize = 12.sp) }
            }
        }
    }
}

// ── QR Scanner Screen ──

@AndroidOptIn(ExperimentalGetImage::class)
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QrScannerScreen(onScan: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var hasScanned by remember { mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().background(RocColors.MidnightAzure)) {
        AndroidView(
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                cameraProviderFuture.addListener({
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val imageAnalysis = ImageAnalysis.Builder()
                        .setTargetResolution(Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    imageAnalysis.setAnalyzer(ContextCompat.getMainExecutor(ctx)) { imageProxy ->
                        val mediaImage = imageProxy.image
                        if (mediaImage != null && !hasScanned) {
                            val plane = mediaImage.planes[0]
                            val buffer = plane.buffer
                            val bytes = ByteArray(buffer.remaining())
                            buffer.get(bytes)
                            val width = mediaImage.width
                            val height = mediaImage.height
                            val source = PlanarYUVLuminanceSource(
                                bytes, plane.rowStride, height, 0, 0, width, height, false
                            )
                            try {
                                val bitmap = BinaryBitmap(HybridBinarizer(source))
                                val result = MultiFormatReader().decode(bitmap)
                                val value = result.text
                                if (value != null && value.startsWith("rocchat://") && !hasScanned) {
                                    hasScanned = true
                                    onScan(value)
                                }
                            } catch (_: Exception) {
                                // No QR code found in this frame — continue scanning
                            }
                            imageProxy.close()
                        } else {
                            imageProxy.close()
                        }
                    }
                    try {
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageAnalysis)
                    } catch (_: Exception) {}
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            },
            modifier = Modifier.fillMaxSize(),
        )

        // Overlay
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Top bar
            Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Spacer(Modifier.width(36.dp))
                Text("Scan QR Code", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = androidx.compose.ui.graphics.Color.White)
                IconButton(onClick = onClose) {
                    Icon(Icons.Default.Close, contentDescription = "Close", tint = androidx.compose.ui.graphics.Color.White)
                }
            }

            Spacer(Modifier.weight(1f))

            // Viewfinder with gold border
            Box(
                modifier = Modifier
                    .size(260.dp)
                    .border(3.dp, RocColors.RocGold.copy(alpha = 0.8f), RoundedCornerShape(16.dp)),
            )

            Spacer(Modifier.height(24.dp))
            Text(
                "Point at the QR code on RocChat Web",
                fontSize = 14.sp,
                color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.7f),
            )
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun SettingToggle(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f), fontSize = 15.sp)
        Switch(checked = checked, onCheckedChange = onCheckedChange, colors = SwitchDefaults.colors(checkedTrackColor = RocColors.RocGold))
    }
}

// ── Helpers ──

// ── Link Preview ──

private val urlRegex = Regex("""https?://[^\s<>"{}|\\^`\[\]]+""")

private fun extractUrl(text: String): String? {
    return urlRegex.find(text)?.value
}

@Composable
private fun LinkPreviewCard(url: String) {
    var title by remember { mutableStateOf<String?>(null) }
    var description by remember { mutableStateOf<String?>(null) }
    var imageUrl by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }

    val context = LocalContext.current
    LaunchedEffect(url) {
        val mode = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
            .getString("link_preview_mode", "server") ?: "server"
        if (mode == "disabled") { loaded = true; return@LaunchedEffect }
        try {
            if (mode == "client") {
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 5000; conn.readTimeout = 5000
                conn.setRequestProperty("User-Agent", "RocChat/1.0")
                val html = conn.inputStream.bufferedReader().use { it.readText() }
                conn.disconnect()
                title = Regex("<title>([^<]+)</title>").find(html)?.groupValues?.get(1)
                description = Regex("""property="og:description"\s+content="([^"]+)"""").find(html)?.groupValues?.get(1)
                    ?: Regex("""content="([^"]+)"\s+property="og:description"""").find(html)?.groupValues?.get(1)
                imageUrl = Regex("""property="og:image"\s+content="([^"]+)"""").find(html)?.groupValues?.get(1)
                    ?: Regex("""content="([^"]+)"\s+property="og:image"""").find(html)?.groupValues?.get(1)
            } else {
                val encoded = java.net.URLEncoder.encode(url, "UTF-8")
                val json = APIClient.get("/link-preview?url=$encoded")
                title = json.optString("title", "").ifBlank { null }
                description = json.optString("description", "").ifBlank { null }
                imageUrl = json.optString("image", "").ifBlank { null }
            }
            loaded = true
        } catch (_: Exception) { loaded = true }
    }

    if (!loaded) {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        ) {
            Row(
                modifier = Modifier.padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                )
                Text(
                    "Loading preview…",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                )
            }
        }
    } else if (title != null || description != null) {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        ) {
            Column(modifier = Modifier.padding(8.dp)) {
                imageUrl?.let { img ->
                    SubcomposeAsyncImage(
                        model = ImageRequest.Builder(LocalContext.current).data(img).crossfade(true).build(),
                        contentDescription = null,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 140.dp).clip(RoundedCornerShape(6.dp)),
                        contentScale = ContentScale.Crop,
                    )
                    Spacer(Modifier.height(6.dp))
                }
                title?.let { Text(it, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                Text(url.take(40) + if (url.length > 40) "…" else "", style = MaterialTheme.typography.labelSmall, color = RocColors.Turquoise, maxLines = 1)
            }
        }
    }
}

// ── Message grouping + date separators ──

enum class GroupPosition { SOLO, FIRST, MIDDLE, LAST }

private sealed class MessageListItem {
    data class DateHeader(val label: String) : MessageListItem()
    data class Msg(
        val message: APIClient.ChatMessage,
        val groupPosition: GroupPosition,
        val showTimestamp: Boolean,
        val tightSpacing: Boolean,
    ) : MessageListItem()
}

private fun parseIsoDate(iso: String): Date? {
    val formats = listOf(
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US),
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US),
    )
    formats.forEach { it.timeZone = TimeZone.getTimeZone("UTC") }
    return formats.firstNotNullOfOrNull { try { it.parse(iso) } catch (_: Exception) { null } }
}

private fun buildMessageListItems(messages: List<APIClient.ChatMessage>, userId: String): List<MessageListItem> {
    if (messages.isEmpty()) return emptyList()
    val result = mutableListOf<MessageListItem>()
    val cal = Calendar.getInstance()
    val todayCal = Calendar.getInstance()
    val dayFmt = SimpleDateFormat("EEE, MMM d", Locale.getDefault())
    var lastDateLabel: String? = null

    for (i in messages.indices) {
        val msg = messages[i]
        val date = parseIsoDate(msg.createdAt)
        if (date != null) {
            cal.time = date
            val label = when {
                cal.get(Calendar.YEAR) == todayCal.get(Calendar.YEAR) &&
                    cal.get(Calendar.DAY_OF_YEAR) == todayCal.get(Calendar.DAY_OF_YEAR) -> "Today"
                cal.get(Calendar.YEAR) == todayCal.get(Calendar.YEAR) &&
                    cal.get(Calendar.DAY_OF_YEAR) == todayCal.get(Calendar.DAY_OF_YEAR) - 1 -> "Yesterday"
                else -> dayFmt.format(date)
            }
            if (label != lastDateLabel) {
                result.add(MessageListItem.DateHeader(label))
                lastDateLabel = label
            }
        }

        val prev = if (i > 0) messages[i - 1] else null
        val next = if (i < messages.size - 1) messages[i + 1] else null

        val prevDate = prev?.let { parseIsoDate(it.createdAt) }
        val curDate = date
        val nextDate = next?.let { parseIsoDate(it.createdAt) }

        val sameSenderAsPrev = prev != null && prev.senderId == msg.senderId &&
            prevDate != null && curDate != null && (curDate.time - prevDate.time) < 120_000
        val sameSenderAsNext = next != null && next.senderId == msg.senderId &&
            nextDate != null && curDate != null && (nextDate.time - curDate.time) < 120_000

        val groupPosition = when {
            sameSenderAsPrev && sameSenderAsNext -> GroupPosition.MIDDLE
            sameSenderAsPrev -> GroupPosition.LAST
            sameSenderAsNext -> GroupPosition.FIRST
            else -> GroupPosition.SOLO
        }

        val showTimestamp = groupPosition == GroupPosition.SOLO || groupPosition == GroupPosition.LAST
        val tightSpacing = sameSenderAsPrev

        result.add(MessageListItem.Msg(msg, groupPosition, showTimestamp, tightSpacing))
    }
    return result
}

// ── Animated typing indicator ──

@Composable
private fun BouncingDotsIndicator() {
    val transition = rememberInfiniteTransition(label = "typingDots")
    val offsets = (0..2).map { index ->
        transition.animateFloat(
            initialValue = 0f,
            targetValue = 0f,
            animationSpec = infiniteRepeatable(
                animation = keyframes {
                    durationMillis = 1200
                    0f at 0
                    -6f at 200 + index * 150
                    0f at 400 + index * 150
                    0f at 1200
                },
                repeatMode = RepeatMode.Restart,
            ),
            label = "dot$index",
        )
    }
    Row(
        modifier = Modifier
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                shape = RoundedCornerShape(12.dp),
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        offsets.forEach { anim ->
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .graphicsLayer { translationY = anim.value }
                    .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f), CircleShape),
            )
        }
    }
}

private fun formatRelativeTime(iso: String): String {
    return try {
        val formats = listOf(
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US),
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US),
        )
        formats.forEach { it.timeZone = TimeZone.getTimeZone("UTC") }
        val date = formats.firstNotNullOfOrNull { try { it.parse(iso) } catch (_: Exception) { null } } ?: return ""
        val diff = System.currentTimeMillis() - date.time
        when {
            diff < 60_000 -> "now"
            diff < 3_600_000 -> "${diff / 60_000}m"
            diff < 86_400_000 -> SimpleDateFormat("HH:mm", Locale.getDefault()).format(date)
            diff < 604_800_000 -> SimpleDateFormat("EEE", Locale.getDefault()).format(date)
            else -> SimpleDateFormat("MMM d", Locale.getDefault()).format(date)
        }
    } catch (_: Exception) { "" }
}

// ── Voice note recording ──

private fun compareByteArrays(a: ByteArray, b: ByteArray): Int {
    val n = minOf(a.size, b.size)
    for (i in 0 until n) {
        val ai = a[i].toInt() and 0xFF
        val bi = b[i].toInt() and 0xFF
        if (ai != bi) return ai - bi
    }
    return a.size - b.size
}

private var activeMediaRecorder: android.media.MediaRecorder? = null
private var voiceRecordingFile: java.io.File? = null
private var voiceRecordingStartTime: Long = 0

internal fun pollRecordingAmplitude(): Float {
    val r = activeMediaRecorder ?: return 0.1f
    return try {
        @Suppress("DEPRECATION")
        val raw = r.maxAmplitude // 0..32767
        (raw.coerceAtLeast(1).toFloat() / 8000f).coerceIn(0.08f, 1f)
    } catch (_: Exception) { 0.1f }
}

private fun startVoiceRecording(context: android.content.Context, onStarted: () -> Unit) {
    val file = java.io.File(context.cacheDir, "voice_note_${System.currentTimeMillis()}.m4a")
    voiceRecordingFile = file
    voiceRecordingStartTime = System.currentTimeMillis()
    try {
        @Suppress("DEPRECATION")
        val recorder = android.media.MediaRecorder().apply {
            setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
            setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(44100)
            setAudioEncodingBitRate(128000)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
        activeMediaRecorder = recorder
        onStarted()
    } catch (_: Exception) {}
}

internal fun cancelVoiceRecording() {
    val recorder = activeMediaRecorder
    try { recorder?.stop() } catch (_: Exception) {}
    try { recorder?.release() } catch (_: Exception) {}
    activeMediaRecorder = null
    voiceRecordingFile?.delete()
    voiceRecordingFile = null
}

/** Stops recording and returns (filePath, durationSeconds) for preview. */
internal fun finishVoiceRecordingToPreview(): Pair<String, Int>? {
    val recorder = activeMediaRecorder ?: return null
    val file = voiceRecordingFile ?: return null
    val duration = ((System.currentTimeMillis() - voiceRecordingStartTime) / 1000).toInt().coerceAtLeast(1)
    try { recorder.stop() } catch (_: Exception) {}
    try { recorder.release() } catch (_: Exception) {}
    activeMediaRecorder = null
    voiceRecordingFile = null
    if (!file.exists() || file.length() < 100) { file.delete(); return null }
    return file.absolutePath to duration
}

internal fun sendPreparedVoiceNote(
    context: android.content.Context,
    conversationId: String,
    recipientUserId: String,
    scope: kotlinx.coroutines.CoroutineScope,
    userId: String,
    filePath: String,
    duration: Int,
    onDone: (APIClient.ChatMessage) -> Unit,
) {
    scope.launch {
        try {
            val f = java.io.File(filePath)
            val plainBytes = f.readBytes()
            // Transcribe voice note (best-effort)
            val transcript = transcribeAudio(context, filePath)
            f.delete()
            if (plainBytes.size < 100) return@launch
            uploadAndSendMediaNote(context, conversationId, recipientUserId, userId, plainBytes,
                kind = "voice_note", filename = "voice_note.m4a", mime = "audio/mp4", duration = duration, transcript = transcript, onDone = onDone)
        } catch (_: Exception) {}
    }
}

internal fun sendVideoNote(
    context: android.content.Context,
    conversationId: String,
    recipientUserId: String,
    scope: kotlinx.coroutines.CoroutineScope,
    userId: String,
    file: java.io.File,
    duration: Int,
    onDone: (APIClient.ChatMessage) -> Unit,
) {
    scope.launch {
        try {
            val plainBytes = file.readBytes()
            file.delete()
            if (plainBytes.size < 100) return@launch
            uploadAndSendMediaNote(context, conversationId, recipientUserId, userId, plainBytes,
                kind = "video_note", filename = "video_note.mp4", mime = "video/mp4", duration = duration, onDone = onDone)
        } catch (_: Exception) {}
    }
}

private suspend fun uploadAndSendMediaNote(
    context: android.content.Context,
    conversationId: String,
    recipientUserId: String,
    userId: String,
    plainBytes: ByteArray,
    kind: String,
    filename: String,
    mime: String,
    duration: Int,
    transcript: String? = null,
    onDone: (APIClient.ChatMessage) -> Unit,
) {
    val detectedMime = if (mime == "application/octet-stream" || mime.isEmpty()) sniffMime(plainBytes, filename) else mime
    val fileKey = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
    val fileIv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val fileHash = digest.digest(plainBytes)

    val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
    val keySpec = javax.crypto.spec.SecretKeySpec(fileKey, "AES")
    val gcmSpec = javax.crypto.spec.GCMParameterSpec(128, fileIv)
    cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, keySpec, gcmSpec)
    val encrypted = cipher.doFinal(plainBytes)

    val encFilename = encryptProfileField(context, filename)
    val encMime = encryptProfileField(context, detectedMime)
    val mediaId = APIClient.uploadMedia(conversationId, encrypted, encFilename, encMime)

    val msg = org.json.JSONObject().apply {
        put("type", kind)
        put("blobId", mediaId)
        put("fileKey", android.util.Base64.encodeToString(fileKey, android.util.Base64.NO_WRAP))
        put("fileIv", android.util.Base64.encodeToString(fileIv, android.util.Base64.NO_WRAP))
        put("fileHash", android.util.Base64.encodeToString(fileHash, android.util.Base64.NO_WRAP))
        put("filename", filename)
        put("mime", detectedMime)
        put("size", plainBytes.size)
        put("duration", duration)
        if (!transcript.isNullOrEmpty()) put("transcript", transcript)
    }.toString()

    if (recipientUserId.isNotEmpty()) {
        val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, msg)
        APIClient.sendMessage(conversationId, envelope.ciphertext, envelope.iv, envelope.ratchetHeader, kind, 0)
    } else {
        val groupEnvelope = GroupSessionManager.getInstance(context).encrypt(conversationId, msg.toByteArray(), userId)
        APIClient.sendMessage(conversationId, groupEnvelope.ciphertext, "", groupEnvelope.ratchetHeader, kind, 0)
    }

    val label = if (kind == "voice_note") "🎙️ Voice note (${duration}s)" else "📹 Video message (${duration}s)"
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
        onDone(APIClient.ChatMessage(
            id = "local-${System.currentTimeMillis()}",
            conversationId = conversationId,
            senderId = userId,
            ciphertext = label,
            iv = "", ratchetHeader = "",
            messageType = kind,
            createdAt = java.util.Date().toString(),
        ))
    }
}

@Deprecated("Replaced by finishVoiceRecordingToPreview + sendPreparedVoiceNote")
private fun stopVoiceRecording(
    context: android.content.Context,
    conversationId: String,
    recipientUserId: String,
    scope: kotlinx.coroutines.CoroutineScope,
    userId: String,
    onDone: (APIClient.ChatMessage) -> Unit,
) {
    val (path, duration) = finishVoiceRecordingToPreview() ?: return
    sendPreparedVoiceNote(context, conversationId, recipientUserId, scope, userId, path, duration, onDone)
}

// MARK: - Offline Message Queue

private const val QUEUE_PREFS = "rocchat_message_queue"
private const val QUEUE_KEY = "queue"

private suspend fun transcribeAudio(context: android.content.Context, filePath: String): String? {
    return try {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
            kotlinx.coroutines.suspendCancellableCoroutine { cont ->
                val recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(context)
                val intent = android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra("android.speech.extra.AUDIO_SOURCE", android.net.Uri.fromFile(java.io.File(filePath)).toString())
                }
                recognizer.setRecognitionListener(object : android.speech.RecognitionListener {
                    override fun onResults(results: android.os.Bundle?) {
                        val matches = results?.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION)
                        recognizer.destroy()
                        if (cont.isActive) cont.resume(matches?.firstOrNull()) {}
                    }
                    override fun onError(error: Int) {
                        recognizer.destroy()
                        if (cont.isActive) cont.resume(null) {}
                    }
                    override fun onReadyForSpeech(params: android.os.Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onPartialResults(partialResults: android.os.Bundle?) {}
                    override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
                })
                recognizer.startListening(intent)
            }
        }
    } catch (_: Exception) { null }
}

private fun queueMessage(context: android.content.Context, localId: String, conversationId: String, text: String, recipientUserId: String) {
    val prefs = context.getSharedPreferences(QUEUE_PREFS, android.content.Context.MODE_PRIVATE)
    val arr = try { org.json.JSONArray(prefs.getString(QUEUE_KEY, "[]")) } catch (_: Exception) { org.json.JSONArray() }
    val item = org.json.JSONObject().apply {
        put("localId", localId)
        put("conversationId", conversationId)
        put("text", text)
        put("recipientUserId", recipientUserId)
    }
    arr.put(item)
    prefs.edit().putString(QUEUE_KEY, arr.toString()).apply()
}

private fun loadQueue(context: android.content.Context): List<org.json.JSONObject> {
    val prefs = context.getSharedPreferences(QUEUE_PREFS, android.content.Context.MODE_PRIVATE)
    val arr = try { org.json.JSONArray(prefs.getString(QUEUE_KEY, "[]")) } catch (_: Exception) { org.json.JSONArray() }
    return (0 until arr.length()).map { arr.getJSONObject(it) }
}

private fun saveQueue(context: android.content.Context, remaining: List<org.json.JSONObject>) {
    val prefs = context.getSharedPreferences(QUEUE_PREFS, android.content.Context.MODE_PRIVATE)
    val arr = org.json.JSONArray()
    remaining.forEach { arr.put(it) }
    prefs.edit().putString(QUEUE_KEY, arr.toString()).apply()
}

suspend fun flushMessageQueue(context: android.content.Context): Boolean {
    val queue = loadQueue(context)
    if (queue.isEmpty()) return true
    val remaining = mutableListOf<org.json.JSONObject>()
    for (item in queue) {
        val convId = item.optString("conversationId")
        val text = item.optString("text")
        val recipientId = item.optString("recipientUserId")
        try {
            if (recipientId.isNotEmpty()) {
                val envelope = SessionManager.encryptMessage(context, convId, recipientId, text)
                APIClient.sendMessage(convId, envelope.ciphertext, envelope.iv, envelope.ratchetHeader, "text", 0)
            } else {
                APIClient.sendMessage(convId, text, "", "", "text", 0)
            }
        } catch (_: Exception) {
            remaining.add(item)
            remaining.addAll(queue.drop(queue.indexOf(item) + 1))
            break
        }
    }
    saveQueue(context, remaining)
    return remaining.isEmpty()
}

// ── Roc Bird Status Sheet ──
@Composable
fun CanarySheet(onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("Loading...") }
    LaunchedEffect(Unit) {
        try {
            val json = com.rocchat.network.APIClient.get("/features/canary")
            text = json.optString("statement", "No Roc Bird status statement available.")
        } catch (_: Exception) {
            text = "Failed to load Roc Bird status."
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Roc Bird Status") },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

// ── Transparency Sheet ──
@Composable
fun TransparencySheet(onDismiss: () -> Unit) {
    var reports by remember { mutableStateOf<List<org.json.JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        try {
            val json = com.rocchat.network.APIClient.get("/features/transparency")
            val arr = json.optJSONArray("reports")
            if (arr != null) {
                reports = (0 until arr.length()).map { arr.getJSONObject(it) }
            }
        } catch (_: Exception) {}
        loading = false
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Transparency Reports") },
        text = {
            Column {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
                } else if (reports.isEmpty()) {
                    Text("No reports available.", color = RocColors.TextSecondary)
                } else {
                    reports.forEach { r ->
                        Text(r.optString("title", "Report"), fontWeight = FontWeight.Bold)
                        Text(r.optString("period", ""), fontSize = 12.sp, color = RocColors.TextSecondary)
                        Text(r.optString("summary", ""), fontSize = 14.sp)
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

// ── Supporters Sheet ──
@Composable
fun SupportersSheet(onDismiss: () -> Unit) {
    var supporters by remember { mutableStateOf<List<org.json.JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        try {
            val json = com.rocchat.network.APIClient.get("/features/supporters")
            val arr = json.optJSONArray("supporters")
            if (arr != null) {
                supporters = (0 until arr.length()).map { arr.getJSONObject(it) }
            }
        } catch (_: Exception) {}
        loading = false
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Supporters") },
        text = {
            Column {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
                } else if (supporters.isEmpty()) {
                    Text("No supporters listed yet.", color = RocColors.TextSecondary)
                } else {
                    supporters.forEach { s ->
                        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                            Text(s.optString("display_name", s.optString("username", "Anonymous")), modifier = Modifier.weight(1f))
                            val tier = s.optString("tier", "")
                            if (tier.isNotEmpty()) Text(tier, color = RocColors.RocGold, fontSize = 12.sp)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

// ── Key Transfer Functions ───────────────────────────────────────────

private fun pollForKeyTransferRequests(scope: kotlinx.coroutines.CoroutineScope, context: android.content.Context) {
    scope.launch(kotlinx.coroutines.Dispatchers.IO) {
        repeat(30) {
            kotlinx.coroutines.delay(2000)
            try {
                val res = APIClient.get("/devices/key-transfer/pending")
                val requests = res.optJSONArray("requests") ?: return@repeat
                if (requests.length() == 0) return@repeat
                val first = requests.getJSONObject(0)
                val requestId = first.getString("requestId")
                val remoteEphPub = first.getString("ephemeralPub")

                // Generate ephemeral X25519 key pair
                val kpg = java.security.KeyPairGenerator.getInstance("X25519")
                val myEphemeral = kpg.generateKeyPair()
                val myEphPubRaw = (myEphemeral.public as java.security.interfaces.XECPublicKey).let { pub ->
                    val u = pub.u
                    val bytes = u.toByteArray()
                    val result = ByteArray(32)
                    for (i in bytes.indices.reversed()) {
                        val ri = bytes.size - 1 - i
                        if (ri < 32) result[ri] = bytes[i]
                    }
                    result
                }
                val myEphPubB64 = android.util.Base64.encodeToString(myEphPubRaw, android.util.Base64.NO_WRAP)

                // ECDH with remote ephemeral
                val remotePubData = android.util.Base64.decode(remoteEphPub, android.util.Base64.NO_WRAP)
                val remoteKeySpec = java.security.spec.XECPublicKeySpec(
                    java.security.spec.NamedParameterSpec.X25519,
                    java.math.BigInteger(1, remotePubData.reversedArray())
                )
                val remotePubKey = java.security.KeyFactory.getInstance("X25519").generatePublic(remoteKeySpec)
                val ka = javax.crypto.KeyAgreement.getInstance("X25519")
                ka.init(myEphemeral.private)
                ka.doPhase(remotePubKey, true)
                val sharedSecret = ka.generateSecret()

                // HKDF → AES key
                val hkdfKey = run {
                    val mac = javax.crypto.Mac.getInstance("HmacSHA256")
                    mac.init(javax.crypto.spec.SecretKeySpec(ByteArray(32), "HmacSHA256"))
                    val prk = mac.doFinal(sharedSecret)
                    mac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
                    mac.update("rocchat-key-transfer".toByteArray())
                    mac.update(byteArrayOf(1))
                    mac.doFinal().copyOfRange(0, 32)
                }

                // Gather local keys
                val prefs = context.getSharedPreferences("rocchat", android.content.Context.MODE_PRIVATE)
                val keyBundle = org.json.JSONObject().apply {
                    put("identityPrivate", prefs.getString("identity_key_private", "") ?: "")
                    put("identityPublic", prefs.getString("identity_key_public", "") ?: "")
                }

                // Encrypt with AES-GCM
                val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
                val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(hkdfKey, "AES"), javax.crypto.spec.GCMParameterSpec(128, iv))
                val ct = cipher.doFinal(keyBundle.toString().toByteArray())
                val combined = iv + ct
                val encryptedBundle = android.util.Base64.encodeToString(combined, android.util.Base64.NO_WRAP)

                APIClient.post("/devices/key-transfer/bundle", org.json.JSONObject().apply {
                    put("requestId", requestId)
                    put("encryptedBundle", encryptedBundle)
                    put("ephemeralPub", myEphPubB64)
                })
                return@launch
            } catch (_: Exception) {}
        }
    }
}

private fun requestKeyTransferAsNewDevice(
    scope: kotlinx.coroutines.CoroutineScope,
    context: android.content.Context,
    onStatus: (String) -> Unit
) {
    scope.launch(kotlinx.coroutines.Dispatchers.IO) {
        try {
            val kpg = java.security.KeyPairGenerator.getInstance("X25519")
            val myEphemeral = kpg.generateKeyPair()
            val myEphPubRaw = (myEphemeral.public as java.security.interfaces.XECPublicKey).let { pub ->
                val u = pub.u
                val bytes = u.toByteArray()
                val result = ByteArray(32)
                for (i in bytes.indices.reversed()) {
                    val ri = bytes.size - 1 - i
                    if (ri < 32) result[ri] = bytes[i]
                }
                result
            }
            val myEphPubB64 = android.util.Base64.encodeToString(myEphPubRaw, android.util.Base64.NO_WRAP)

            val reqRes = APIClient.post("/devices/key-transfer/request", org.json.JSONObject().apply {
                put("ephemeralPub", myEphPubB64)
            })
            val requestId = reqRes.optString("requestId", "")
            if (requestId.isEmpty()) {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onStatus("Key transfer request failed") }
                return@launch
            }

            repeat(30) {
                kotlinx.coroutines.delay(2000)
                try {
                    val res = APIClient.get("/devices/key-transfer/bundle?requestId=$requestId")
                    if (res.optBoolean("ready", false)) {
                        val encryptedBundle = res.getString("encryptedBundle")
                        val remoteEphPub = res.getString("ephemeralPub")

                        val remotePubData = android.util.Base64.decode(remoteEphPub, android.util.Base64.NO_WRAP)
                        val remoteKeySpec = java.security.spec.XECPublicKeySpec(
                            java.security.spec.NamedParameterSpec.X25519,
                            java.math.BigInteger(1, remotePubData.reversedArray())
                        )
                        val remotePubKey = java.security.KeyFactory.getInstance("X25519").generatePublic(remoteKeySpec)
                        val ka = javax.crypto.KeyAgreement.getInstance("X25519")
                        ka.init(myEphemeral.private)
                        ka.doPhase(remotePubKey, true)
                        val sharedSecret = ka.generateSecret()

                        val hkdfKey = run {
                            val mac = javax.crypto.Mac.getInstance("HmacSHA256")
                            mac.init(javax.crypto.spec.SecretKeySpec(ByteArray(32), "HmacSHA256"))
                            val prk = mac.doFinal(sharedSecret)
                            mac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
                            mac.update("rocchat-key-transfer".toByteArray())
                            mac.update(byteArrayOf(1))
                            mac.doFinal().copyOfRange(0, 32)
                        }

                        val combinedBytes = android.util.Base64.decode(encryptedBundle, android.util.Base64.NO_WRAP)
                        val iv = combinedBytes.copyOfRange(0, 12)
                        val ct = combinedBytes.copyOfRange(12, combinedBytes.size)
                        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, javax.crypto.spec.SecretKeySpec(hkdfKey, "AES"), javax.crypto.spec.GCMParameterSpec(128, iv))
                        val pt = cipher.doFinal(ct)
                        val keyBundle = org.json.JSONObject(String(pt))

                        val prefs = context.getSharedPreferences("rocchat", android.content.Context.MODE_PRIVATE).edit()
                        keyBundle.optString("identityPrivate", "").takeIf { it.isNotEmpty() }?.let { prefs.putString("identity_key_private", it) }
                        keyBundle.optString("identityPublic", "").takeIf { it.isNotEmpty() }?.let { prefs.putString("identity_key_public", it) }
                        prefs.apply()

                        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onStatus("✓ Keys received — encryption ready") }
                        return@launch
                    }
                } catch (_: Exception) {}
            }
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onStatus("Key transfer timed out") }
        } catch (_: Exception) {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { onStatus("Key transfer failed") }
        }
    }
}

@Composable
private fun NumberPicker(value: Int, range: IntRange, onValueChange: (Int) -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        IconButton(onClick = { if (value < range.last) onValueChange(value + 1) else onValueChange(range.first) }) {
            Icon(Icons.Default.KeyboardArrowUp, contentDescription = "Increase")
        }
        Text(String.format("%02d", value), fontSize = 24.sp, fontWeight = FontWeight.Bold)
        IconButton(onClick = { if (value > range.first) onValueChange(value - 1) else onValueChange(range.last) }) {
            Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Decrease")
        }
    }
}
