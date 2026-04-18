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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
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
import com.rocchat.crypto.SessionManager
import com.rocchat.network.APIClient
import com.rocchat.network.NativeWebSocket
import com.rocchat.ui.RocColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
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
                    icon = { Icon(Icons.Default.Person, contentDescription = "Profile") },
                    label = { Text("Profile") },
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
                    onOpenConversation = { id, name, recipientId ->
                        openConversationId = id
                        openConversationName = name
                        openRecipientUserId = recipientId
                    },
                )
                1 -> CallsHistoryTab()
                2 -> SettingsTab(onLogout = onLogout)
            }
            // Call overlay on top of everything
            CallOverlay()        }
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

// ── Chats Tab: Conversation List ──

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ChatsTab(onOpenConversation: (String, String, String) -> Unit) {
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
        } catch (_: Exception) {}
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
                    Text("Start a new conversation to begin messaging securely.", color = RocColors.TextSecondary, fontSize = 14.sp)
                    Spacer(Modifier.height(12.dp))
                    Text("🔒 End-to-end encrypted", color = RocColors.Turquoise, fontSize = 12.sp)
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
                        try { conversations = APIClient.getConversations() } catch (_: Exception) {}
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
                                        Text("Encrypted message", color = RocColors.TextSecondary, fontSize = 14.sp, maxLines = 1)
                                    }
                                },
                                leadingContent = {
                                    AvatarImage(name = name, avatarUrl = other?.avatarUrl, size = 52)
                                },
                                trailingContent = {
                                    Column(horizontalAlignment = Alignment.End) {
                                        conv.lastMessageAt?.let {
                                            Text(formatRelativeTime(it), fontSize = 12.sp, color = RocColors.TextSecondary)
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
                                val convId = APIClient.createConversation("group", selectedUsers.map { it.userId }, groupName.trim())
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
    val haptics = LocalHapticFeedback.current

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
                        APIClient.sendMessage(conversationId, plaintext, "", "", "file")
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
                if (msg.ratchetHeader.isNotEmpty() && msg.iv.isNotEmpty()) {
                    val displayText = try {
                        SessionManager.decryptMessage(context, conversationId, msg.ciphertext, msg.iv, msg.ratchetHeader)
                    } catch (_: Exception) { msg.ciphertext }
                    msg.copy(ciphertext = displayText)
                } else msg
            }
        } catch (_: Exception) {}
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
        val token = APIClient.sessionToken ?: return@DisposableEffect onDispose {}
        // Connect directly to Worker backend — Pages proxy cannot handle WebSocket upgrades
        val wsUrl = "wss://rocchat-api.spoass.workers.dev/api/ws/$conversationId?userId=$userId&deviceId=android&token=$token"
        var reconnectAttempt = 0
        var reconnectJob: kotlinx.coroutines.Job? = null

        fun connectWs() {
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
                                val displayText = if (rh.isNotEmpty() && ivStr.isNotEmpty()) {
                                    try { SessionManager.decryptMessage(context, conversationId, ct, ivStr, rh) } catch (_: Exception) { ct }
                                } else ct
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
                                // Send delivery receipt back
                                if (newMsg.senderId != userId) {
                                    val receipt = JSONObject().apply {
                                        put("type", "delivery_receipt")
                                        put("payload", JSONObject().apply {
                                            put("message_id", newMsg.id)
                                            put("fromUserId", userId)
                                        })
                                    }
                                    ws?.send(receipt.toString())
                                }
                            }
                            "delivery_receipt", "read_receipt" -> {
                                val payload = data.getJSONObject("payload")
                                val msgId = payload.optString("message_id")
                                val newStatus = if (data.optString("type") == "read_receipt") "read" else "delivered"
                                messages = messages.map { if (it.id == msgId) it.copy(status = newStatus) else it }
                            }
                            "typing" -> {
                                val payload = data.getJSONObject("payload")
                                val fromUser = payload.optString("fromUserId")
                                if (fromUser != userId) {
                                    isRemoteTyping = true
                                    scope.launch {
                                        delay(4000)
                                        isRemoteTyping = false
                                    }
                                }
                            }
                            "presence" -> {
                                val payload = data.getJSONObject("payload")
                                val fromUser = payload.optString("fromUserId")
                                val status = payload.optString("status")
                                if (fromUser != userId) remoteOnlineStatus = status
                            }
                            "call_offer" -> {
                                val payload = data.getJSONObject("payload")
                                CallManager.handleIncomingOffer(payload, conversationId, ws)
                            }
                            "call_answer" -> CallManager.handleCallAnswer(data.getJSONObject("payload"))
                            "call_ice" -> CallManager.handleIceCandidate(data.getJSONObject("payload"))
                            "call_end" -> CallManager.handleCallEnd(data.getJSONObject("payload"))
                            "call_audio" -> CallManager.handleCallAudio(data.getJSONObject("payload"))
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

        connectWs()
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
            onDispose {}
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
                    IconButton(onClick = { showSafetyDialog = true }) {
                        Icon(Icons.Default.Security, contentDescription = "Safety Number", tint = RocColors.RocGold)
                    }
                    IconButton(onClick = { isSearching = !isSearching }) {
                        Icon(Icons.Default.Search, contentDescription = "Search messages", tint = RocColors.RocGold)
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
                items(messages.filter { msg ->
                    val ea = msg.expiresAt
                    val notExpired = ea == null || ea > (System.currentTimeMillis() / 1000)
                    if (searchText.isNotEmpty()) {
                        notExpired && msg.ciphertext.contains(searchText, ignoreCase = true)
                    } else notExpired
                }) { msg ->
                    val isMine = msg.senderId == userId
                    MessageBubble(
                        msg = msg,
                        isMine = isMine,
                        onReact = { emoji ->
                            scope.launch { try { APIClient.post("/messages/${msg.id}/react", JSONObject().put("encrypted_reaction", emoji)) } catch (_: Exception) {} }
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
                    )
                }
            }

            // Typing indicator
            if (isRemoteTyping) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("typing", fontSize = 12.sp, color = RocColors.TextSecondary)
                    Spacer(Modifier.width(4.dp))
                    Text("•••", fontSize = 12.sp, color = RocColors.TextSecondary)
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
                            fontSize = 10.sp,
                            color = RocColors.RocGold,
                        )
                        Text(
                            if (reply.ciphertext.isBlank()) "🔒 Encrypted" else reply.ciphertext,
                            fontSize = 12.sp,
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
                        }
                    }
                OutlinedTextField(
                    value = inputText,
                    onValueChange = { newVal ->
                        inputText = newVal
                        // Send typing indicator (throttled to 3s)
                        val now = System.currentTimeMillis()
                        if (now - lastTypingSent > 3000) {
                            lastTypingSent = now
                            ws?.send(JSONObject().apply {
                                put("type", "typing")
                                put("payload", JSONObject().apply {
                                    put("fromUserId", userId)
                                    put("isTyping", true)
                                })
                            }.toString())
                        }
                    },
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
                                val replyToId = replyingTo?.id
                                replyingTo = null
                                val localId = "queued-${System.currentTimeMillis()}"
                                scope.launch {
                                    // Edit mode
                                    val editId = editingMessageId
                                    if (editId != null) {
                                        editingMessageId = null
                                        try {
                                            APIClient.post("/messages/$editId", JSONObject().put("encrypted", text), method = "PATCH")
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
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    msg: APIClient.ChatMessage,
    isMine: Boolean,
    onReact: (String) -> Unit = {},
    onEdit: () -> Unit = {},
    onDelete: () -> Unit = {},
    onPin: () -> Unit = {},
    onReply: () -> Unit = {},
    onForward: () -> Unit = {},
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
        Surface(
            shape = RoundedCornerShape(
                topStart = 18.dp, topEnd = 18.dp,
                bottomStart = if (isMine) 18.dp else 4.dp,
                bottomEnd = if (isMine) 4.dp else 18.dp,
            ),
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
                            Icon(Icons.Default.Visibility, contentDescription = null, modifier = Modifier.size(16.dp), tint = RocColors.TextSecondary)
                            Spacer(Modifier.width(6.dp))
                            Text("Opened", fontSize = 14.sp, color = RocColors.TextSecondary)
                        }
                    } else {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.clickable {
                                val blobId = fileMsg?.optString("blobId") ?: return@clickable
                                val fKey = fileMsg.optString("fileKey", "")
                                val fIv = fileMsg.optString("fileIv", "")
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
                                Text("View once photo", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                Text("Tap to open", fontSize = 12.sp, color = RocColors.TextSecondary)
                            }
                        }
                    }
                } else {
                    Text(
                        text = msg.ciphertext.ifBlank { "🔒 Encrypted" },
                        fontSize = 15.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
                Row(
                    modifier = Modifier.align(Alignment.End).padding(top = 3.dp),
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
                        when (msg.status) {
                            "read" -> Text("✓✓", fontSize = 11.sp, color = RocColors.Turquoise)
                            "delivered" -> Text("✓✓", fontSize = 11.sp, color = RocColors.TextSecondary)
                            else -> Text("✓", fontSize = 11.sp, color = RocColors.TextSecondary)
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

@OptIn(ExperimentalMaterial3Api::class)
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
                    // Upload
                    val resp = APIClient.uploadAvatar(jpegBytes)
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
            displayName = me.optString("display_name", username)
            avatarUrl = me.optString("avatar_url", null)
            discoverable = me.optBoolean("discoverable", true)
            if (me.has("show_read_receipts")) readReceipts = me.optInt("show_read_receipts", 1) != 0
            if (me.has("show_typing_indicator")) typingIndicators = me.optInt("show_typing_indicator", 1) != 0
            if (me.has("show_online_to")) onlineVisibility = me.optString("show_online_to", "everyone")
            if (me.has("who_can_add")) whoCanAdd = me.optString("who_can_add", "everyone")
            ghostMode = !readReceipts && !typingIndicators && onlineVisibility == "nobody"
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

                Text(displayName, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text(
                    "@$username",
                    color = RocColors.TextSecondary,
                    fontSize = 14.sp,
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

        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

        // Quiet Hours
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
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("From: ", fontSize = 14.sp, color = RocColors.TextSecondary)
                Text(String.format("%02d:%02d", quietStartHour, quietStartMin), fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(24.dp))
                Text("To: ", fontSize = 14.sp, color = RocColors.TextSecondary)
                Text(String.format("%02d:%02d", quietEndHour, quietEndMin), fontWeight = FontWeight.SemiBold)
            }
            Text("Configure exact times in RocChat Web settings", modifier = Modifier.padding(horizontal = 16.dp), fontSize = 11.sp, color = RocColors.TextSecondary)
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
            f.delete()
            if (plainBytes.size < 100) return@launch
            uploadAndSendMediaNote(context, conversationId, recipientUserId, userId, plainBytes,
                kind = "voice_note", filename = "voice_note.m4a", mime = "audio/mp4", duration = duration, onDone = onDone)
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
    onDone: (APIClient.ChatMessage) -> Unit,
) {
    val fileKey = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
    val fileIv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val fileHash = digest.digest(plainBytes)

    val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
    val keySpec = javax.crypto.spec.SecretKeySpec(fileKey, "AES")
    val gcmSpec = javax.crypto.spec.GCMParameterSpec(128, fileIv)
    cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, keySpec, gcmSpec)
    val encrypted = cipher.doFinal(plainBytes)

    val mediaId = APIClient.uploadMedia(conversationId, encrypted, filename, mime)

    val msg = org.json.JSONObject().apply {
        put("type", kind)
        put("blobId", mediaId)
        put("fileKey", android.util.Base64.encodeToString(fileKey, android.util.Base64.NO_WRAP))
        put("fileIv", android.util.Base64.encodeToString(fileIv, android.util.Base64.NO_WRAP))
        put("fileHash", android.util.Base64.encodeToString(fileHash, android.util.Base64.NO_WRAP))
        put("filename", filename)
        put("mime", mime)
        put("size", plainBytes.size)
        put("duration", duration)
    }.toString()

    if (recipientUserId.isNotEmpty()) {
        val envelope = SessionManager.encryptMessage(context, conversationId, recipientUserId, msg)
        APIClient.sendMessage(conversationId, envelope.ciphertext, envelope.iv, envelope.ratchetHeader, kind, 0)
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
