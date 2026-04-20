package com.rocchat.chat

import com.rocchat.network.APIClient
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelsTab() {
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
                    ChannelCard(channel) {
                        scope.launch {
                            if (subscribeChannel(channel.id)) {
                                channels = channels.map {
                                    if (it.id == channel.id) it.copy(subscribed = true) else it
                                }
                            }
                        }
                    }
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
private fun ChannelCard(channel: ChannelData, onSubscribe: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
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
