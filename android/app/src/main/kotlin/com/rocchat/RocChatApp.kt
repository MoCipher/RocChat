package com.rocchat

import android.app.Application
import com.rocchat.push.PushManager

/**
 * Android [Application] subclass.
 *
 * We use this as the single well-known entry point for process-scoped setup
 * that must run before any activity, service, or content provider:
 *
 * - Create the notification channel ahead of the first push so that the
 *   distinctive vibration pattern / light colour are applied even when a
 *   notification arrives while the app is cold-starting.
 *
 * Registered in `AndroidManifest.xml` via `android:name=".RocChatApp"`.
 */
class RocChatApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Safe to call repeatedly — NotificationManager silently replaces
        // channels that already exist with the same id.
        PushManager.createNotificationChannel(this)
    }
}
