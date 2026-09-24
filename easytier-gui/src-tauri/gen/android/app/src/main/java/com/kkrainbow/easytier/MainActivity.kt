package com.kkrainbow.easytier

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) recordUserLaunch(intent)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
        initService()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        recordUserLaunch(intent)
    }

    private fun recordUserLaunch(intent: Intent?) {
        if (intent?.action == Intent.ACTION_MAIN && intent.hasCategory(Intent.CATEGORY_LAUNCHER)) {
            getSharedPreferences("easytier_launch", MODE_PRIVATE)
                .edit().putBoolean("pending", true).commit()
        }
    }

    private fun initService() {
        val serviceIntent = Intent(this, MainForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
    }
}
