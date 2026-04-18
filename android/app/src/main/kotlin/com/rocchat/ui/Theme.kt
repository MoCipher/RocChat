package com.rocchat.ui

import androidx.compose.ui.graphics.Color

object RocColors {
    val RocGold       = Color(0xFFD4AF37)
    val RocGoldLight  = Color(0xFFE8CC6E)
    val RocGoldDark   = Color(0xFFA68B2A)
    val DesertSky     = Color(0xFF87CEEB)
    val AncientIvory  = Color(0xFFF5F5DC)
    val ShadowBronze  = Color(0xFF8B7355)
    val MidnightAzure = Color(0xFF0D1117)
    val Turquoise     = Color(0xFF40E0D0)
    val BubbleMine    = RocGold.copy(alpha = 0.12f)
    val BubbleTheirs  = Color(0xFFFEFCF6)
    val BgApp         = Color(0xFFF5F3ED)
    val BgCard        = Color(0xFFFEFCF6)
    val TextPrimary   = Color(0xFF1A1A2E)
    val TextSecondary = Color(0xFF5C5A6E)
    val Success       = Color(0xFF1EA672)
    val Danger        = Color(0xFFDC3545)

    // Dark theme
    val DarkBgApp     = Color(0xFF151210)
    val DarkBgCard    = Color(0xFF1C1814)
    val DarkText      = Color(0xFFE8E2D4)
    val DarkTextSec   = Color(0xFFA09888)
}

data class ChatTheme(
    val key: String,
    val label: String,
    val swatch: Color,
    val bgColor: Color,
    val bubbleMine: Color,
    val bubbleTheirs: Color,
)

val chatThemes = listOf(
    ChatTheme("default", "Default", Color.Transparent, Color.Transparent, RocColors.RocGold.copy(alpha = 0.12f), Color(0xFFFEFCF6)),
    ChatTheme("midnight-blue", "Midnight Blue", Color(0xFF0A1628), Color(0xFF0A1628), Color(0xFF1A365D).copy(alpha = 0.8f), Color(0xFF1E293B).copy(alpha = 0.9f)),
    ChatTheme("forest-green", "Forest Green", Color(0xFF0A1F0A), Color(0xFF0A1F0A), Color(0xFF14532D).copy(alpha = 0.8f), Color(0xFF1A2E1A).copy(alpha = 0.9f)),
    ChatTheme("sunset-amber", "Sunset Amber", Color(0xFF1A0F05), Color(0xFF1A0F05), Color(0xFF7C2D12).copy(alpha = 0.8f), Color(0xFF292018).copy(alpha = 0.9f)),
    ChatTheme("ocean-teal", "Ocean Teal", Color(0xFF042F2E), Color(0xFF042F2E), Color(0xFF134E4A).copy(alpha = 0.8f), Color(0xFF1A2F2E).copy(alpha = 0.9f)),
    ChatTheme("rose-gold", "Rose Gold", Color(0xFF1A0A10), Color(0xFF1A0A10), Color(0xFF831843).copy(alpha = 0.8f), Color(0xFF2A1520).copy(alpha = 0.9f)),
    ChatTheme("lavender", "Lavender", Color(0xFF0F0A1A), Color(0xFF0F0A1A), Color(0xFF4C1D95).copy(alpha = 0.8f), Color(0xFF1E1530).copy(alpha = 0.9f)),
    ChatTheme("charcoal", "Charcoal", Color(0xFF111111), Color(0xFF111111), Color(0xFF333333).copy(alpha = 0.9f), Color(0xFF222222).copy(alpha = 0.9f)),
)
