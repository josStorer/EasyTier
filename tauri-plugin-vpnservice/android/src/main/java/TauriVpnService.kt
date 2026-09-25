package com.plugin.vpnservice

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Bundle
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import java.net.InetAddress
import java.util.Arrays

import app.tauri.plugin.JSObject

class TauriVpnService : VpnService() {
    companion object {
        @JvmField var triggerCallback: (String, JSObject) -> Unit = { _, _ -> }
        @Volatile @JvmField var self: TauriVpnService? = null
        @JvmField var ipv4Addr: String? = null
        @JvmField var routes: Array<String> = emptyArray()
        @JvmField var dns: String? = null
        @Volatile @JvmField var requestId: String? = null
        @Volatile @JvmField var pendingRequestId: String? = null
        @Volatile @JvmField var errorMsg: String? = null

        const val IPV4_ADDR = "IPV4_ADDR"
        const val ROUTES = "ROUTES"
        const val DNS = "DNS"
        const val DISALLOWED_APPLICATIONS = "DISALLOWED_APPLICATIONS"
        const val MTU = "MTU"
        const val REQUEST_ID = "REQUEST_ID"

        private const val NOTIFICATION_CHANNEL_ID = "easytier_vpn_channel"
        private const val NOTIFICATION_ID = 1356
    }

    @Volatile private var vpnInterface: ParcelFileDescriptor? = null

    val tunnelFd: Int? get() = vpnInterface?.fd

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        println("vpn on start command ${intent?.getExtras()} $intent")
        val args = intent?.extras
        val requestedId = args?.getString(REQUEST_ID)
        // A queued start may arrive after Stop. Never recreate a default VPN from
        // a null sticky-service intent or from a superseded request.
        if (requestedId == null || requestedId != pendingRequestId) {
            if (vpnInterface == null) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        try {
            startVpnForegroundService()
            disconnect()
            self = this
            requestId = requestedId
            errorMsg = null
            vpnInterface = createVpnInterface(args)
            ipv4Addr = args?.getString(IPV4_ADDR)
            routes = args?.getStringArray(ROUTES) ?: emptyArray()
            dns = args?.getString(DNS)
            triggerCallback("vpn_service_start", JSObject().apply {
                put("fd", tunnelFd)
                put("requestId", requestId)
            })
        } catch (error: Exception) {
            errorMsg = error.message ?: error.javaClass.simpleName
            disconnect()
            triggerCallback("vpn_service_error", JSObject().apply { put("errorMsg", errorMsg) })
            stopSelfResult(startId)
        }
        EasyTierVpnTileService.requestStateUpdate(this)
        return START_NOT_STICKY
    }

    override fun onCreate() {
        super.onCreate()
        self = this
        println("vpn on create")
    }

    override fun onDestroy() {
        println("vpn on destroy")
        disconnect()
        // A manual stop must not start another keepalive service.
        stopForeground(STOP_FOREGROUND_REMOVE)
        self = null
        EasyTierVpnTileService.requestStateUpdate(this)
        super.onDestroy()
    }

    override fun onRevoke() {
        println("vpn on revoke")
        disconnect()
        pendingRequestId = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        self = null
        EasyTierVpnTileService.requestStateUpdate(this)
        super.onRevoke()
    }

    fun stopVpn() {
        // stopService alone can leave a system-bound service alive. Release the
        // actual TUN before acknowledging Stop, rather than waiting for onDestroy.
        disconnect()
        stopForeground(STOP_FOREGROUND_REMOVE)
        EasyTierVpnTileService.requestStateUpdate(this)
    }

    private fun disconnect() {
        val previous = vpnInterface
        previous?.close()
        vpnInterface = null
        clearStatus()
        if (previous != null) triggerCallback("vpn_service_stop", JSObject())
    }

    private fun clearStatus() {
        ipv4Addr = null
        routes = emptyArray()
        dns = null
    }

    private fun startVpnForegroundService() {
        createNotificationChannel()

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentTitle("EasyTier VPN is running")
            .setContentText("VPN connection is active")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .apply { contentIntent?.let(::setContentIntent) }
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // A TUN-backed network is now protected by this foreground service, so the
        // no-TUN keepalive service is redundant and would show a second notification.
        setMainForegroundServiceEnabled(false)
    }

    private fun setMainForegroundServiceEnabled(enabled: Boolean) {
        val intent = Intent().setClassName(packageName, "$packageName.MainForegroundService")
        if (!enabled) {
            stopService(intent)
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "EasyTier VPN",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun createVpnInterface(args: Bundle?): ParcelFileDescriptor {
        var builder = Builder()
                .setSession("TauriVpnService")
                .setBlocking(false)
        
        var mtu = args?.getInt(MTU, 1300) ?: 1300
        var ipv4Addr = requireNotNull(args?.getString(IPV4_ADDR)) { "Missing VPN address" }
        var dns: String? = args?.getString(DNS)
        var routes = args?.getStringArray(ROUTES) ?: emptyArray()
        var disallowedApplications = args?.getStringArray(DISALLOWED_APPLICATIONS) ?: emptyArray()

        println("vpn create vpn interface. mtu: $mtu, ipv4Addr: $ipv4Addr, dns:" +
            "$dns, routes: ${java.util.Arrays.toString(routes)}," +
            "disallowedApplications:  ${java.util.Arrays.toString(disallowedApplications)}")

        val ipParts = ipv4Addr.split("/")
        if (ipParts.size != 2) throw IllegalArgumentException("Invalid IP addr string")
        builder.addAddress(ipParts[0], ipParts[1].toInt())
        builder.addAddress("fd00::1", 128)

        builder.setMtu(mtu)
        dns?.let { builder.addDnsServer(it) }

        for (route in routes) {
            val ipParts = route.split("/")
            if (ipParts.size != 2) throw IllegalArgumentException("Invalid route cidr string")
            builder.addRoute(ipParts[0], ipParts[1].toInt())
        }
        
        for (app in disallowedApplications) {
            builder.addDisallowedApplication(app)
        }

        return builder.also {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                it.setMetered(false)
            }
        }
        .establish()
        ?: throw IllegalStateException("Failed to init VpnService")
    }
}
