package com.rocchat.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

enum class AppThemePreference { SYSTEM, LIGHT, DARK }

private val LightColorScheme = lightColorScheme(
    primary = RocColors.RocGold,
    onPrimary = RocColors.MidnightAzure,
    secondary = RocColors.Turquoise,
    background = RocColors.BgApp,
    surface = RocColors.BgCard,
    onBackground = RocColors.TextPrimary,
    onSurface = RocColors.TextPrimary,
    onSurfaceVariant = RocColors.TextSecondary,
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
    onSurfaceVariant = RocColors.DarkTextSec,
    error = RocColors.Danger,
)

private val RocTypography = Typography(
    headlineLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 28.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 24.sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 22.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp),
    bodyLarge = TextStyle(fontSize = 15.sp),
    bodyMedium = TextStyle(fontSize = 14.sp),
    bodySmall = TextStyle(fontSize = 12.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp),
    labelSmall = TextStyle(fontSize = 11.sp),
)

@Composable
fun RocChatTheme(
    appTheme: AppThemePreference = AppThemePreference.SYSTEM,
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    fontScale: Float = 1f,
    content: @Composable () -> Unit
) {
    val resolvedDarkTheme = when (appTheme) {
        AppThemePreference.SYSTEM -> darkTheme
        AppThemePreference.DARK -> true
        AppThemePreference.LIGHT -> false
    }
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (resolvedDarkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        resolvedDarkTheme -> DarkColorScheme
        else -> LightColorScheme
    }
    val scaledTypography = remember(fontScale) {
        RocTypography.run {
            copy(
                headlineLarge = headlineLarge.copy(fontSize = (28f * fontScale).sp),
                headlineMedium = headlineMedium.copy(fontSize = (24f * fontScale).sp),
                headlineSmall = headlineSmall.copy(fontSize = (20f * fontScale).sp),
                titleLarge = titleLarge.copy(fontSize = (22f * fontScale).sp),
                titleMedium = titleMedium.copy(fontSize = (17f * fontScale).sp),
                titleSmall = titleSmall.copy(fontSize = (15f * fontScale).sp),
                bodyLarge = bodyLarge.copy(fontSize = (15f * fontScale).sp),
                bodyMedium = bodyMedium.copy(fontSize = (14f * fontScale).sp),
                bodySmall = bodySmall.copy(fontSize = (12f * fontScale).sp),
                labelLarge = labelLarge.copy(fontSize = (14f * fontScale).sp),
                labelMedium = labelMedium.copy(fontSize = (12f * fontScale).sp),
                labelSmall = labelSmall.copy(fontSize = (11f * fontScale).sp),
            )
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = scaledTypography,
        content = content
    )
}
