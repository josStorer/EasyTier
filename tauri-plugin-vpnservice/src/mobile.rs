use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.plugin.vpnservice";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_vpnservice);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Vpnservice<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VpnServicePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_vpnservice)?;
    Ok(Vpnservice(handle))
}

/// Access to the vpnservice APIs.
pub struct Vpnservice<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Vpnservice<R> {
    pub fn prepare_bookmark(
        &self,
        id: String,
        label: String,
        proxy_port: u16,
        existing_window: bool,
    ) -> crate::Result<BookmarkPrepared> {
        self.0
            .run_mobile_plugin(
                "prepareBookmark",
                BookmarkPrepareRequest {
                    id,
                    label,
                    proxy_port,
                    existing_window,
                },
            )
            .map_err(Into::into)
    }

    pub fn cancel_bookmark(&self, label: String) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin(
                "cancelBookmark",
                BookmarkPrepareRequest {
                    id: String::new(),
                    label,
                    proxy_port: 0,
                    existing_window: false,
                },
            )
            .map_err(Into::into)
    }

    pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
        self.0
            .run_mobile_plugin("ping", payload)
            .map_err(Into::into)
    }

    pub fn prepare_vpn(&self, payload: VoidRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("prepare_vpn", payload)
            .map_err(Into::into)
    }

    pub fn start_vpn(&self, payload: StartVpnRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("start_vpn", payload)
            .map_err(Into::into)
    }

    pub fn stop_vpn(&self, payload: VoidRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("stop_vpn", payload)
            .map_err(Into::into)
    }

    pub fn get_vpn_status(&self, payload: VoidRequest) -> crate::Result<VpnStatus> {
        self.0
            .run_mobile_plugin("get_vpn_status", payload)
            .map_err(Into::into)
    }

    pub fn consume_vpn_tile_action(
        &self,
        payload: VoidRequest,
    ) -> crate::Result<VpnTileActionResponse> {
        self.0
            .run_mobile_plugin("consume_vpn_tile_action", payload)
            .map_err(Into::into)
    }
}
