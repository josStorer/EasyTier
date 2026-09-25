package com.plugin.vpnservice

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.content.Context
import androidx.activity.result.ActivityResult
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import android.webkit.WebView

@InvokeArg
class PingArgs {
    var value: String? = null
}

@InvokeArg
class StartVpnArgs {
    var requestId: String? = null
    var ipv4Addr: String? = null
    var routes: Array<String> = emptyArray()
    var dns: String? = null
    var disallowedApplications: Array<String> = emptyArray()
    var mtu: Int? = null
}

@TauriPlugin
class VpnServicePlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        @Volatile
        private var tileActionCallback: (String) -> Boolean = { false }

        fun dispatchTileAction(action: String): Boolean = tileActionCallback(action)
    }

    private val implementation = Example()
    private val connectivity by lazy { activity.getSystemService(ConnectivityManager::class.java) }
    @Volatile private var physicalNetwork: String? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return
            updateNetwork(network.toString())
        }

        override fun onLost(network: Network) {
            if (physicalNetwork == network.toString()) updateNetwork(null)
        }
    }

    private fun updateNetwork(network: String?) {
        if (physicalNetwork == network) return
        physicalNetwork = network
        trigger("physical_network_changed", JSObject().apply {
            put("available", network != null)
            put("networkId", network)
        })
    }
    private val tileActionHandler: (String) -> Boolean = { action ->
        val data = JSObject()
        data.put("action", action)
        trigger("vpn_tile_action", data)
        true
    }

    override fun load(webView: WebView) {
        println("load vpn service plugin")
        TauriVpnService.triggerCallback = { event, data ->
            println("vpn: triggerCallback $event $data")
            trigger(event, data)
        }
        tileActionCallback = tileActionHandler
        physicalNetwork = connectivity.activeNetwork?.toString()
        connectivity.registerDefaultNetworkCallback(networkCallback)
    }

    override fun onDestroy() {
        connectivity.unregisterNetworkCallback(networkCallback)
        if (tileActionCallback === tileActionHandler) {
            tileActionCallback = { false }
        }
        super.onDestroy()
    }

    @Command
    fun ping(invoke: Invoke) {
        val args = invoke.parseArgs(PingArgs::class.java)

        val ret = JSObject()
        ret.put("value", implementation.pong(args.value ?: "default value :("))
        invoke.resolve(ret)
    }

    @Command
    fun prepareVpn(invoke: Invoke) {
        activity.runOnUiThread {
            println("prepare vpn in plugin")
            val it = VpnService.prepare(activity)
            if (it != null) {
                startActivityForResult(invoke, it, "onPrepareVpnResult")
                return@runOnUiThread
            }
            val ret = JSObject()
            ret.put("granted", true)
            invoke.resolve(ret)
        }
    }

    @ActivityCallback
    fun onPrepareVpnResult(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        ret.put("granted", result.resultCode == Activity.RESULT_OK)
        invoke.resolve(ret)
    }

    @Command
    fun startVpn(invoke: Invoke) {
        val args = invoke.parseArgs(StartVpnArgs::class.java)
        activity.runOnUiThread {
            println("start vpn in plugin, args: $args")

            val it = VpnService.prepare(activity)
            val ret = JSObject()
            if (it != null) {
                ret.put("errorMsg", "need_prepare")
            } else {
                val intent = Intent(activity, TauriVpnService::class.java)
                val requestId = args.requestId ?: java.util.UUID.randomUUID().toString()
                TauriVpnService.pendingRequestId = requestId
                TauriVpnService.errorMsg = null
                intent.putExtra(TauriVpnService.REQUEST_ID, requestId)
                intent.putExtra(TauriVpnService.IPV4_ADDR, args.ipv4Addr)
                intent.putExtra(TauriVpnService.ROUTES, args.routes)
                intent.putExtra(TauriVpnService.DNS, args.dns)
                intent.putExtra(TauriVpnService.DISALLOWED_APPLICATIONS, args.disallowedApplications)
                intent.putExtra(TauriVpnService.MTU, args.mtu)

                try {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        activity.startForegroundService(intent)
                    } else {
                        activity.startService(intent)
                    }
                } catch (error: Exception) {
                    TauriVpnService.pendingRequestId = null
                    ret.put("errorMsg", error.message ?: error.javaClass.simpleName)
                }
            }
            invoke.resolve(ret)
        }
    }

    @Command
    fun stopVpn(invoke: Invoke) {
        activity.runOnUiThread {
            println("stop vpn in plugin")
            TauriVpnService.pendingRequestId = null
            try {
                TauriVpnService.self?.stopVpn()
                activity.stopService(Intent(activity, TauriVpnService::class.java))
                activity.stopService(Intent().setClassName(activity.packageName, "${activity.packageName}.MainForegroundService"))
                println("stop vpn in plugin end")
                invoke.resolve(JSObject())
            } catch (error: Exception) {
                invoke.reject(error.message ?: error.javaClass.simpleName)
            }
        }
    }

    @Command
    fun getVpnStatus(invoke: Invoke) {
        val ret = JSObject()
        ret.put("running", TauriVpnService.self?.tunnelFd != null)
        ret.put("fd", TauriVpnService.self?.tunnelFd)
        ret.put("requestId", TauriVpnService.requestId)
        ret.put("errorMsg", TauriVpnService.errorMsg)
        ret.put("networkAvailable", physicalNetwork != null)
        ret.put("networkId", physicalNetwork)
        ret.put("ipv4Addr", TauriVpnService.ipv4Addr)
        ret.put("routes", TauriVpnService.routes)
        ret.put("dns", TauriVpnService.dns)
        invoke.resolve(ret)
    }

    @Command
    fun consumeVpnTileAction(invoke: Invoke) {
        val ret = JSObject()
        ret.put("action", EasyTierVpnTileService.consumePendingAction(activity))
        val preferences = activity.getSharedPreferences("easytier_launch", Context.MODE_PRIVATE)
        ret.put("launchRequested", preferences.getBoolean("pending", false))
        preferences.edit().remove("pending").commit()
        invoke.resolve(ret)
    }
}
