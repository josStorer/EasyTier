package com.kkrainbow.easytier

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import com.plugin.vpnservice.BookmarkAutofill
import com.plugin.vpnservice.BookmarkWindows

// A separate Tauri activity/task for each bookmark; it never runs MainActivity's
// launcher auto-connect or the application's main Vue page.
class BookmarkActivity : TauriActivity() {
    override val handleBackNavigation = false
    private var bookmarkId: String? = null
    private var autofill: BookmarkAutofill? = null
    private var menu: AlertDialog? = null
    private val chinese get() = resources.configuration.locales[0].language == "zh"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (menu?.isShowing == true) return
                menu = AlertDialog.Builder(this@BookmarkActivity)
                    .setTitle(if (chinese) "返回主页" else "Return home")
                    .setItems(if (chinese) arrayOf("退出页面，回到主页", "保留页面，仅回到主页", "取消")
                        else arrayOf("Close page and return home", "Keep page and return home", "Cancel")) { _, choice ->
                        if (choice == 2) return@setItems
                        startActivity(Intent(this@BookmarkActivity, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                        if (choice == 0) finishAndRemoveTask()
                    }.create()
                menu?.show()
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        val item = BookmarkWindows.attach((webView as RustWebView).id, this)
        // A process-death restore cannot recover the live Tauri window. Go back
        // to the saved bookmark list instead of opening an unconfigured page.
        if (item == null) { finishAndRemoveTask(); return }
        bookmarkId = item.getString("id")
        title = item.getString("name")
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.javaScriptCanOpenWindowsAutomatically = false
        val status = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(40, 48, 60))
            setPadding(24, 12, 24, 12)
            setOnClickListener { visibility = android.view.View.GONE }
        }
        // Wry installs its content view after onWebViewCreate returns.
        webView.post {
            if (!isFinishing && !isDestroyed) {
                addContentView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            }
        }
        if (item.optString("selector").isBlank()) status.visibility = android.view.View.GONE
        autofill = BookmarkAutofill(this, webView, item) { state ->
            status.text = if (chinese) when (state) {
                "waiting" -> "正在查找验证码输入框（最多 8 秒）"
                "filled" -> "已填入当前验证码 · 点击收起"
                "timeout" -> "8 秒内未完成自动填入，请手动操作 · 点击收起"
                "invalid_selector" -> "DOM query 无效，请修改收藏配置"
                "invalid_input" -> "匹配元素不是可编辑输入框"
                "key_error" -> "无法读取或计算验证码，请检查 2FA 密钥"
                else -> "未填入：页面已跳转或输入框发生变化"
            } else when (state) {
                "waiting" -> "Finding OTP input (up to 8 seconds)"
                "filled" -> "Current code filled · Tap to dismiss"
                "timeout" -> "Autofill timed out after 8 seconds · Tap to dismiss"
                "invalid_selector" -> "Invalid DOM query; edit this bookmark"
                "invalid_input" -> "Matched element is not an editable input"
                "key_error" -> "Could not read or calculate OTP; check the key"
                else -> "Not filled: page or input changed"
            }
        }.also { it.start() }
    }

    override fun onDestroy() {
        autofill?.stop()
        menu?.dismiss()
        bookmarkId?.let { BookmarkWindows.detach(it, this) }
        super.onDestroy()
    }
}
