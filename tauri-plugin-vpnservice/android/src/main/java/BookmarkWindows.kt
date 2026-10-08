package com.plugin.vpnservice

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import java.lang.ref.WeakReference
import java.net.URI
import org.json.JSONObject
import org.json.JSONTokener

object BookmarkWindows {
    private data class Page(val label: String, val activity: WeakReference<Activity>)
    private data class Pending(val item: JSONObject, val deadline: Long)
    private val pages = mutableMapOf<String, Page>()
    private val pending = mutableMapOf<String, Pending>()

    fun isOpen(id: String): Boolean = synchronized(this) {
        pages[id]?.activity?.get()?.let { !it.isFinishing && !it.isDestroyed } == true
            || pending.values.any { it.item.getString("id") == id && it.deadline > SystemClock.elapsedRealtime() }
    }

    fun isReady(id: String, label: String): Boolean = synchronized(this) {
        pages[id]?.let { it.label == label && it.activity.get()?.let { page -> !page.isFinishing && !page.isDestroyed } == true } == true
    }

    fun isPending(label: String): Boolean = synchronized(this) {
        pending[label]?.let { it.deadline > SystemClock.elapsedRealtime() } == true
    }

    fun resume(id: String): Boolean {
        val page = synchronized(this) { pages[id]?.activity?.get() } ?: return false
        if (page.isFinishing || page.isDestroyed) return false
        val task = page.getSystemService(ActivityManager::class.java).appTasks
            .firstOrNull { it.taskInfo.id == page.taskId }
        if (task == null) {
            Log.w("EasyTierBookmark", "resume task missing: id=$id task=${page.taskId}")
            page.finishAndRemoveTask()
            detach(id, page)
            return false
        }
        task.moveToFront()
        Log.i("EasyTierBookmark", "resumed: id=$id task=${page.taskId}")
        return true
    }

    fun prepare(label: String, item: JSONObject) = synchronized(this) {
        pending.entries.removeAll { it.value.deadline <= SystemClock.elapsedRealtime() }
        check(!isOpen(item.getString("id"))) { "Bookmark is already open or opening" }
        require(pending.size < 50) { "Too many pending pages" }
        pending[label] = Pending(JSONObject(item.toString()).apply { remove("secret") }, SystemClock.elapsedRealtime() + 20000)
        Log.i("EasyTierBookmark", "prepared: label=$label")
    }

    fun cancel(label: String) = synchronized(this) {
        pending.remove(label)
        val entry = pages.entries.firstOrNull { it.value.label == label }
        entry?.value?.activity?.get()?.finishAndRemoveTask()
        if (entry != null) pages.remove(entry.key)
        Log.i("EasyTierBookmark", "cancelled: label=$label")
    }

    fun attach(label: String, activity: Activity): JSONObject? = synchronized(this) {
        val launch = pending.remove(label)
        if (launch == null || launch.deadline <= SystemClock.elapsedRealtime()) {
            Log.w("EasyTierBookmark", "ignored late or unknown activity: label=$label")
            return null
        }
        pages[launch.item.getString("id")] = Page(label, WeakReference(activity))
        Log.i("EasyTierBookmark", "attached: label=$label task=${activity.taskId}")
        launch.item
    }

    fun detach(id: String, activity: Activity) = synchronized(this) {
        if (pages[id]?.activity?.get() === activity) pages.remove(id)
        Log.i("EasyTierBookmark", "detached: id=$id task=${activity.taskId}")
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
    private var lastProbe = "waiting"
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
        report(if (reason == "timeout" && lastProbe == "input_unavailable") lastProbe else reason)
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
            lastProbe = state
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
                        evaluate(fill) {
                            when (it) {
                                "waiting", "input_unavailable" -> {
                                    lastProbe = it
                                    handler.postDelayed({ poll() }, 100)
                                }
                                "filled", "invalid_selector", "invalid_input", "timeout" -> finish(it)
                                else -> finish("fill_failed")
                            }
                        }
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
