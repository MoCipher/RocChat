package com.rocchat

import android.os.Build
import java.io.File

/**
 * Heuristic root detection.
 *
 * These checks are advisory only — a sophisticated attacker may bypass them.
 * The goal is to warn honest users running rooted devices about elevated risk,
 * not to provide a hard security gate.
 */
object RootDetectionHelper {

    data class RootCheckResult(val isRooted: Boolean, val reasons: List<String>)

    fun check(): RootCheckResult {
        val reasons = mutableListOf<String>()

        // 1. Known su binary locations
        val suPaths = listOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/system/su", "/system/bin/.ext/.su", "/system/usr/we-need-root/su-backup",
            "/data/local/xbin/su", "/data/local/bin/su", "/data/local/su",
            "/su/bin/su",
        )
        if (suPaths.any { File(it).exists() }) {
            reasons.add("su binary detected")
        }

        // 2. Build tags contain test-keys (AOSP debug/rooted build)
        val buildTags = Build.TAGS ?: ""
        if (buildTags.contains("test-keys")) {
            reasons.add("build signed with test-keys")
        }

        // 3. Writable /system partition
        try {
            val systemDir = File("/system")
            if (systemDir.canWrite()) reasons.add("/system is writable")
        } catch (_: Exception) { /* permission denied is fine */ }

        // 4. Known root management apps
        val rootPackages = listOf(
            "com.topjohnwu.magisk",
            "com.koushikdutta.superuser",
            "eu.chainfire.supersu",
            "com.noshufou.android.su",
            "com.thirdparty.superuser",
        )
        // We can't enumerate installed packages without PackageManager context here,
        // so this is left as a comment — call checkRootPackages(context) from Activity.

        return RootCheckResult(isRooted = reasons.isNotEmpty(), reasons = reasons)
    }
}
