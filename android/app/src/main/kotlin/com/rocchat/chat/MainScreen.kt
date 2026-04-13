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
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.rocchat.calls.CallManager
import com.rocchat.calls.CallOverlay
import com.rocchat.calls.CallsHistoryTab
import com.rocchat.network.APIClient
import com.rocchat.network.NativeWebSocket
import com.rocchat.ui.RocColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

// ── Main Screen with 3 Tabs ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(onLogout: () -> Unit) {
    var selectedTab by remember { mutableIntStateOf(0) }
    // State for navigating into a conversation
    var openConversationId by remember { mutableStateOf<String?>(null) }
    var openConversationName by remember { mutableStateOf("") }

    if (openConversationId != null) {
        ConversationScreen(
            conversationId = openConversationId!!,
            conversationName = openConversationName,
            onBack = { openConversationId = null },
        )
        return
    }

    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    icon = { Icon(Icons.Default.Email, contentDescription = "Chats") },
                    label = { Text("Chats") },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = RocColors.RocGold,
                        selectedTextColor = RocColors.RocGold,
                        indicatorColor = RocColors.RocGold.copy(alpha = 0.12f),
                    ),
                )
                NavigationBarItem(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    icon = { Icon(Icons.Default.Phone, contentDescription = "Calls") },
                    label = { Text("Calls") },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = RocColors.RocGold,
                        selectedTextColor = RocColors.RocGold,
                        indicatorColor = RocColors.RocGold.copy(alpha = 0.12f),
                    ),
                )
                NavigationBarItem(
                    selected = selectedTab == 2,
                    onClick = { selectedTab = 2 },
                    icon = { Icon(Icons.Default.Settings, contentDescription = "Settings") },
                    label = { Text("Settings") },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = RocColors.RocGold,
                        selectedTextColor = RocColors.RocGold,
                        indicatorColor = RocColors.RocGold.copy(alpha = 0.12f),
                    ),
                )
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (selectedTab) {
                0 -> ChatsTab(
                    onOpenConversation = { id, name ->
                        openConversationId = id
                        openConversationName = name
                    },
                )
                1 -> CallsHistoryTab()
                2 -> SettingsTab(onLogout = onLogout)
            }
            // Call overlay on top of everything
            CallOverlay()        }
    }
}

// ── Chats Tab: Conversation List ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatsTab(onOpenConversation: (String, String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var conversations by remember { mutableStateOf<List<APIClient.Conversation>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var showNewChat by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<APIClient.UserSearchResult>>(emptyList()) }

    LaunchedEffect(Unit) {
        try {
            conversations = APIClient.getConversations()
        } catch (_: Exception) {}
        isLoading = false
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Chats", fontWeight = FontWeight.Bold) },
            actions = {
                IconButton(onClick = { showNewChat = true }) {
                    Icon(Icons.Default.Edit, contentDescription = "New chat", tint = RocColors.RocGold)
                }
            },
        )

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
                    Text("Start a new conversation to begin messaging securely.", color = RocColors.TextSecondary, fontSize = 14.sp)
                    Spacer(Modifier.height(12.dp))
                    Text("🔒 End-to-end encrypted", color = RocColors.Turquoise, fontSize = 12.sp)
                }
            }
        } else {
            val userId = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                .getString("user_id", "") ?: ""

            LazyColumn {
                items(conversations) { conv ->
                    val name = conv.name ?: conv.members
                        .filter { it.userId != userId }
                        .joinToString(", ") { it.displayName.ifBlank { it.username } }
                        .ifBlank { "Unknown" }
                    val initials = name.split(" ").map { it.firstOrNull() ?: ' ' }.joinToString("").take(2).uppercase()

                    ListItem(
                        headlineContent = { Text(name, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { Text("🔒 Encrypted message", color = RocColors.TextSecondary, fontSize = 13.sp, maxLines = 1) },
                        leadingContent = {
                            Box(
                                Modifier.size(48.dp).clip(CircleShape).background(RocColors.RocGold.copy(alpha = 0.15f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(initials, color = RocColors.RocGold, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                            }
                        },
                        trailingContent = {
                            conv.lastMessageAt?.let {
                                Text(formatRelativeTime(it), fontSize = 12.sp, color = RocColors.TextSecondary)
                            }
                        },
                        modifier = Modifier.clickable { onOpenConversation(conv.id, name) },
                    )
                    HorizontalDivider(modifier = Modifier.padding(start = 72.dp))
                }
            }
        }
    }

    // New Chat Dialog
    if (showNewChat) {
        AlertDialog(
            onDismissRequest = { showNewChat = false },
            title = { Text("New Conversation") },
            text = {
                Column {
                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { q ->
                            searchQuery = q
                            if (q.length >= 3) {
                                scope.launch {
                                    try {
                                        searchResults = APIClient.searchUsers(q.removePrefix("@"))
                                    } catch (_: Exception) {}
                                }
                            }
                        },
                        label = { Text("Search @username") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    searchResults.forEach { user ->
                        ListItem(
                            headlineContent = { Text(user.displayName) },
                            supportingContent = { Text("@${user.username}") },
                            modifier = Modifier.clickable {
                                scope.launch {
                                    try {
                                        val convId = APIClient.createConversation("direct", listOf(user.userId))
                                        onOpenConversation(convId, user.displayName)
                                        showNewChat = false
                                        searchQuery = ""
                                        searchResults = emptyList()
                                    } catch (_: Exception) {}
                                }
                            },
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showNewChat = false }) { Text("Cancel") }
            },
        )
    }
}

// ── Conversation Screen: Messages + Composer ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(conversationId: String, conversationName: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var messages by remember { mutableStateOf<List<APIClient.ChatMessage>>(emptyList()) }
    var inputText by remember { mutableStateOf("") }
    var isSending by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val userId = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
        .getString("user_id", "") ?: ""
    var ws by remember { mutableStateOf<NativeWebSocket?>(null) }
    var disappearTimer by remember { mutableIntStateOf(0) }
    var showDisappearMenu by remember { mutableStateOf(false) }

    // Load messages
    LaunchedEffect(conversationId) {
        try {
            messages = APIClient.getMessages(conversationId)
        } catch (_: Exception) {}
    }

    // Scroll to bottom when messages change
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    // WebSocket connection
    DisposableEffect(conversationId) {
        val token = APIClient.sessionToken ?: return@DisposableEffect onDispose {}
        val wsUrl = "wss://chat.mocipher.com/api/ws/$conversationId?userId=$userId&deviceId=android&token=$token"

        val listener = object : NativeWebSocket.Listener {
            override fun onMessage(ws: NativeWebSocket, text: String) {
                try {
                    val data = JSONObject(text)
                    when (data.optString("type")) {
                        "message" -> {
                            val payload = data.getJSONObject("payload")
                            val newMsg = APIClient.ChatMessage(
                                id = payload.optString("id", "ws-${System.currentTimeMillis()}"),
                                conversationId = conversationId,
                                senderId = payload.optString("fromUserId", payload.optString("sender_id", "")),
                                ciphertext = payload.optString("ciphertext", ""),
                                iv = payload.optString("iv", ""),
                                ratchetHeader = payload.optString("ratchet_header", ""),
                                messageType = payload.optString("message_type", "text"),
                                createdAt = payload.optString("created_at", Date().toString()),
                            )
                            messages = messages + newMsg
                        }
                        "call_offer" -> {
                            val payload = data.getJSONObject("payload")
                            CallManager.handleIncomingOffer(payload, conversationId, ws)
                        }
                    }
                } catch (_: Exception) {}
            }
        }

        ws = NativeWebSocket.connect(wsUrl, listener)
        onDispose {
            ws?.close(1000, "bye")
            ws = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(conversationName, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                        Text("🔒 End-to-end encrypted", fontSize = 11.sp, color = RocColors.Turquoise)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
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
                    IconButton(onClick = { showDisappearMenu = true }) {
                        Icon(
                            Icons.Default.Timer,
                            contentDescription = "Disappearing",
                            tint = if (disappearTimer > 0) RocColors.Turquoise else RocColors.RocGold,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding),
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
                Text("Messages are end-to-end encrypted", fontSize = 12.sp, color = RocColors.Turquoise)
            }

            // Messages
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                state = listState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(messages) { msg ->
                    val isMine = msg.senderId == userId
                    MessageBubble(msg, isMine)
                }
            }

            // Composer
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = inputText,
                    onValueChange = { inputText = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Type a message...") },
                    maxLines = 4,
                    shape = RoundedCornerShape(24.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(
                        onSend = {
                            if (inputText.isNotBlank() && !isSending) {
                                val text = inputText.trim()
                                inputText = ""
                                isSending = true
                                scope.launch {
                                    try {
                                        APIClient.sendMessage(conversationId, text, "", "", "text", disappearTimer)
                                        // Optimistic local add
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
                                        inputText = text
                                    }
                                    isSending = false
                                }
                            }
                        },
                    ),
                )
                Spacer(Modifier.width(8.dp))
                IconButton(
                    onClick = {
                        if (inputText.isNotBlank() && !isSending) {
                            val text = inputText.trim()
                            inputText = ""
                            isSending = true
                            scope.launch {
                                try {
                                    APIClient.sendMessage(conversationId, text, "", "", "text", disappearTimer)
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
                                    inputText = text
                                }
                                isSending = false
                            }
                        }
                    },
                    enabled = inputText.isNotBlank() && !isSending,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = if (inputText.isNotBlank()) RocColors.RocGold else RocColors.TextSecondary,
                    )
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
                                    showDisappearMenu = false
                                }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = disappearTimer == value,
                                onClick = {
                                    disappearTimer = value
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
}

@Composable
private fun MessageBubble(msg: APIClient.ChatMessage, isMine: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            shape = RoundedCornerShape(
                topStart = 16.dp, topEnd = 16.dp,
                bottomStart = if (isMine) 16.dp else 4.dp,
                bottomEnd = if (isMine) 4.dp else 16.dp,
            ),
            color = if (isMine) RocColors.RocGold.copy(alpha = 0.15f) else RocColors.BubbleTheirs,
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(
                    text = msg.ciphertext.ifBlank { "🔒 Encrypted" },
                    fontSize = 15.sp,
                    color = RocColors.TextPrimary,
                )
                Row(
                    modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("🔒", fontSize = 8.sp)
                    Spacer(Modifier.width(4.dp))
                    Text(
                        formatRelativeTime(msg.createdAt),
                        fontSize = 11.sp,
                        color = RocColors.TextSecondary,
                    )
                    if (isMine) {
                        Spacer(Modifier.width(4.dp))
                        Text("✓✓", fontSize = 11.sp, color = RocColors.Turquoise)
                    }
                }
            }
        }
    }
}

// ── Settings Tab ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsTab(onLogout: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var discoverable by remember { mutableStateOf(true) }
    var readReceipts by remember { mutableStateOf(true) }
    var typingIndicators by remember { mutableStateOf(true) }
    var username by remember { mutableStateOf("loading...") }
    var displayName by remember { mutableStateOf("Loading...") }
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

    LaunchedEffect(Unit) {
        try {
            val me = APIClient.getMe()
            username = me.optString("username", "unknown")
            displayName = me.optString("display_name", username)
            discoverable = me.optBoolean("discoverable", true)
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
        TopAppBar(title = { Text("Settings", fontWeight = FontWeight.Bold) })

        // Account
        ListItem(
            headlineContent = { Text(displayName, fontWeight = FontWeight.Medium) },
            supportingContent = { Text("@$username", color = RocColors.TextSecondary) },
            leadingContent = {
                Box(
                    Modifier.size(48.dp).clip(CircleShape).background(RocColors.RocGold.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center,
                ) {
                    val initials = displayName.split(" ").map { it.firstOrNull() ?: ' ' }.joinToString("").take(2).uppercase()
                    Text(initials, color = RocColors.RocGold, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
            },
        )
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
        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

        // Privacy header
        Text("Privacy", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = RocColors.RocGold)
        SettingToggle("Discoverable by username", discoverable) {
            discoverable = it
            scope.launch { try { APIClient.updateSettings(mapOf("discoverable" to if (it) 1 else 0)) } catch (_: Exception) {} }
        }
        SettingToggle("Read receipts", readReceipts) { readReceipts = it }
        SettingToggle("Typing indicators", typingIndicators) { typingIndicators = it }

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

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // About
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text("Version", modifier = Modifier.weight(1f))
            Text("0.1.0", color = RocColors.TextSecondary)
        }
        Row(modifier = Modifier.padding(horizontal = 16.dp)) {
            Text("Part of the ", fontSize = 13.sp, color = RocColors.TextSecondary)
            Text("Roc Family", fontSize = 13.sp, color = RocColors.RocGold, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(24.dp))

        Button(
            onClick = onLogout,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = RocColors.Danger),
            border = ButtonDefaults.outlinedButtonBorder(enabled = true),
        ) {
            Text("Sign Out")
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
                            val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
                            BarcodeScanning.getClient().process(inputImage)
                                .addOnSuccessListener { barcodes ->
                                    for (barcode in barcodes) {
                                        if (barcode.valueType == Barcode.TYPE_TEXT || barcode.valueType == Barcode.TYPE_URL) {
                                            val value = barcode.rawValue ?: continue
                                            if (value.startsWith("rocchat://") && !hasScanned) {
                                                hasScanned = true
                                                onScan(value)
                                                return@addOnSuccessListener
                                            }
                                        }
                                    }
                                }
                                .addOnCompleteListener { imageProxy.close() }
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
