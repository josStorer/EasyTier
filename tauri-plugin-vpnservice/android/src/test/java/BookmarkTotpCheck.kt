package com.plugin.vpnservice

// Standalone JVM regression check, also run by the Android CI before packaging.
fun main() {
    val key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" // RFC 6238 SHA-1 test key
    val times = listOf(59L, 1111111109L, 1111111111L, 1234567890L, 2000000000L, 20000000000L)
    val expected = listOf("287082", "081804", "050471", "005924", "279037", "353130")
    times.zip(expected).forEach { (time, result) -> check(BookmarkTotp.code(key, time) == result) }
    check(BookmarkTotp.code("otpauth://totp/test?secret=$key&digits=6&period=30", 59) == "287082")
    check(BookmarkTotp.code(key.lowercase().chunked(4).joinToString(" "), 59) == "287082")
    check(BookmarkTotp.code(key, 59) != BookmarkTotp.code(key, 60))
    for (bad in listOf("", "A", "invalid-!", "otpauth://hotp/x?secret=$key", "otpauth://totp/x?secret=$key&digits=8",
        "otpauth://totp/x?secret=$key&period=0", "otpauth://totp/x?secret=$key&algorithm=MD5")) {
        check(runCatching { BookmarkTotp.parse(bad) }.isFailure)
    }
    println("Bookmark TOTP RFC vectors, import, rollover and invalid-input checks passed")
}
