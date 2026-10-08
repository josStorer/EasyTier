package com.plugin.vpnservice

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.plugin.JSObject
import java.net.URI
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

// Never return secret material to the GUI or put it in intents/logs/page scripts.
class BookmarkStore(context: Context) {
    private val preferences = context.getSharedPreferences("encrypted_bookmarks", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey("easytier.bookmarks.v1", null)
        if (existing != null) return existing as SecretKey
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("easytier.bookmarks.v1",
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun read(): JSONObject {
        val saved = preferences.getString("data", null) ?: return JSONObject().put("items", JSONArray()).put("selectedId", "")
        val bytes = Base64.decode(saved, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }

    private fun write(data: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.iv + cipher.doFinal(data.toString().toByteArray(Charsets.UTF_8))
        check(preferences.edit().putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) {
            "Could not save bookmarks"
        }
    }

    fun snapshot(): JSObject = synchronized(LOCK) {
        val data = read()
        val items = data.getJSONArray("items")
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            item.put("hasSecret", item.optString("secret").isNotEmpty())
            item.remove("secret")
            item.put("opened", BookmarkWindows.isOpen(item.getString("id")))
        }
        JSObject(data.toString())
    }

    fun get(id: String): JSONObject = synchronized(LOCK) {
        val items = read().getJSONArray("items")
        (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull { it.getString("id") == id }
            ?: error("Bookmark not found")
    }

    fun save(args: BookmarkSaveArgs) = synchronized(LOCK) {
        val data = read()
        val items = data.getJSONArray("items")
        val id = if (args.id.isEmpty()) UUID.randomUUID().toString() else UUID.fromString(args.id).toString()
        require(!BookmarkWindows.isOpen(id)) { "Close the page before editing" }
        val index = (0 until items.length()).firstOrNull { items.getJSONObject(it).getString("id") == id }
        require(index != null || items.length() < 50) { "At most 50 bookmarks" }
        require(args.name.trim().isNotEmpty() && args.name.length <= 120) { "Enter a name (up to 120 characters)" }
        val url = URI(args.url.trim())
        require(url.scheme in listOf("http", "https") && !url.host.isNullOrEmpty() && url.userInfo == null
            && args.url.length <= 2048 && url.port in -1..65535 && url.port != 0) { "Enter an HTTP or HTTPS URL without credentials" }
        require(args.selector.length <= 1024 && args.secret.length <= 2048) { "Setting is too long" }
        val old = index?.let { items.getJSONObject(it) }
        val secret = if (args.clearSecret) "" else args.secret.trim().ifEmpty { old?.optString("secret").orEmpty() }
        if (secret.isNotEmpty()) BookmarkTotp.parse(secret)
        require(args.selector.isBlank() || secret.isNotEmpty()) { "Import a 2FA key before enabling automatic fill" }
        val item = JSONObject().put("id", id).put("name", args.name.trim()).put("url", url.toString())
            .put("selector", args.selector.trim()).put("autoEnter", args.autoEnter).put("secret", secret)
        if (index == null) items.put(item) else items.put(index, item)
        data.put("selectedId", id)
        write(data)
    }

    fun select(id: String) = synchronized(LOCK) {
        get(id)
        write(read().put("selectedId", id))
    }

    fun delete(id: String) = synchronized(LOCK) {
        val data = read()
        val items = data.getJSONArray("items")
        val remaining = JSONArray()
        for (index in 0 until items.length()) if (items.getJSONObject(index).getString("id") != id) remaining.put(items.get(index))
        data.put("items", remaining)
        if (data.optString("selectedId") == id) data.put("selectedId", if (remaining.length() == 0) "" else remaining.getJSONObject(0).getString("id"))
        write(data)
    }

    companion object { private val LOCK = Any() }
}
