package com.rocchat.chat

import com.rocchat.network.APIClient
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelsTab() {
    var selectedChannelId by remember { mutableStateOf<String?>(null) }
    var selectedChannelName by remember { mutableStateOf("") }

    if (selectedChannelId != null) {
        ChannelDetailScreen(
            channelId = selectedChannelId!!,
            channelName = selectedChannelName,
            onBack = { selectedChannelId = null }
        )
    } else {
        ChannelListScreen(
            onChannelClick = { id, name -> selectedChannelId = id; selectedChannelName = name }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelListScreen(onChannelClick: (String, String) -> Unit) {
    var channels by remember { mutableStateOf<List<ChannelData>>(emptyList()) }
    var communities by remember { mutableStateOf<List<CommunityData>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var searchQuery by remember { mutableStateOf("") }
    var showCreate by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        channels = fetchChannels()
        communities = fetchCommunities()
        isLoading = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Channels") },
                actions = {
                    IconButton(onClick = { showCreate = true }) {
                        Icon(Icons.Default.Add, "Create Channel")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Search channels...") },
                    singleLine = true,
                )
            }

            if (isLoading) {
                item {
                    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = RocColors.RocGold)
                    }
                }
            } else {
                item {
                    Text("Channels", style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                }

                val filtered = channels.filter {
                    searchQuery.isBlank() || it.name.contains(searchQuery, ignoreCase = true)
                }

                if (filtered.isEmpty()) {
                    item { Text("No channels found", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }

                items(filtered, key = { it.id }) { channel ->
                    ChannelCard(channel,
                        onClick = { onChannelClick(channel.id, channel.name) },
                        onSubscribe = {
                            scope.launch {
                                if (subscribeChannel(channel.id)) {
                                    channels = channels.map {
                                        if (it.id == channel.id) it.copy(subscribed = true) else it
                                    }
                                }
                            }
                        }
                    )
                }

                item {
                    Text("Communities", style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
                }

                if (communities.isEmpty()) {
                    item { Text("No communities yet", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }

                items(communities, key = { it.id }) { community ->
                    CommunityCard(community) {
                        scope.launch {
                            if (joinCommunity(community.id)) {
                                communities = communities.map {
                                    if (it.id == community.id) it.copy(joined = true) else it
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreate) {
        CreateChannelDialog(
            onDismiss = { showCreate = false },
            onCreate = { name, desc, tags, isPublic ->
                scope.launch {
                    createChannel(name, desc, tags, isPublic)
                    channels = fetchChannels()
                    showCreate = false
                }
            }
        )
    }
}

@Composable
private fun ChannelCard(channel: ChannelData, onClick: () -> Unit, onSubscribe: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().clickable { onClick() }) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Campaign, null, tint = RocColors.RocGold,
                modifier = Modifier.size(32.dp))
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(channel.name, style = MaterialTheme.typography.titleSmall)
                channel.description?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                Text("${channel.subscriberCount} subscribers",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (channel.subscribed) {
                Icon(Icons.Default.CheckCircle, "Subscribed", tint = MaterialTheme.colorScheme.primary)
            } else {
                FilledTonalButton(onClick = onSubscribe) { Text("Join") }
            }
        }
    }
}

@Composable
private fun CommunityCard(community: CommunityData, onJoin: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Groups, null, tint = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.size(32.dp))
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(community.name, style = MaterialTheme.typography.titleSmall)
                community.description?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                Text("${community.memberCount} members",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (community.joined) {
                Icon(Icons.Default.CheckCircle, "Joined", tint = MaterialTheme.colorScheme.primary)
            } else {
                FilledTonalButton(onClick = onJoin) { Text("Join") }
            }
        }
    }
}

@Composable
private fun CreateChannelDialog(onDismiss: () -> Unit, onCreate: (String, String, String, Boolean) -> Unit) {
    var name by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var tags by remember { mutableStateOf("") }
    var isPublic by remember { mutableStateOf(true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Create Channel") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(value = desc, onValueChange = { desc = it }, label = { Text("Description") }, singleLine = true)
                OutlinedTextField(value = tags, onValueChange = { tags = it }, label = { Text("Tags (comma sep)") }, singleLine = true)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = isPublic, onCheckedChange = { isPublic = it })
                    Text("Public")
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(name, desc, tags, isPublic) }, enabled = name.length >= 2) { Text("Create") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

// Data classes
data class ChannelData(
    val id: String, val name: String, val description: String?,
    val subscriberCount: Int, val tags: String?, val subscribed: Boolean = false,
)

data class CommunityData(
    val id: String, val name: String, val description: String?,
    val memberCount: Int, val joined: Boolean = false,
)

// Channel Detail Screen
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelDetailScreen(channelId: String, channelName: String, onBack: () -> Unit) {
    var isAdmin by remember { mutableStateOf(false) }
    var isSubscribed by remember { mutableStateOf(false) }
    var subscriberCount by remember { mutableStateOf(0) }
    var pinnedPostId by remember { mutableStateOf<String?>(null) }
    var showPostDialog by remember { mutableStateOf(false) }
    var showScheduleDialog by remember { mutableStateOf(false) }
    var showAnalytics by remember { mutableStateOf(false) }
    var showScheduledList by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val df = remember { SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()) }

    fun loadChannel() {
        scope.launch {
            val json = apiGetJson("/api/channels/$channelId")
            val ch = json?.optJSONObject("channel") ?: return@launch
            val role = ch.optString("my_role", "")
            isAdmin = role == "owner" || role == "admin"
            isSubscribed = role.isNotEmpty()
            subscriberCount = ch.optInt("subscriber_count", 0)
            pinnedPostId = ch.optString("pinned_post_id", "").ifEmpty { null }
        }
    }

    LaunchedEffect(channelId) { loadChannel() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(channelName) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Header
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Campaign, null, tint = RocColors.RocGold, modifier = Modifier.size(40.dp))
                            Spacer(Modifier.width(12.dp))
                            Column {
                                Text(channelName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                                Text("$subscriberCount subscribers", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                        if (isSubscribed) {
                            OutlinedButton(onClick = {
                                scope.launch { apiDelete("/api/channels/$channelId/subscribe"); loadChannel() }
                            }, modifier = Modifier.fillMaxWidth()) { Text("Unsubscribe") }
                        } else {
                            Button(onClick = {
                                scope.launch { apiPost("/api/channels/$channelId/subscribe"); loadChannel() }
                            }, modifier = Modifier.fillMaxWidth()) { Text("Subscribe") }
                        }
                    }
                }
            }

            // Pinned
            if (pinnedPostId != null) {
                item {
                    Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = RocColors.RocGold.copy(alpha = 0.08f))) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.PushPin, null, tint = RocColors.RocGold)
                            Spacer(Modifier.width(8.dp))
                            Text("Pinned: ${pinnedPostId!!.take(8)}...", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                            if (isAdmin) {
                                TextButton(onClick = {
                                    scope.launch { apiDelete("/api/channels/$channelId/pin"); loadChannel() }
                                }) { Text("Unpin", color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
            }

            // Admin actions
            if (isAdmin) {
                item {
                    Text("Admin", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                }
                item {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilledTonalButton(onClick = { showPostDialog = true }, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Default.Edit, null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Post", style = MaterialTheme.typography.labelMedium)
                        }
                        FilledTonalButton(onClick = { showScheduleDialog = true }, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Default.Schedule, null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Schedule", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
                item {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { showScheduledList = true }, modifier = Modifier.weight(1f)) {
                            Text("Scheduled", style = MaterialTheme.typography.labelMedium)
                        }
                        OutlinedButton(onClick = { showAnalytics = true }, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Default.BarChart, null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Analytics", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
    }

    // Post dialog
    if (showPostDialog || showScheduleDialog) {
        val isScheduled = showScheduleDialog
        var content by remember { mutableStateOf("") }

        AlertDialog(
            onDismissRequest = { showPostDialog = false; showScheduleDialog = false },
            title = { Text(if (isScheduled) "Schedule Post" else "New Post") },
            text = {
                Column {
                    OutlinedTextField(value = content, onValueChange = { content = it },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp),
                        label = { Text("Message") })
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        val ct = android.util.Base64.encodeToString(content.toByteArray(), android.util.Base64.NO_WRAP)
                        if (isScheduled) {
                            val schedAt = (System.currentTimeMillis() / 1000) + 3600
                            val body = JSONObject().apply { put("ciphertext", ct); put("iv", ""); put("scheduled_at", schedAt) }
                            apiPostBody("/api/channels/$channelId/schedule", body.toString())
                        } else {
                            val body = JSONObject().apply { put("ciphertext", ct); put("iv", ""); put("ratchet_header", "{}"); put("message_type", "text") }
                            apiPostBody("/api/channels/$channelId/post", body.toString())
                        }
                        showPostDialog = false; showScheduleDialog = false
                    }
                }, enabled = content.isNotBlank()) { Text(if (isScheduled) "Schedule" else "Post") }
            },
            dismissButton = { TextButton(onClick = { showPostDialog = false; showScheduleDialog = false }) { Text("Cancel") } }
        )
    }

    // Analytics dialog
    if (showAnalytics) {
        var stats by remember { mutableStateOf<JSONObject?>(null) }
        LaunchedEffect(Unit) { stats = apiGetJson("/api/channels/$channelId/analytics") }

        AlertDialog(
            onDismissRequest = { showAnalytics = false },
            title = { Text("Analytics") },
            text = {
                if (stats == null) {
                    CircularProgressIndicator()
                } else {
                    val sc = stats!!.optInt("subscriber_count", 0)
                    val posts = stats!!.optJSONArray("posts")
                    val count = posts?.length() ?: 0
                    Column {
                        Text("Subscribers: $sc", fontWeight = FontWeight.Bold)
                        Text("Posts: $count")
                        if (count > 0) {
                            var totalReads = 0
                            for (i in 0 until count) {
                                totalReads += posts!!.getJSONObject(i).optInt("read_count", 0)
                            }
                            Text("Avg reads/post: ${if (count > 0) totalReads / count else 0}")
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showAnalytics = false }) { Text("Done") } }
        )
    }

    // Scheduled list dialog
    if (showScheduledList) {
        var scheduledPosts by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
        LaunchedEffect(Unit) {
            val json = apiGetJson("/api/channels/$channelId/scheduled")
            val arr = json?.optJSONArray("posts")
            scheduledPosts = if (arr != null) (0 until arr.length()).map { arr.getJSONObject(it) } else emptyList()
        }

        AlertDialog(
            onDismissRequest = { showScheduledList = false },
            title = { Text("Scheduled Posts") },
            text = {
                if (scheduledPosts.isEmpty()) {
                    Text("No scheduled posts")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        scheduledPosts.forEach { p ->
                            val ts = p.optLong("scheduled_at", 0)
                            val id = p.optString("id", "")
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(df.format(Date(ts * 1000)), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                                IconButton(onClick = {
                                    scope.launch {
                                        apiDelete("/api/channels/$channelId/scheduled/$id")
                                        scheduledPosts = scheduledPosts.filter { it.optString("id") != id }
                                    }
                                }) { Icon(Icons.Default.Delete, "Cancel", tint = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showScheduledList = false }) { Text("Done") } }
        )
    }
}

// Network helpers
private suspend fun fetchChannels(query: String = ""): List<ChannelData> = try {
    val path = if (query.isNotBlank()) "/api/channels/discover?q=$query" else "/api/channels/discover"
    val json = apiGetJson(path)
    val arr = json?.optJSONArray("channels") ?: return emptyList()
    (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        ChannelData(o.getString("id"), o.getString("name"), o.optString("description", null),
            o.optInt("subscriber_count", 0), o.optString("tags", null))
    }
} catch (_: Exception) { emptyList() }

private suspend fun fetchCommunities(): List<CommunityData> = try {
    val json = apiGetJson("/api/communities/discover")
    val arr = json?.optJSONArray("communities") ?: return emptyList()
    (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        CommunityData(o.getString("id"), o.getString("name"), o.optString("description", null),
            o.optInt("member_count", 0))
    }
} catch (_: Exception) { emptyList() }

private suspend fun subscribeChannel(id: String): Boolean = apiPost("/api/channels/$id/subscribe")
private suspend fun joinCommunity(id: String): Boolean = apiPost("/api/communities/$id/join")

private suspend fun createChannel(name: String, desc: String, tags: String, isPublic: Boolean): Boolean {
    val body = JSONObject().apply {
        put("name", name); put("description", desc); put("tags", tags); put("is_public", isPublic)
    }
    return apiPostBody("/api/channels", body.toString())
}

private const val BASE = "https://rocchat-api.spoass.workers.dev"

private fun apiGetJson(path: String): JSONObject? {
    val token = APIClient.sessionToken ?: return null
    val conn = URL("$BASE$path").openConnection() as HttpsURLConnection
    conn.setRequestProperty("Authorization", "Bearer $token")
    return if (conn.responseCode == 200) JSONObject(conn.inputStream.bufferedReader().readText()) else null
}

private fun apiPost(path: String): Boolean {
    val token = APIClient.sessionToken ?: return false
    val conn = URL("$BASE$path").openConnection() as HttpsURLConnection
    conn.requestMethod = "POST"
    conn.setRequestProperty("Authorization", "Bearer $token")
    return conn.responseCode == 200
}

private fun apiDelete(path: String): Boolean {
    val token = APIClient.sessionToken ?: return false
    val conn = URL("$BASE$path").openConnection() as HttpsURLConnection
    conn.requestMethod = "DELETE"
    conn.setRequestProperty("Authorization", "Bearer $token")
    return conn.responseCode == 200
}

private fun apiPostBody(path: String, body: String): Boolean {
    val token = APIClient.sessionToken ?: return false
    val conn = URL("$BASE$path").openConnection() as HttpsURLConnection
    conn.requestMethod = "POST"
    conn.setRequestProperty("Authorization", "Bearer $token")
    conn.setRequestProperty("Content-Type", "application/json")
    conn.doOutput = true
    conn.outputStream.write(body.toByteArray())
    return conn.responseCode == 200
}
