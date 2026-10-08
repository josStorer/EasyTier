package com.plugin.vpnservice

import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class TotpKey(val bytes: ByteArray, val algorithm: String, val period: Long)

object BookmarkTotp {
    fun parse(input: String): TotpKey {
        var secret = input.trim()
        var algorithm = "SHA1"
        var period = 30L
        if (secret.startsWith("otpauth://", ignoreCase = true)) {
            val uri = URI(secret)
            require(uri.host == "totp") { "Only TOTP keys are supported" }
            val args = uri.rawQuery.orEmpty().split('&').associate {
                val parts = it.split('=', limit = 2)
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
            }
            require(args.getOrDefault("digits", "6") == "6") { "Use a six-digit TOTP key" }
            algorithm = args.getOrDefault("algorithm", "SHA1").uppercase()
            period = args.getOrDefault("period", "30").toLong()
            secret = args["secret"] ?: error("Missing TOTP secret")
        }
        require(algorithm in listOf("SHA1", "SHA256", "SHA512") && period in 1..3600) { "Invalid TOTP settings" }
        val normalized = secret.uppercase().filterNot { it.isWhitespace() }.trimEnd('=')
        require(normalized.isNotEmpty() && normalized.length <= 1024) { "Invalid Base32 secret" }
        val output = ArrayList<Byte>()
        var bits = 0
        var value = 0
        for (char in normalized) {
            val digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char)
            require(digit >= 0) { "Invalid Base32 secret" }
            value = (value shl 5) or digit
            bits += 5
            if (bits >= 8) {
                bits -= 8
                output.add((value shr bits).toByte())
                value = value and ((1 shl bits) - 1)
            }
        }
        require(output.isNotEmpty() && bits < 5 && value == 0) { "Invalid Base32 secret length" }
        return TotpKey(output.toByteArray(), algorithm, period)
    }

    fun code(input: String, seconds: Long = System.currentTimeMillis() / 1000): String {
        val key = parse(input)
        val mac = Mac.getInstance("Hmac${key.algorithm}")
        mac.init(SecretKeySpec(key.bytes, mac.algorithm))
        val hash = mac.doFinal(ByteBuffer.allocate(8).putLong(seconds / key.period).array())
        val offset = hash.last().toInt() and 15
        val binary = ByteBuffer.wrap(hash, offset, 4).int and 0x7fffffff
        return (binary % 1000000).toString().padStart(6, '0')
    }
}
