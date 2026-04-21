package com.rocchat.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

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
    // Material You: pull dynamic colors from the user's wallpaper on
    // Android 12+. Falls back to the brand-locked palette on older devices
    // and when explicitly disabled (e.g. accessibility / brand-strict mode).
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
