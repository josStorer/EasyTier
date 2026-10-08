package com.plugin.vpnservice

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.net.URI
import org.json.JSONObject
import org.json.JSONTokener

object BookmarkWindows {
    private val pages = mutableMapOf<String, WeakReference<Activity>>()
    private val pending = mutableMapOf<String, JSONObject>()

    fun isOpen(id: String): Boolean = synchronized(this) {
        pages[id]?.get()?.let { !it.isFinishing && !it.isDestroyed } == true
    }

    fun resume(id: String): Boolean {
        val page = synchronized(this) { pages[id]?.get() } ?: return false
        if (page.isFinishing || page.isDestroyed) return false
        val task = page.getSystemService(ActivityManager::class.java).appTasks
            .firstOrNull { it.taskInfo.id == page.taskId } ?: return false
        task.moveToFront()
        return true
    }

    fun prepare(label: String, item: JSONObject) = synchronized(this) {
        require(pending.size < 50) { "Too many pending pages" }
        pending[label] = JSONObject(item.toString()).apply { remove("secret") }
    }

    fun cancel(label: String) = synchronized(this) { pending.remove(label); Unit }

    fun attach(label: String, activity: Activity): JSONObject? = synchronized(this) {
        pending.remove(label)?.also { pages[it.getString("id")] = WeakReference(activity) }
    }

    fun detach(id: String, activity: Activity) = synchronized(this) {
        if (pages[id]?.get() === activity) pages.remove(id)
    }
}

class BookmarkAutofill(
    private val activity: Activity,
    private val webView: WebView,
    private val item: JSONObject,
    private val report: (String) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val deadline = SystemClock.elapsedRealtime() + 8000
    private var finished = false
    private val script = activity.assets.open("bookmark_dom.js").bufferedReader().use { it.readText() }
    private val origin = origin(item.getString("url"))
    private val probe = JSONObject().put("origin", origin).put("selector", item.optString("selector"))
    private val timeout = Runnable { finish("timeout") }

    fun start() {
        if (item.optString("selector").isBlank()) return
        report("waiting")
        handler.postDelayed(timeout, 8000)
        poll()
    }

    fun stop() { finished = true; handler.removeCallbacksAndMessages(null) }

    private fun finish(reason: String) {
        if (finished) return
        stop()
        report(reason)
    }

    private fun evaluate(config: JSONObject, callback: (String) -> Unit) {
        webView.evaluateJavascript(script.replace("__BOOKMARK_CONFIG__", config.toString())) { result ->
            if (!finished) callback(runCatching { JSONTokener(result).nextValue() as? String }.getOrNull() ?: "waiting")
        }
    }

    private fun poll() {
        if (finished) return
        if (SystemClock.elapsedRealtime() >= deadline) { finish("timeout"); return }
        evaluate(probe) { state ->
            when (state) {
                "ready" -> {
                    if (SystemClock.elapsedRealtime() >= deadline) { finish("timeout"); return@evaluate }
                    // Check the native top-level URL as well as the JS origin.
                    if (origin(webView.url.orEmpty()) != origin) { finish("wrong_origin"); return@evaluate }
                    try {
                        val secret = BookmarkStore(activity).get(item.getString("id")).getString("secret")
                        val fill = JSONObject(probe.toString()).put("code", BookmarkTotp.code(secret))
                            .put("autoEnter", item.optBoolean("autoEnter"))
                        val remaining = deadline - SystemClock.elapsedRealtime()
                        if (remaining <= 0) { finish("timeout"); return@evaluate }
                        fill.put("expiresAt", System.currentTimeMillis() + remaining)
                        evaluate(fill) { finish(if (it == "filled") "filled" else "fill_failed") }
                    } catch (_: Exception) { finish("key_error") }
                }
                "invalid_selector", "invalid_input" -> finish(state)
                else -> handler.postDelayed({ poll() }, 100)
            }
        }
    }

    companion object {
        fun origin(url: String): String = runCatching {
            val uri = URI(url)
            val scheme = uri.scheme.lowercase()
            val host = uri.host.lowercase()
            val port = uri.port
            "$scheme://$host" + if (port == -1 || (scheme == "http" && port == 80) || (scheme == "https" && port == 443)) "" else ":$port"
        }.getOrDefault("")
    }
}
