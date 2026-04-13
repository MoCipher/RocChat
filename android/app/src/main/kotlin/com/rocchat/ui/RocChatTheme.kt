package com.rocchat.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable

private val LightColorScheme = lightColorScheme(
    primary = RocColors.RocGold,
    onPrimary = RocColors.MidnightAzure,
    secondary = RocColors.Turquoise,
    background = RocColors.BgApp,
    surface = RocColors.BgCard,
    onBackground = RocColors.TextPrimary,
    onSurface = RocColors.TextPrimary,
    error = RocColors.Danger,
)

private val DarkColorScheme = darkColorScheme(
    primary = RocColors.RocGold,
    onPrimary = RocColors.MidnightAzure,
    secondary = RocColors.Turquoise,
    background = RocColors.DarkBgApp,
    surface = RocColors.DarkBgCard,
    onBackground = RocColors.DarkText,
    onSurface = RocColors.DarkText,
    error = RocColors.Danger,
)

@Composable
fun RocChatTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
