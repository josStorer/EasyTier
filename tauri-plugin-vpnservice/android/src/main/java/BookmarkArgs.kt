package com.plugin.vpnservice

import app.tauri.annotation.InvokeArg

@InvokeArg
class BookmarkSaveArgs {
    var id: String = ""
    var name: String = ""
    var url: String = ""
    var selector: String = ""
    var secret: String = ""
    var clearSecret: Boolean = false
    var autoEnter: Boolean = false
}

@InvokeArg
class BookmarkIdArgs { var id: String = "" }

@InvokeArg
class BookmarkPrepareArgs {
    var id: String = ""
    var label: String = ""
    var proxyPort: Int = 0
    var existingWindow: Boolean = false
}
