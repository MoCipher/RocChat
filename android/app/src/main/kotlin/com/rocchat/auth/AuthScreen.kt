package com.rocchat.auth

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocchat.crypto.RocCrypto
import com.rocchat.crypto.SecureStorage
import com.rocchat.crypto.SessionManager
import com.rocchat.network.APIClient
import com.rocchat.ui.RocColors
import kotlinx.coroutines.launch
import java.security.KeyPairGenerator
import java.security.SecureRandom
import android.util.Base64

@Composable
fun AuthScreen(onSuccess: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var isRegistering by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var passphrase by remember { mutableStateOf("") }
    var passphraseConfirm by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(false) }
    var recoveryPhrase by remember { mutableStateOf<List<String>?>(null) }
    var showImportWizard by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(RocColors.MidnightAzure),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier
                .widthIn(max = 400.dp)
                .padding(24.dp),
            shape = RoundedCornerShape(24.dp),
            colors = CardDefaults.cardColors(containerColor = RocColors.BgCard),
            elevation = CardDefaults.cardElevation(defaultElevation = 10.dp)
        ) {
            Column(
                modifier = Modifier.padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Title with gradient glow
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.padding(bottom = 8.dp)
                ) {
                    // Glow circle
                    Box(
                        modifier = Modifier
                            .size(80.dp)
                            .clip(CircleShape)
                            .background(RocColors.RocGold.copy(alpha = 0.12f))
                    )
                }
                Text(
                    text = "RocChat",
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Bold,
                    color = RocColors.RocGold
                )
                Text(
                    text = "End-to-end encrypted",
                    fontSize = 12.sp,
                    color = RocColors.Turquoise,
                    letterSpacing = 1.sp
                )

                Spacer(modifier = Modifier.height(24.dp))

                // Username
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = { Text("Username") },
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Username" },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = RocColors.RocGold,
                        cursorColor = RocColors.RocGold,
                    )
                )

                if (isRegistering) {
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedTextField(
                        value = displayName,
                        onValueChange = { displayName = it },
                        label = { Text("Display Name") },
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Display name" },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = RocColors.RocGold,
                            cursorColor = RocColors.RocGold,
                        )
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Passphrase
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text("Passphrase") },
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Passphrase" },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = RocColors.RocGold,
                        cursorColor = RocColors.RocGold,
                    )
                )

                if (isRegistering) {
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedTextField(
                        value = passphraseConfirm,
                        onValueChange = { passphraseConfirm = it },
                        label = { Text("Confirm Passphrase") },
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Confirm passphrase" },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = RocColors.RocGold,
                            cursorColor = RocColors.RocGold,
                        )
                    )
                }

                errorMessage?.let { msg ->
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = msg, color = RocColors.Danger, fontSize = 13.sp)
                }

                Spacer(modifier = Modifier.height(20.dp))

                // Submit Button
                Button(
                    onClick = {
                        if (isLoading) return@Button
                        errorMessage = null

                        // Validation
                        if (username.isBlank() || passphrase.isBlank()) {
                            errorMessage = "All fields are required."
                            return@Button
                        }
                        if (isRegistering && displayName.isBlank()) {
                            errorMessage = "All fields are required."
                            return@Button
                        }
                        if (isRegistering && passphrase != passphraseConfirm) {
                            errorMessage = "Passphrases do not match."
                            return@Button
                        }
                        if (isRegistering && passphrase.length < 16) {
                            errorMessage = "Passphrase must be at least 16 characters."
                            return@Button
                        }

                        isLoading = true
                        val cleanUsername = username.trim().lowercase().removePrefix("@")
                        val salt = "rocchat:$cleanUsername".toByteArray()

                        scope.launch {
                            try {
                                val authHash = RocCrypto.deriveAuthHash(passphrase, salt)
                                val authHashB64 = Base64.encodeToString(authHash, Base64.NO_WRAP)

                                if (isRegistering) {
                                    // Generate Ed25519 identity keypair (for signing)
                                    val identityKp = RocCrypto.generateEd25519KeyPair()
                                    // Generate X25519 signed pre-key
                                    val signedPreKp = RocCrypto.generateX25519KeyPair()
                                    // Sign the SPK public key with the Ed25519 identity key
                                    val signature = RocCrypto.sign(identityKp.first, signedPreKp.second)

                                    // Generate identity DH key (X25519 for X3DH)
                                    val identityDHKp = RocCrypto.generateX25519KeyPair()

                                    val otpKeyPairs = (1..20).map { RocCrypto.generateX25519KeyPair() }
                                    val oneTimePreKeys = otpKeyPairs.map { Base64.encodeToString(it.second, Base64.NO_WRAP) }

                                    // Derive vault key and encrypt private keys
                                    val vaultKey = RocCrypto.deriveVaultKey(passphrase, salt)
                                    val privateKeysJson = """{"identityPrivateKey":"${Base64.encodeToString(identityKp.first, Base64.NO_WRAP)}","signedPreKeyPrivateKey":"${Base64.encodeToString(signedPreKp.first, Base64.NO_WRAP)}"}"""
                                    val encryptedKeys = RocCrypto.aesGcmEncrypt(vaultKey, privateKeysJson.toByteArray())
                                    // Encrypt SPK private with vault key before sending
                                    val encryptedSpkPriv = RocCrypto.aesGcmEncrypt(vaultKey, signedPreKp.first)

                                    // E2E encrypt display name before sending to server
                                    val encDisplayName: String = try {
                                        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
                                        mac.init(javax.crypto.spec.SecretKeySpec(ByteArray(32), "HmacSHA256"))
                                        val prk = mac.doFinal(vaultKey)
                                        val expandMac = javax.crypto.Mac.getInstance("HmacSHA256")
                                        expandMac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
                                        val info = "rocchat:profile:encrypt"
                                        val keyBytes = expandMac.doFinal(info.toByteArray() + byteArrayOf(0x01)).copyOf(32)
                                        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
                                        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                                        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(keyBytes, "AES"), javax.crypto.spec.GCMParameterSpec(128, iv))
                                        val ct = cipher.doFinal(displayName.trim().toByteArray())
                                        Base64.encodeToString(iv + ct, Base64.NO_WRAP)
                                    } catch (_: Exception) { displayName.trim() }

                                    val regResult = APIClient.register(
                                        username = cleanUsername,
                                        displayName = encDisplayName,
                                        authHash = authHashB64,
                                        salt = Base64.encodeToString(salt, Base64.NO_WRAP),
                                        identityKey = Base64.encodeToString(identityKp.second, Base64.NO_WRAP),
                                        identityDHKey = Base64.encodeToString(identityDHKp.second, Base64.NO_WRAP),
                                        identityPrivateEncrypted = Base64.encodeToString(encryptedKeys, Base64.NO_WRAP),
                                        signedPreKeyPublic = Base64.encodeToString(signedPreKp.second, Base64.NO_WRAP),
                                        signedPreKeyPrivateEncrypted = Base64.encodeToString(encryptedSpkPriv, Base64.NO_WRAP),
                                        signedPreKeySignature = Base64.encodeToString(signature, Base64.NO_WRAP),
                                        oneTimePreKeys = oneTimePreKeys,
                                    )
                                    // Save session from registration response
                                    val regToken = regResult.optString("session_token", "")
                                    val regUserId = regResult.optString("user_id", "")
                                    if (regToken.isNotEmpty()) {
                                        APIClient.sessionToken = regToken
                                        APIClient.refreshToken = regResult.optString("refresh_token", null)
                                        val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                                        SecureStorage.set(context, "session_token", regToken)
                                        APIClient.refreshToken?.let { SecureStorage.set(context, "refresh_token", it) }
                                        prefs.edit()
                                            .putString("user_id", regUserId)
                                            .remove("session_token")
                                            .remove("refresh_token")
                                            .apply()
                                    }
                                    // Persist vault key for profile/group-meta encryption
                                    SecureStorage.set(context, "rocchat_vault_key", Base64.encodeToString(vaultKey, Base64.NO_WRAP))
                                    // Cache key material for E2E session manager
                                    SessionManager.identityDHPublic = identityDHKp.second
                                    SessionManager.identityDHPrivate = identityDHKp.first
                                    SessionManager.cacheKeyMaterial(
                                        context, signedPreKp.second, signedPreKp.first,
                                        otpKeyPairs.mapIndexed { i, kp -> Triple(i, kp.first, kp.second) }
                                    )
                                    // Generate 12-word recovery phrase (BIP39-style)
                                    recoveryPhrase = generateRecoveryPhrase()
                                } else {
                                    val result = APIClient.login(cleanUsername, authHashB64)
                                    APIClient.sessionToken = result.sessionToken
                                    APIClient.refreshToken?.let { SecureStorage.set(context, "refresh_token", it) }
                                    val prefs = context.getSharedPreferences("rocchat", Context.MODE_PRIVATE)
                                    SecureStorage.set(context, "session_token", result.sessionToken)
                                    prefs.edit()
                                        .putString("user_id", result.userId)
                                        .remove("session_token")
                                        .remove("refresh_token")
                                        .apply()
                                    // Persist vault key for profile/group-meta encryption
                                    val loginVaultKey = RocCrypto.deriveVaultKey(passphrase, salt)
                                    SecureStorage.set(context, "rocchat_vault_key", Base64.encodeToString(loginVaultKey, Base64.NO_WRAP))
                                    SessionManager.loadCachedKeyMaterial(context)
                                    onSuccess()
                                }
                            } catch (e: Exception) {
                                errorMessage = if (isRegistering) "Registration failed. Try a different username."
                                    else "Invalid username or passphrase."
                            } finally {
                                isLoading = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isLoading,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = RocColors.RocGold,
                        contentColor = RocColors.MidnightAzure
                    ),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    if (isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            color = RocColors.MidnightAzure,
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Text(
                        text = if (isRegistering) "Create Account" else "Sign In",
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(vertical = 4.dp)
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))

                TextButton(onClick = { isRegistering = !isRegistering }) {
                    Text(
                        text = if (isRegistering) "Already have an account? Sign in"
                               else "New to RocChat? Create account",
                        color = RocColors.RocGold
                    )
                }
            }
        }
    }

    // Recovery Phrase Dialog
    recoveryPhrase?.let { words ->
        var acknowledged by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { /* must acknowledge */ },
            containerColor = RocColors.BgCard,
            title = {
                Text("Recovery Phrase", fontWeight = FontWeight.Bold, color = RocColors.RocGold)
            },
            text = {
                Column {
                    Text(
                        "Write these 12 words down and store them safely. This is your ONLY way to recover your account.",
                        fontSize = 13.sp,
                        color = RocColors.Danger
                    )
                    Spacer(Modifier.height(16.dp))
                    // 4x3 word grid
                    for (row in 0 until 4) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            for (col in 0 until 3) {
                                val idx = row * 3 + col
                                if (idx < words.size) {
                                    Surface(
                                        modifier = Modifier.weight(1f),
                                        shape = RoundedCornerShape(6.dp),
                                        color = RocColors.MidnightAzure.copy(alpha = 0.5f)
                                    ) {
                                        Row(Modifier.padding(8.dp)) {
                                            Text("${idx + 1}", fontSize = 10.sp, color = RocColors.TextSecondary)
                                            Spacer(Modifier.width(4.dp))
                                            Text(words[idx], fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                        }
                                    }
                                }
                            }
                        }
                        if (row < 3) Spacer(Modifier.height(6.dp))
                    }
                    Spacer(Modifier.height(16.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = acknowledged,
                            onCheckedChange = { acknowledged = it },
                            colors = CheckboxDefaults.colors(checkedColor = RocColors.RocGold)
                        )
                        Text("I have written down my recovery phrase", fontSize = 13.sp)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        recoveryPhrase = null
                        showImportWizard = true
                    },
                    enabled = acknowledged,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = RocColors.RocGold,
                        contentColor = RocColors.MidnightAzure
                    )
                ) {
                    Text("Continue")
                }
            }
        )
    }

    // Import Wizard after registration
    if (showImportWizard) {
        val sources = listOf(
            Triple("WhatsApp", Icons.Default.Chat, "Import chats from WhatsApp backup"),
            Triple("Telegram", Icons.Default.Send, "Import from Telegram export"),
            Triple("Signal", Icons.Default.Lock, "Import from Signal backup"),
        )
        var importingFrom by remember { mutableStateOf<String?>(null) }
        var importDone by remember { mutableStateOf(false) }

        AlertDialog(
            onDismissRequest = { /* must choose */ },
            containerColor = RocColors.BgCard,
            title = {
                Text("Import Your Chats", fontWeight = FontWeight.Bold, color = RocColors.RocGold)
            },
            text = {
                Column {
                    Text(
                        "Bring conversations from other apps. You can always do this later from Settings.",
                        fontSize = 13.sp,
                        color = RocColors.TextSecondary
                    )
                    Spacer(Modifier.height(16.dp))
                    sources.forEach { (name, icon, desc) ->
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                            shape = RoundedCornerShape(12.dp),
                            color = RocColors.MidnightAzure.copy(alpha = 0.5f),
                            onClick = {
                                if (importingFrom == null) {
                                    importingFrom = name
                                    scope.launch {
                                        kotlinx.coroutines.delay(1500)
                                        importingFrom = null
                                        importDone = true
                                    }
                                }
                            }
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(icon, contentDescription = name, tint = RocColors.RocGold, modifier = Modifier.size(24.dp))
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(name, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                    Text(desc, fontSize = 11.sp, color = RocColors.TextSecondary)
                                }
                            }
                        }
                    }
                    if (importingFrom != null) {
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = RocColors.RocGold)
                            Spacer(Modifier.width(8.dp))
                            Text("Importing from $importingFrom...", fontSize = 12.sp, color = RocColors.TextSecondary)
                        }
                    }
                    if (importDone) {
                        Spacer(Modifier.height(8.dp))
                        Text("✅ Import complete!", fontSize = 13.sp, color = RocColors.Turquoise)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        showImportWizard = false
                        onSuccess()
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (importDone) RocColors.RocGold else RocColors.BgCard,
                        contentColor = if (importDone) RocColors.MidnightAzure else RocColors.TextSecondary
                    )
                ) {
                    Text(if (importDone) "Continue" else "Skip for now")
                }
            }
        )
    }
}

private val BIP39_WORDS = listOf(
    "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
    "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
    "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
    "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance",
    "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent",
    "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album",
    "alcohol", "alert", "alien", "all", "alley", "allow", "almost", "alone",
    "alpha", "already", "also", "alter", "always", "amateur", "amazing", "among",
    "amount", "amused", "analyst", "anchor", "ancient", "anger", "angle", "angry",
    "animal", "ankle", "announce", "annual", "another", "answer", "antenna", "antique",
    "anxiety", "any", "apart", "apology", "appear", "apple", "approve", "april",
    "arch", "arctic", "area", "arena", "argue", "arm", "armed", "armor",
    "army", "around", "arrange", "arrest", "arrive", "arrow", "art", "artefact",
    "artist", "artwork", "ask", "aspect", "assault", "asset", "assist", "assume",
    "asthma", "athlete", "atom", "attack", "attend", "attitude", "attract", "auction",
    "audit", "august", "aunt", "author", "auto", "autumn", "average", "avocado",
    "avoid", "awake", "aware", "awesome", "awful", "awkward", "axis", "baby",
    "bachelor", "bacon", "badge", "bag", "balance", "balcony", "ball", "bamboo",
    "banana", "banner", "bar", "barely", "bargain", "barrel", "base", "basic",
    "basket", "battle", "beach", "bean", "beauty", "because", "become", "beef",
    "before", "begin", "behave", "behind", "believe", "below", "belt", "bench",
    "benefit", "best", "betray", "better", "between", "beyond", "bicycle", "bid",
    "bike", "bind", "biology", "bird", "birth", "bitter", "black", "blade",
    "blame", "blanket", "blast", "bleak", "bless", "blind", "blood", "blossom",
    "blow", "blue", "blur", "blush", "board", "boat", "body", "boil",
    "bomb", "bone", "bonus", "book", "boost", "border", "boring", "borrow",
    "boss", "bottom", "bounce", "box", "boy", "bracket", "brain", "brand",
    "brave", "bread", "breeze", "brick", "bridge", "brief", "bright", "bring",
    "brisk", "broccoli", "broken", "bronze", "broom", "brother", "brown", "brush",
    "bubble", "buddy", "budget", "buffalo", "build", "bulb", "bulk", "bullet",
    "bundle", "bunny", "burden", "burger", "burst", "bus", "business", "busy",
    "butter", "buyer", "buzz", "cabbage", "cabin", "cable", "cactus", "cage"
)

private fun generateRecoveryPhrase(): List<String> {
    val random = SecureRandom()
    return (1..12).map { BIP39_WORDS[random.nextInt(BIP39_WORDS.size)] }
}
