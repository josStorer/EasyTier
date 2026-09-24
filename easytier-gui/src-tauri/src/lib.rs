// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connection_intent;
mod elevate;

use anyhow::Context;
#[cfg(target_os = "android")]
use easytier::instance::factory::subscribe_native_instance_event;
use easytier::proto::api::config::{
    ConfigPatchAction, ConfigRpc, ConfigRpcClientFactory, InstanceConfigPatch, PatchConfigRequest,
    VpnPortalClientPatch,
};
use easytier::proto::api::instance::{
    GetVpnPortalInfoRequest, InstanceIdentifier, VpnPortalInfo, VpnPortalRpc,
    VpnPortalRpcClientFactory, instance_identifier,
};
use easytier::proto::api::manage::{
    CollectNetworkInfoResponse, ValidateConfigResponse, VpnPortalClientConfig, WebClientService,
    WebClientServiceClientFactory,
};
use easytier::proto::rpc_types::controller::BaseController;
use easytier::web_client::{self, WebClient};
use easytier::{
    common::config::{NetworkConfig, NetworkConfigExt},
    common::{
        config::{ConfigLoader, ConfigSource, FileLoggerConfig, LoggingConfig, TomlConfigLoader},
        log,
    },
    instance::factory::{NativeInstanceManager, native_instance_manager},
    proto::rpc::standalone::{runtime_rpc_dialer, runtime_rpc_listener},
    rpc_service::ApiRpcServer,
    utils::panic::setup_panic_handler,
};
use easytier_core::management::config_source_to_rpc;
use easytier_core::management::remote_client::{
    GetNetworkMetasResponse, ListNetworkInstanceIdsJsonResp, ListNetworkProps, RemoteClientManager,
    Storage,
};
use easytier_core::{
    connectivity::protocol::raw::TunnelDialer as _, process_runtime::CoreProcessRuntime,
    socket::SocketListener, tunnel::Tunnel,
};
use std::ops::Deref;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, RwLockReadGuard};
use uuid::Uuid;

use tauri::{AppHandle, Emitter, Manager as _};

#[cfg(not(target_os = "android"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

static INSTANCE_MANAGER: once_cell::sync::Lazy<RwLock<Option<Arc<NativeInstanceManager>>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(None));

static RPC_RING_UUID: once_cell::sync::Lazy<uuid::Uuid> =
    once_cell::sync::Lazy::new(uuid::Uuid::new_v4);

static CLIENT_MANAGER: once_cell::sync::Lazy<RwLock<Option<manager::GUIClientManager>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(None));

type BoxedTunnelListener = Box<dyn SocketListener<Accepted = Box<dyn Tunnel>>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RpcServerKind {
    Ring,
    Tcp,
}

struct RpcServer {
    kind: RpcServerKind,
    _server: ApiRpcServer<BoxedTunnelListener>,
    bind_url: Option<url::Url>,
}
static RPC_SERVER: once_cell::sync::Lazy<Mutex<Option<RpcServer>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

static WEB_CLIENT: once_cell::sync::Lazy<RwLock<Option<WebClient>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(None));

static MOBILE_CONNECTION: once_cell::sync::Lazy<connection_intent::ConnectionIntent> =
    once_cell::sync::Lazy::new(connection_intent::ConnectionIntent::default);
static MOBILE_CONTROL_LOCK: Mutex<()> = Mutex::const_new(());
static WEB_CLIENT_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
fn mobile_connection_enabled() -> bool {
    MOBILE_CONNECTION.enabled()
}

async fn disconnect_config_server() {
    WEB_CLIENT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *WEB_CLIENT.write().await = None;
}

macro_rules! get_client_manager {
    () => {{
        let guard = CLIENT_MANAGER
            .try_read()
            .map_err(|_| "Failed to acquire read lock for client manager")?;
        RwLockReadGuard::try_map(guard, |cm| cm.as_ref())
            .map_err(|_| "RPC connection not initialized".to_string())
    }};
}

#[tauri::command]
async fn set_mobile_connection_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    // Set intent before waiting: an in-flight start must observe a stop immediately.
    MOBILE_CONNECTION.set_enabled(enabled);
    tracing::info!(target: "mobile_vpn", enabled, intent = MOBILE_CONNECTION.token(), pid = std::process::id(), "connection intent changed");
    let _control = MOBILE_CONTROL_LOCK.lock().await;
    if enabled {
        return Ok(());
    }
    disconnect_config_server().await;
    #[cfg(target_os = "android")]
    {
        let manager = get_client_manager!()?;
        manager
            .disable_instances_with_tun(&app, false)
            .await
            .map_err(|e| e.to_string())?;
        manager.notify_vpn_stop_if_no_tun(&app)?;
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
fn easytier_version() -> Result<String, String> {
    Ok(easytier::VERSION.to_string())
}

#[tauri::command]
fn set_dock_visibility(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        app.set_activation_policy(if visible {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
    Ok(())
}

#[tauri::command]
fn parse_network_config(cfg: NetworkConfig) -> Result<String, String> {
    let toml = cfg.gen_config().map_err(|e| e.to_string())?;
    Ok(toml.dump())
}

#[tauri::command]
fn generate_network_config(toml_config: String) -> Result<NetworkConfig, String> {
    let config = TomlConfigLoader::new_from_str(&toml_config).map_err(|e| e.to_string())?;
    let cfg = NetworkConfig::new_from_config(&config).map_err(|e| e.to_string())?;
    Ok(cfg)
}

#[tauri::command]
async fn run_network_instance(
    app: AppHandle,
    cfg: NetworkConfig,
    save: bool,
) -> Result<(), String> {
    let _control = MOBILE_CONTROL_LOCK.lock().await;
    #[cfg(target_os = "android")]
    if !cfg.no_tun() && !MOBILE_CONNECTION.enabled() {
        return Err("mobile_connection_stopped".to_string());
    }
    let client_manager = get_client_manager!()?;
    let toml_config = cfg.gen_config().map_err(|e| e.to_string())?;
    client_manager
        .pre_run_network_instance_hook(
            &app,
            &toml_config,
            manager::PersistedConfigSource::User,
            manager::RunOrigin::Local,
        )
        .await?;
    client_manager
        .handle_run_network_instance(app.clone(), cfg, save)
        .await
        .map_err(|e| e.to_string())?;
    client_manager
        .post_run_network_instance_hook(&app, &toml_config.get_id())
        .await?;
    Ok(())
}

#[tauri::command]
async fn collect_network_info(
    app: AppHandle,
    instance_id: String,
) -> Result<CollectNetworkInfoResponse, String> {
    let instance_id = instance_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    get_client_manager!()?
        .handle_collect_network_info(app, Some(vec![instance_id]))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_vpn_portal_info(instance_id: String) -> Result<Option<VpnPortalInfo>, String> {
    let instance_id = instance_id
        .parse::<uuid::Uuid>()
        .map_err(|e| e.to_string())?;
    let client_manager = get_client_manager!()?;
    let client = client_manager
        .rpc_manager
        .rpc_client()
        .scoped_client::<VpnPortalRpcClientFactory<BaseController>>(1, 1, "".to_string());
    let response = client
        .get_vpn_portal_info(
            BaseController::default(),
            GetVpnPortalInfoRequest {
                instance: Some(InstanceIdentifier {
                    selector: Some(instance_identifier::Selector::Id(instance_id.into())),
                }),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(response.vpn_portal_info)
}

#[tauri::command]
async fn patch_vpn_portal_clients(
    instance_id: String,
    action: String,
    name: Option<String>,
    virtual_ip: Option<String>,
    groups: Option<Vec<String>>,
) -> Result<(), String> {
    let instance_id = instance_id
        .parse::<uuid::Uuid>()
        .map_err(|e| e.to_string())?;
    let action = match action.as_str() {
        "add" => ConfigPatchAction::Add,
        "remove" => ConfigPatchAction::Remove,
        "clear" => ConfigPatchAction::Clear,
        other => return Err(format!("invalid vpn portal client patch action: {other}")),
    };
    let client = if action == ConfigPatchAction::Clear {
        None
    } else {
        Some(VpnPortalClientConfig {
            name: name.unwrap_or_default(),
            virtual_ip: virtual_ip.unwrap_or_default(),
            groups: groups.unwrap_or_default(),
        })
    };

    let client_manager = get_client_manager!()?;
    let rpc = client_manager
        .rpc_manager
        .rpc_client()
        .scoped_client::<ConfigRpcClientFactory<BaseController>>(1, 1, "".to_string());
    rpc.patch_config(
        BaseController::default(),
        PatchConfigRequest {
            instance: Some(InstanceIdentifier {
                selector: Some(instance_identifier::Selector::Id(instance_id.into())),
            }),
            patch: Some(InstanceConfigPatch {
                vpn_portal_clients: vec![VpnPortalClientPatch {
                    action: action as i32,
                    client,
                }],
                ..Default::default()
            }),
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_logging_level(level: String) -> Result<(), String> {
    get_client_manager!()?
        .set_logging_level(level.clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_tun_fd(fd: i32, instance_id: Option<String>) -> Result<(), String> {
    let Some(instance_manager) = INSTANCE_MANAGER.read().await.clone() else {
        return Err("set_tun_fd is not supported in remote mode".to_string());
    };
    let manager = get_client_manager!()?;
    let uuid = if let Some(id) = instance_id {
        let id = id.parse::<uuid::Uuid>().map_err(|e| e.to_string())?;
        if !manager
            .get_enabled_instances_with_tun_ids()
            .any(|enabled| enabled == id)
        {
            return Err("VPN instance is no longer enabled".to_string());
        }
        id
    } else {
        manager
            .get_enabled_instances_with_tun_ids()
            .next()
            .ok_or_else(|| "No enabled VPN instance".to_string())?
    };
    if fd < 0 {
        return Err("Invalid TUN file descriptor".to_string());
    }
    tracing::info!(target: "mobile_vpn", instance_id = %uuid, fd, "attaching Android TUN to core");
    #[cfg(target_os = "android")]
    let mut events = instance_manager
        .instance(uuid)
        .and_then(|instance| subscribe_native_instance_event(&instance))
        .ok_or_else(|| "VPN instance event stream is unavailable".to_string())?;
    instance_manager
        .attach_tun_fd(uuid, fd)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "android")]
    {
        use easytier::common::global_ctx::GlobalCtxEvent;
        // attach_tun_fd only queues work. Wait for the runtime to actually open
        // the device so a failed async attachment cannot appear as success.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match events.recv().await.map_err(|e| e.to_string())? {
                    GlobalCtxEvent::TunDeviceReady(name) if name == format!("tunfd_{fd}") => {
                        tracing::info!(target: "mobile_vpn", instance_id = %uuid, fd, "Android TUN ready in core");
                        return Ok::<(), String>(());
                    }
                    GlobalCtxEvent::TunDeviceError(error) => return Err(error),
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| "Timed out attaching the VPN interface to the core".to_string())??;
    }
    Ok(())
}

#[tauri::command]
async fn list_network_instance_ids(
    app: AppHandle,
) -> Result<ListNetworkInstanceIdsJsonResp, String> {
    get_client_manager!()?
        .handle_list_network_instance_ids(app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_network_instance(app: AppHandle, instance_id: String) -> Result<(), String> {
    let instance_id = instance_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let client_manager = get_client_manager!()?;
    client_manager
        .handle_remove_network_instances(app.clone(), vec![instance_id])
        .await
        .map_err(|e| e.to_string())?;
    client_manager
        .post_stop_network_instances_hook(&app)
        .await?;

    Ok(())
}

#[tauri::command]
async fn update_network_config_state(
    app: AppHandle,
    instance_id: String,
    disabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let config = get_client_manager!()?
            .handle_get_network_config(
                app.clone(),
                instance_id
                    .parse()
                    .map_err(|e: uuid::Error| e.to_string())?,
            )
            .await
            .map_err(|e| e.to_string())?;
        if !config.no_tun() {
            if disabled {
                MOBILE_CONNECTION.set_enabled(false);
                disconnect_config_server().await;
            } else if !MOBILE_CONNECTION.enabled() {
                return Err("mobile_connection_stopped".to_string());
            }
        }
    }
    let _control = MOBILE_CONTROL_LOCK.lock().await;
    let instance_id = instance_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let client_manager = get_client_manager!()?;
    if !disabled {
        let (cfg, source) = client_manager
            .handle_get_network_config_with_source(app.clone(), instance_id)
            .await
            .map_err(|e| e.to_string())?;
        let toml_config = cfg.gen_config().map_err(|e| e.to_string())?;
        client_manager
            .pre_run_network_instance_hook(
                &app,
                &toml_config,
                manager::PersistedConfigSource::from_runtime_source(source),
                manager::RunOrigin::Local,
            )
            .await?;
    }
    client_manager
        .handle_update_network_state(app.clone(), instance_id, disabled)
        .await
        .map_err(|e| e.to_string())?;

    if disabled {
        client_manager
            .post_stop_network_instances_hook(&app)
            .await?;
    } else {
        client_manager
            .post_run_network_instance_hook(&app, &instance_id)
            .await?;
    }

    Ok(())
}

#[tauri::command]
async fn save_network_config(app: AppHandle, cfg: NetworkConfig) -> Result<(), String> {
    let instance_id = cfg
        .instance_id()
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    get_client_manager!()?
        .handle_save_network_config(app, instance_id, cfg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn validate_config(
    app: AppHandle,
    config: NetworkConfig,
) -> Result<ValidateConfigResponse, String> {
    get_client_manager!()?
        .handle_validate_config(app, config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_config(app: AppHandle, instance_id: String) -> Result<NetworkConfig, String> {
    let instance_id = instance_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let cfg = get_client_manager!()?
        .handle_get_network_config(app, instance_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(cfg)
}

#[tauri::command]
async fn load_configs(
    app: AppHandle,
    configs: Vec<manager::StoredGuiConfig>,
    enabled_networks: Vec<String>,
) -> Result<(), String> {
    get_client_manager!()?
        .load_configs(app, configs, enabled_networks)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_network_metas(
    app: AppHandle,
    instance_ids: Vec<uuid::Uuid>,
) -> Result<GetNetworkMetasResponse, String> {
    get_client_manager!()?
        .handle_get_network_metas(app, instance_ids)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
fn init_service() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn init_service(opts: Option<service::ServiceOptions>) -> Result<(), String> {
    match opts {
        Some(args) => {
            let path = std::path::Path::new(&args.config_dir);
            if !path.exists() {
                std::fs::create_dir_all(&args.config_dir).map_err(|e| e.to_string())?;
            } else if !path.is_dir() {
                return Err("config_dir exists but is not a directory".to_string());
            }
            let path = std::path::Path::new(&args.file_log_dir);
            if !path.exists() {
                std::fs::create_dir_all(&args.file_log_dir).map_err(|e| e.to_string())?;
            } else if !path.is_dir() {
                return Err("file_log_dir exists but is not a directory".to_string());
            }

            service::install(args).map_err(|e| format!("{:#}", e))?;
        }
        None => {
            service::uninstall().map_err(|e| format!("{:#}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn set_service_status(_enable: bool) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        service::set_status(_enable).map_err(|e| format!("{:#}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn get_service_status() -> Result<&'static str, String> {
    #[cfg(not(target_os = "android"))]
    {
        use easytier::service_manager::ServiceStatus;
        let status = service::status().map_err(|e| format!("{:#}", e))?;
        match status {
            ServiceStatus::NotInstalled => Ok("NotInstalled"),
            ServiceStatus::Stopped(_) => Ok("Stopped"),
            ServiceStatus::Running => Ok("Running"),
        }
    }
    #[cfg(target_os = "android")]
    {
        Ok("NotInstalled")
    }
}

fn normalize_normal_mode_rpc_portal(portal: &str) -> Result<(url::Url, url::Url), String> {
    let portal_url: url::Url = portal
        .parse()
        .map_err(|e| format!("invalid rpc portal: {:#}", e))?;
    let bind_url = portal_url.clone();
    let mut connect_url = portal_url.clone();
    // if bind addr is 0.0.0.0, should convert to 127.0.0.1
    if connect_url.host_str() == Some("0.0.0.0") {
        connect_url.set_host(Some("127.0.0.1")).unwrap();
    }
    Ok((bind_url, connect_url))
}

async fn resolve_rpc_bind_url(url: &url::Url) -> Result<std::net::SocketAddr, String> {
    if url.scheme() != "tcp" {
        return Err(format!("RPC portal requires tcp URL: {url}"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| format!("RPC portal has no host: {url}"))?;
    let port = url.port().unwrap_or(11010);
    tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("failed to resolve RPC portal {url}: {error}"))?
        .next()
        .ok_or_else(|| format!("RPC portal has no resolved address: {url}"))
}

#[tauri::command]
async fn init_rpc_connection(
    _app: AppHandle,
    is_normal_mode: bool,
    url: Option<String>,
) -> Result<(), String> {
    let mut client_manager_guard =
        tokio::time::timeout(std::time::Duration::from_secs(5), CLIENT_MANAGER.write())
            .await
            .map_err(|_| "Failed to acquire write lock for client manager")?;
    let mut instance_manager_guard = INSTANCE_MANAGER
        .try_write()
        .map_err(|_| "Failed to acquire write lock for instance manager")?;
    let mut rpc_server_guard = RPC_SERVER
        .try_lock()
        .map_err(|_| "Failed to acquire lock for rpc server")?;

    let mut client_url = url.clone();
    let mut local_process_runtime = None;
    if is_normal_mode {
        let instance_manager = if let Some(im) = instance_manager_guard.take() {
            im
        } else {
            Arc::new(native_instance_manager())
        };

        let portal = url.and_then(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });

        let (desired_kind, bind_url, connect_url) = if let Some(portal) = portal {
            let (bind_url, connect_url) = normalize_normal_mode_rpc_portal(&portal)?;
            (RpcServerKind::Tcp, Some(bind_url), Some(connect_url))
        } else {
            (RpcServerKind::Ring, None, None)
        };

        let need_restart = rpc_server_guard
            .as_ref()
            .map(|x| x.kind != desired_kind || x.bind_url != bind_url)
            .unwrap_or(true);

        if need_restart {
            *rpc_server_guard = None;

            let tunnel: BoxedTunnelListener = match desired_kind {
                RpcServerKind::Ring => instance_manager
                    .process_runtime()
                    .bind_ring_tunnel(*RPC_RING_UUID.deref())
                    .map_err(|error| error.to_string())?,
                RpcServerKind::Tcp => {
                    let bind_url = bind_url.as_ref().expect("tcp rpc must have bind url");
                    Box::new(runtime_rpc_listener(resolve_rpc_bind_url(bind_url).await?))
                }
            };

            let rpc_server = ApiRpcServer::from_tunnel(tunnel, instance_manager.clone())
                .with_rx_timeout(None)
                .serve()
                .await
                .map_err(|e| e.to_string())?;
            *rpc_server_guard = Some(RpcServer {
                kind: desired_kind,
                _server: rpc_server,
                bind_url,
            });
        }

        local_process_runtime = Some(instance_manager.process_runtime());
        *instance_manager_guard = Some(instance_manager);
        client_url = connect_url.map(|u| u.to_string());
    } else {
        *rpc_server_guard = None;
    }

    let client_manager = tokio::time::timeout(
        std::time::Duration::from_millis(1000),
        manager::GUIClientManager::new(client_url, local_process_runtime),
    )
    .await
    .map_err(|_| "connect remote rpc timed out".to_string())?
    .with_context(|| "Failed to connect remote rpc")
    .map_err(|e| format!("{:#}", e))?;
    *client_manager_guard = Some(client_manager);

    if !is_normal_mode {
        drop(WEB_CLIENT.write().await.take());
        if let Some(instance_manager) = instance_manager_guard.take() {
            instance_manager
                .retain_network_instances(&[])
                .await
                .map_err(|e| e.to_string())?;
            drop(instance_manager);
        }
    }

    Ok(())
}

#[tauri::command]
async fn is_client_running() -> Result<bool, String> {
    Ok(get_client_manager!()?.rpc_manager.is_running())
}

#[tauri::command]
async fn init_web_client(app: AppHandle, url: Option<String>) -> Result<(), String> {
    let epoch = WEB_CLIENT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let mut web_client_guard = WEB_CLIENT.write().await;
    // Drop the old management session before constructing the replacement.
    *web_client_guard = None;
    let Some(url) = url else {
        return Ok(());
    };
    if cfg!(target_os = "android") && !MOBILE_CONNECTION.enabled() {
        return Ok(());
    }
    let instance_manager = INSTANCE_MANAGER
        .try_read()
        .map_err(|_| "Failed to acquire read lock for instance manager")?
        .clone()
        .ok_or_else(|| "Instance manager is not available".to_string())?;

    let hooks = Arc::new(manager::GuiHooks {
        app: app.clone(),
        epoch,
        intent: MOBILE_CONNECTION.token(),
    });
    let machine_id_state_dir = app
        .path()
        .app_data_dir()
        .with_context(|| "Failed to resolve machine id state directory")
        .map_err(|e| format!("{:#}", e))?;

    let web_client = web_client::run_web_client(
        url.as_str(),
        easytier::common::MachineIdOptions {
            explicit_machine_id: None,
            state_dir: Some(machine_id_state_dir),
        },
        None,
        false,
        instance_manager,
        Some(hooks),
    )
    .await
    .with_context(|| "Failed to initialize web client")
    .map_err(|e| format!("{:#}", e))?;
    if epoch == WEB_CLIENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst)
        && (!cfg!(target_os = "android") || MOBILE_CONNECTION.enabled())
    {
        *web_client_guard = Some(web_client);
    }
    Ok(())
}

#[tauri::command]
async fn is_web_client_connected() -> Result<bool, String> {
    let web_client_guard = WEB_CLIENT.read().await;
    if let Some(web_client) = web_client_guard.as_ref() {
        Ok(web_client.is_connected())
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn restart_mobile_network(app: AppHandle) -> Result<(), String> {
    let token = MOBILE_CONNECTION.token();
    tracing::info!(target: "mobile_vpn", intent = token, "recovery requested; waiting for control lock");
    let _control = MOBILE_CONTROL_LOCK.lock().await;
    if !MOBILE_CONNECTION.allows(token) {
        return Ok(());
    }
    let manager = get_client_manager!()?;
    let Some(id) = manager.get_enabled_instances_with_tun_ids().next() else {
        return Ok(());
    };
    let instances = INSTANCE_MANAGER
        .read()
        .await
        .clone()
        .ok_or("Local instance manager unavailable")?;
    // Use the same mutation lock as management RPCs. In particular, a slow old
    // overwrite must finish before recovery can take a fresh config snapshot.
    let mutation_lock = instances.mutation_lock();
    tracing::info!(target: "mobile_vpn", instance_id = %id, intent = token, "recovery: waiting for instance mutation lock");
    let _mutation = mutation_lock.lock().await;
    if !MOBILE_CONNECTION.allows(token) {
        return Ok(());
    }
    let config = instances
        .config(id)
        .ok_or("Recovery instance unavailable")?;
    let control = instances
        .config_control(id)
        .ok_or("Recovery config control unavailable")?;
    let started = std::time::Instant::now();
    tracing::info!(target: "mobile_vpn", instance_id = %id, intent = token, "recovery: stopping old core instance");
    // Do not use the short-lived local RPC request here. Its timeout can return
    // while teardown is still running, allowing the UI to attach a TUN too early.
    // Keep waiting (and holding the mutation lock) instead of cancelling cleanup.
    let stop = instances.delete_network_instances([id]);
    tokio::pin!(stop);
    let mut progress = tokio::time::interval(std::time::Duration::from_secs(5));
    progress.tick().await;
    loop {
        tokio::select! {
            result = &mut stop => { result.map_err(|e| e.to_string())?; break; }
            _ = progress.tick() => {
                tracing::warn!(target: "mobile_vpn", instance_id = %id,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    cancelled = !MOBILE_CONNECTION.allows(token), "recovery: waiting for core cleanup");
            }
        }
    }
    tracing::info!(target: "mobile_vpn", instance_id = %id,
        elapsed_ms = started.elapsed().as_millis() as u64, "recovery: old core cleanup completed");
    if !MOBILE_CONNECTION.allows(token) {
        tracing::info!(target: "mobile_vpn", instance_id = %id, "recovery cancelled by changed connection intent");
        return Ok(());
    }
    // Preserve the actual running config, its source and file permissions;
    // no-TUN instances and the management session are left intact.
    instances
        .run_network_instance(config, control)
        .map_err(|e| e.to_string())?;
    tracing::info!(target: "mobile_vpn", instance_id = %id, "recovery: replacement core started; awaiting TUN and health checks");
    manager.post_run_network_instance_hook(&app, &id).await
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileVpnDiagnostic {
    session: String,
    generation: u64,
    instance_id: Option<String>,
    phase: String,
    reason: String,
    peers: u32,
    routes: u32,
    recovery: u32,
    network_id: Option<String>,
    native_running: Option<bool>,
    fd: Option<i32>,
    peer_details: Option<Vec<MobilePeerDiagnostic>>,
    route_details: Option<Vec<MobileRouteDiagnostic>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Fields are consumed by the structured Debug log below.
struct MobilePeerDiagnostic {
    peer_id: u32,
    conn_id: String,
    latency_us: f64,
    loss_rate: f64,
    rx_packets: String,
    tx_packets: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct MobileRouteDiagnostic {
    peer_id: u32,
    next_hop: u32,
    cost: i32,
    version: String,
}

#[tauri::command]
fn log_mobile_vpn_diagnostic(snapshot: MobileVpnDiagnostic) {
    tracing::info!(target: "mobile_vpn", pid = std::process::id(),
        session = %snapshot.session, generation = snapshot.generation,
        instance_id = ?snapshot.instance_id, phase = %snapshot.phase, reason = %snapshot.reason,
        peers = snapshot.peers, routes = snapshot.routes, recovery = snapshot.recovery,
        network_id = ?snapshot.network_id, native_running = ?snapshot.native_running,
        fd = ?snapshot.fd, peer_details = ?snapshot.peer_details,
        route_details = ?snapshot.route_details, "VPN diagnostic");
}

// 获取日志目录的辅助函数
fn get_log_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, tauri::Error> {
    if cfg!(target_os = "android") {
        // Android: cache_dir + logs 子目录
        app.path().cache_dir().map(|p| p.join("logs"))
    } else {
        // 其他平台: 默认日志目录
        app.path().app_log_dir()
    }
}

#[tauri::command]
async fn get_log_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    match get_log_dir(&app) {
        Ok(log_dir) => {
            std::fs::create_dir_all(&log_dir).ok();
            Ok(log_dir.to_string_lossy().to_string())
        }
        Err(e) => Err(format!("Failed to get log directory: {}", e)),
    }
}

#[cfg(not(target_os = "android"))]
fn toggle_window_visibility(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or_default();
        let minimized = window.is_minimized().unwrap_or_default();
        let focused = window.is_focused().unwrap_or_default();

        let should_show = !visible || minimized || !focused;
        if should_show {
            if !visible {
                let _ = window.show();
            }
            if minimized {
                let _ = window.unminimize();
            }
            if !focused {
                let _ = window.set_focus();
            }
            let _ = set_dock_visibility(app.clone(), true);
        } else {
            let _ = window.hide();
            let _ = set_dock_visibility(app.clone(), false);
        }
    }
}

fn get_exe_path() -> String {
    if let Ok(appimage_path) = std::env::var("APPIMAGE")
        && !appimage_path.is_empty()
    {
        return appimage_path;
    }
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(not(target_os = "android"))]
fn check_sudo() -> bool {
    let is_elevated = elevate::Command::is_elevated();
    if !is_elevated {
        let exe_path = get_exe_path();
        let stdcmd = std::process::Command::new(&exe_path);
        elevate::Command::new(stdcmd)
            .output()
            .expect("Failed to run elevated command");
    }
    is_elevated
}

mod manager {
    use super::*;
    use async_trait::async_trait;
    use dashmap::{DashMap, DashSet};
    use easytier::common::config::{NetworkConfig, NetworkConfigExt};
    use easytier::proto::api::logger::{LoggerRpc, LoggerRpcClientFactory, SetLoggerConfigRequest};
    use easytier::proto::api::manage::RunNetworkInstanceRequest;
    use easytier::proto::rpc::bidirect::BidirectRpcManager;
    use easytier::proto::rpc_types::controller::BaseController;
    use easytier::web_client::WebClientHooks;
    use easytier_core::management::remote_client::PersistentConfig;

    pub(super) struct GuiHooks {
        pub(super) app: AppHandle,
        pub(super) epoch: u64,
        pub(super) intent: u64,
    }

    impl GuiHooks {
        fn is_current(&self) -> bool {
            self.epoch == super::WEB_CLIENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst)
                && (!cfg!(target_os = "android") || super::MOBILE_CONNECTION.allows(self.intent))
        }
    }

    #[async_trait]
    impl WebClientHooks for GuiHooks {
        fn skip_unchanged_config(&self) -> bool {
            cfg!(target_os = "android") && self.is_current()
        }

        async fn pre_run_network_instance(
            &self,
            cfg: &easytier::common::config::TomlConfigLoader,
        ) -> Result<(), String> {
            if !self.is_current() {
                return Err("Configuration connection was stopped or replaced".to_string());
            }
            let client_manager = get_client_manager!()?;
            client_manager
                .pre_run_network_instance_hook(
                    &self.app,
                    cfg,
                    PersistedConfigSource::from_runtime_source(cfg.get_network_config_source()),
                    RunOrigin::ConfigServer,
                )
                .await?;
            if !self.is_current() {
                return Err("Configuration connection was stopped or replaced".to_string());
            }
            Ok(())
        }

        async fn post_run_network_instance(&self, instance_id: &uuid::Uuid) -> Result<(), String> {
            if !self.is_current() {
                if let Some(manager) = super::INSTANCE_MANAGER.read().await.as_ref() {
                    manager
                        .delete_network_instances([*instance_id])
                        .await
                        .map_err(|e| e.to_string())?;
                }
                return Err("Configuration connection was stopped or replaced".to_string());
            }
            let client_manager = get_client_manager!()?;
            client_manager
                .post_run_network_instance_hook(&self.app, instance_id)
                .await
        }

        async fn post_remove_network_instances(&self, ids: &[uuid::Uuid]) -> Result<(), String> {
            if !self.is_current() {
                return Ok(());
            }
            let client_manager = get_client_manager!()?;
            client_manager
                .post_remote_remove_network_instances_hook(&self.app, ids)
                .await
        }
    }

    #[derive(Debug, Clone, Copy)]
    pub(super) enum RunOrigin {
        Local,
        // ProcessManagement already holds the instance mutation lock here.
        ConfigServer,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "snake_case")]
    #[derive(Default)]
    pub(super) enum PersistedConfigSource {
        User,
        #[serde(alias = "webhook")]
        Web,
        #[serde(other)]
        #[default]
        Legacy,
    }

    impl PersistedConfigSource {
        pub(super) fn from_runtime_source(source: ConfigSource) -> Self {
            match source {
                ConfigSource::User => Self::User,
                ConfigSource::Web => Self::Web,
            }
        }

        fn merge_persisted(self, incoming: Self) -> Self {
            match (self, incoming) {
                // Older runtimes report missing source as `user`. Keep the stronger persisted
                // ownership until web sync or an explicit user save repairs it.
                (Self::Web, Self::User) | (Self::Legacy, Self::User) => self,
                (_, next) => next,
            }
        }

        fn to_runtime_source(self) -> ConfigSource {
            match self {
                Self::User | Self::Legacy => ConfigSource::User,
                Self::Web => ConfigSource::Web,
            }
        }

        fn is_web_like(self) -> bool {
            matches!(self, Self::Web)
        }
    }

    #[derive(Clone)]
    pub(super) struct GUIConfig {
        inst_id: String,
        pub(crate) config: NetworkConfig,
        source: PersistedConfigSource,
    }

    #[derive(Clone, serde::Serialize, serde::Deserialize)]
    pub(super) struct StoredGuiConfig {
        config: NetworkConfig,
        #[serde(default)]
        source: PersistedConfigSource,
    }

    impl GUIConfig {
        fn new(inst_id: String, config: NetworkConfig, source: PersistedConfigSource) -> Self {
            Self {
                inst_id,
                config,
                source,
            }
        }

        fn into_stored(self) -> StoredGuiConfig {
            StoredGuiConfig {
                config: self.config,
                source: self.source,
            }
        }
    }

    impl PersistentConfig<anyhow::Error> for GUIConfig {
        fn get_network_inst_id(&self) -> &str {
            &self.inst_id
        }
        fn get_network_config(&self) -> Result<NetworkConfig, anyhow::Error> {
            Ok(self.config.clone())
        }
        fn get_network_config_source(&self) -> ConfigSource {
            self.source.to_runtime_source()
        }
    }

    pub(super) struct GUIStorage {
        network_configs: DashMap<Uuid, GUIConfig>,
        enabled_networks: DashSet<Uuid>,
    }
    impl GUIStorage {
        fn new() -> Self {
            Self {
                network_configs: DashMap::new(),
                enabled_networks: DashSet::new(),
            }
        }

        fn save_configs(&self, app: &AppHandle) -> anyhow::Result<()> {
            let configs = self
                .network_configs
                .iter()
                .map(|entry| entry.value().clone().into_stored())
                .collect::<Vec<_>>();
            app.emit("save_configs", configs)?;
            Ok(())
        }

        fn save_enabled_networks(&self, app: &AppHandle) -> anyhow::Result<()> {
            let payload: Vec<String> = self
                .enabled_networks
                .iter()
                .map(|entry| entry.key().to_string())
                .collect();
            app.emit("save_enabled_networks", payload)?;
            Ok(())
        }

        fn save_config(
            &self,
            app: &AppHandle,
            inst_id: Uuid,
            cfg: NetworkConfig,
            source: PersistedConfigSource,
        ) -> anyhow::Result<()> {
            let source = self
                .network_configs
                .get(&inst_id)
                .map(|existing| existing.source.merge_persisted(source))
                .unwrap_or(source);
            let config = GUIConfig::new(inst_id.to_string(), cfg, source);
            self.network_configs.insert(inst_id, config);
            self.save_configs(app)
        }
    }
    #[async_trait]
    impl Storage<AppHandle, GUIConfig, anyhow::Error> for GUIStorage {
        async fn insert_or_update_user_network_config(
            &self,
            app: AppHandle,
            network_inst_id: Uuid,
            network_config: NetworkConfig,
            source: ConfigSource,
        ) -> Result<(), anyhow::Error> {
            self.save_config(
                &app,
                network_inst_id,
                network_config,
                PersistedConfigSource::from_runtime_source(source),
            )?;
            self.enabled_networks.insert(network_inst_id);
            self.save_enabled_networks(&app)?;
            Ok(())
        }

        async fn delete_network_configs(
            &self,
            app: AppHandle,
            network_inst_ids: &[Uuid],
        ) -> Result<(), anyhow::Error> {
            for network_inst_id in network_inst_ids {
                self.network_configs.remove(network_inst_id);
                self.enabled_networks.remove(network_inst_id);
            }
            self.save_configs(&app)?;
            self.save_enabled_networks(&app)?;
            Ok(())
        }

        async fn update_network_config_state(
            &self,
            app: AppHandle,
            network_inst_id: Uuid,
            disabled: bool,
        ) -> Result<(), anyhow::Error> {
            if disabled {
                self.enabled_networks.remove(&network_inst_id);
            } else {
                self.enabled_networks.insert(network_inst_id);
            }
            self.save_enabled_networks(&app)?;
            Ok(())
        }

        async fn list_network_configs(
            &self,
            _: AppHandle,
            props: ListNetworkProps,
        ) -> Result<Vec<GUIConfig>, anyhow::Error> {
            let mut ret = Vec::new();
            for entry in self.network_configs.iter() {
                let id: Uuid = entry.key().to_owned();
                match props {
                    ListNetworkProps::All => {
                        ret.push(entry.value().clone());
                    }
                    ListNetworkProps::EnabledOnly => {
                        if self.enabled_networks.contains(&id) {
                            ret.push(entry.value().clone());
                        }
                    }
                    ListNetworkProps::DisabledOnly => {
                        if !self.enabled_networks.contains(&id) {
                            ret.push(entry.value().clone());
                        }
                    }
                }
            }
            Ok(ret)
        }

        async fn get_network_config(
            &self,
            _: AppHandle,
            network_inst_id: &str,
        ) -> Result<Option<GUIConfig>, anyhow::Error> {
            let uuid = Uuid::parse_str(network_inst_id)?;
            Ok(self
                .network_configs
                .get(&uuid)
                .map(|entry| entry.value().clone()))
        }
    }

    pub(super) struct GUIClientManager {
        pub(super) storage: GUIStorage,
        pub(super) rpc_manager: BidirectRpcManager,
    }
    impl GUIClientManager {
        pub async fn new(
            rpc_url: Option<String>,
            local_process_runtime: Option<Arc<CoreProcessRuntime>>,
        ) -> Result<Self, anyhow::Error> {
            let tunnel = if let Some(url) = rpc_url {
                runtime_rpc_dialer(url.parse()?).connect().await?
            } else {
                local_process_runtime
                    .context("local RPC requires a core process runtime")?
                    .connect_ring_tunnel(*RPC_RING_UUID.deref())?
            };

            let rpc_manager = BidirectRpcManager::new();
            rpc_manager.run_with_tunnel(tunnel);

            Ok(Self {
                storage: GUIStorage::new(),
                rpc_manager,
            })
        }

        pub fn get_enabled_instances_with_tun_ids(&self) -> impl Iterator<Item = uuid::Uuid> + '_ {
            self.storage
                .network_configs
                .iter()
                .filter(|v| self.storage.enabled_networks.contains(v.key()))
                .filter(|v| !v.config.no_tun())
                .filter_map(|c| c.config.instance_id().parse::<uuid::Uuid>().ok())
        }

        #[cfg(target_os = "android")]
        pub fn get_enabled_instances_with_web_like_tun_ids(
            &self,
        ) -> impl Iterator<Item = uuid::Uuid> + '_ {
            self.storage
                .network_configs
                .iter()
                .filter(|v| self.storage.enabled_networks.contains(v.key()))
                .filter(|v| !v.config.no_tun())
                .filter(|v| v.source.is_web_like())
                .filter_map(|c| c.config.instance_id().parse::<uuid::Uuid>().ok())
        }

        #[cfg(target_os = "android")]
        pub(super) async fn disable_instances_with_tun(
            &self,
            app: &AppHandle,
            web_only: bool,
        ) -> Result<(), easytier_core::management::remote_client::RemoteClientError<anyhow::Error>>
        {
            let inst_ids: Vec<uuid::Uuid> = if web_only {
                self.get_enabled_instances_with_web_like_tun_ids().collect()
            } else {
                self.get_enabled_instances_with_tun_ids().collect()
            };
            for inst_id in inst_ids {
                self.handle_update_network_state(app.clone(), inst_id, true)
                    .await?;
            }
            Ok(())
        }

        pub(super) fn notify_vpn_stop_if_no_tun(&self, app: &AppHandle) -> Result<(), String> {
            let has_tun = self.get_enabled_instances_with_tun_ids().any(|_| true);
            if !has_tun {
                app.emit("vpn_service_stop", "")
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }

        pub(super) async fn pre_run_network_instance_hook(
            &self,
            app: &AppHandle,
            cfg: &easytier::common::config::TomlConfigLoader,
            source: PersistedConfigSource,
            origin: RunOrigin,
        ) -> Result<(), String> {
            if cfg!(target_os = "android")
                && !cfg.get_flags().no_tun
                && !super::MOBILE_CONNECTION.enabled()
            {
                return Err("mobile_connection_stopped".to_string());
            }
            let instance_id = cfg.get_id();
            tracing::info!(target: "mobile_vpn", %instance_id, ?source, ?origin, "preparing network instance");

            // Keep this portable branch type-checked on desktop builds too.
            if cfg!(target_os = "android") && !cfg.get_flags().no_tun {
                let active: Vec<_> = self.get_enabled_instances_with_tun_ids().collect();
                // Check ownership before touching any running network. A web push
                // must not evict a user-owned VPN, including one with the same ID.
                if source.is_web_like()
                    && active.iter().any(|id| {
                        self.storage
                            .network_configs
                            .get(id)
                            .is_some_and(|c| !c.source.is_web_like())
                    })
                {
                    return Err("Android only supports one active TUN network; user-managed VPN remains active".to_string());
                }
                let other_ids: Vec<_> =
                    active.into_iter().filter(|id| *id != instance_id).collect();
                if !other_ids.is_empty() {
                    tracing::info!(target: "mobile_vpn", %instance_id, ?other_ids, ?origin, "stopping other TUN instances");
                    match origin {
                        RunOrigin::ConfigServer => {
                            let instances = super::INSTANCE_MANAGER
                                .read()
                                .await
                                .clone()
                                .ok_or("Local instance manager unavailable")?;
                            for id in &other_ids {
                                if instances
                                    .config_control(*id)
                                    .is_some_and(|c| !c.is_deletable())
                                {
                                    return Err(format!("TUN instance {id} cannot be stopped"));
                                }
                            }
                            // The caller holds the same lock used by local RPC.
                            // Await cleanup directly; a nested delete RPC would
                            // time out and leave a detached deletion queued behind us.
                            instances
                                .delete_network_instances(other_ids.clone())
                                .await
                                .map_err(|e| e.to_string())?;
                            for id in other_ids {
                                self.storage.enabled_networks.remove(&id);
                            }
                            self.storage
                                .save_enabled_networks(app)
                                .map_err(|e| e.to_string())?;
                        }
                        RunOrigin::Local => {
                            for id in other_ids {
                                self.handle_update_network_state(app.clone(), id, true)
                                    .await
                                    .map_err(|e| e.to_string())?;
                            }
                        }
                    }
                }
            }

            self.storage
                .save_config(
                    app,
                    instance_id,
                    NetworkConfig::new_from_config(cfg).map_err(|e| e.to_string())?,
                    source,
                )
                .map_err(|e| e.to_string())?;

            app.emit("pre_run_network_instance", instance_id.to_string())
                .map_err(|e| e.to_string())?;

            Ok(())
        }

        pub(super) async fn post_run_network_instance_hook(
            &self,
            app: &AppHandle,
            instance_id: &uuid::Uuid,
        ) -> Result<(), String> {
            #[cfg(target_os = "android")]
            if !super::MOBILE_CONNECTION.enabled()
                && self
                    .storage
                    .network_configs
                    .get(instance_id)
                    .is_some_and(|config| !config.config.no_tun())
            {
                if let Some(manager) = super::INSTANCE_MANAGER.read().await.as_ref() {
                    manager
                        .delete_network_instances([*instance_id])
                        .await
                        .map_err(|e| e.to_string())?;
                }
                return Err("mobile_connection_stopped".to_string());
            }
            #[cfg(target_os = "android")]
            if let Some(instance_manager) = super::INSTANCE_MANAGER.read().await.as_ref() {
                let instance_uuid = *instance_id;
                if let Some(instance) = instance_manager.instance(instance_uuid) {
                    if let Some(mut event_receiver) = subscribe_native_instance_event(&instance) {
                        let app_clone = app.clone();
                        let instance_id_clone = *instance_id;
                        tokio::spawn(async move {
                            let instance_id_str = instance_id_clone.to_string();
                            loop {
                                match event_receiver.recv().await {
                                    Ok(easytier::common::global_ctx::GlobalCtxEvent::DhcpIpv4Changed(_, _)) => {
                                        let _ = app_clone.emit("dhcp_ip_changed", &instance_id_str);
                                    }
                                    Ok(easytier::common::global_ctx::GlobalCtxEvent::ProxyCidrsUpdated(_, _)) => {
                                        let _ = app_clone.emit("proxy_cidrs_updated", &instance_id_str);
                                    }
                                    Ok(_) => {}
                                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                        break;
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                        let _ = app_clone.emit("event_lagged", &instance_id_str);
                                        event_receiver = event_receiver.resubscribe();
                                    }
                                }
                            }
                        });
                    }
                }
            }

            self.storage.enabled_networks.insert(*instance_id);

            app.emit("post_run_network_instance", instance_id.to_string())
                .map_err(|e| e.to_string())?;

            Ok(())
        }

        pub(super) async fn post_remote_remove_network_instances_hook(
            &self,
            app: &AppHandle,
            ids: &[uuid::Uuid],
        ) -> Result<(), String> {
            self.storage
                .delete_network_configs(app.clone(), ids)
                .await
                .map_err(|e| e.to_string())?;
            self.notify_vpn_stop_if_no_tun(app)?;
            Ok(())
        }

        pub(super) async fn post_stop_network_instances_hook(
            &self,
            app: &AppHandle,
        ) -> Result<(), String> {
            self.notify_vpn_stop_if_no_tun(app)?;
            Ok(())
        }

        fn get_logger_rpc_client(
            &self,
        ) -> Option<Box<dyn LoggerRpc<Controller = BaseController> + Send>> {
            Some(
                self.rpc_manager
                    .rpc_client()
                    .scoped_client::<LoggerRpcClientFactory<BaseController>>(1, 1, "".to_string()),
            )
        }

        pub(super) async fn set_logging_level(&self, level: String) -> Result<(), anyhow::Error> {
            let logger_rpc = self
                .get_logger_rpc_client()
                .ok_or_else(|| anyhow::anyhow!("Logger RPC client not available"))?;
            logger_rpc
                .set_logger_config(
                    BaseController::default(),
                    SetLoggerConfigRequest {
                        level: easytier_core::management::parse_log_level(&level).into(),
                    },
                )
                .await?;
            Ok(())
        }

        pub(super) async fn load_configs(
            &self,
            app: AppHandle,
            configs: Vec<StoredGuiConfig>,
            enabled_networks: Vec<String>,
        ) -> anyhow::Result<()> {
            self.storage.network_configs.clear();
            for stored in configs {
                let instance_id = stored.config.instance_id();
                self.storage.network_configs.insert(
                    instance_id.parse()?,
                    GUIConfig::new(instance_id.to_string(), stored.config, stored.source),
                );
            }

            self.storage.enabled_networks.clear();
            let client = self
                .get_rpc_client(app.clone())
                .ok_or_else(|| anyhow::anyhow!("RPC client not found"))?;
            for id in enabled_networks {
                if let Ok(uuid) = id.parse()
                    && !self.storage.enabled_networks.contains(&uuid)
                {
                    let config = self
                        .storage
                        .network_configs
                        .get(&uuid)
                        .map(|i| (i.value().config.clone(), i.value().source));
                    let Some((config, source)) = config else {
                        continue;
                    };
                    let toml_config = config.gen_config()?;
                    self.pre_run_network_instance_hook(
                        &app,
                        &toml_config,
                        source,
                        RunOrigin::Local,
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?;
                    client
                        .run_network_instance(
                            BaseController::default(),
                            RunNetworkInstanceRequest {
                                inst_id: None,
                                config: Some(config),
                                overwrite: false,
                                source: config_source_to_rpc(source.to_runtime_source()),
                            },
                        )
                        .await?;
                    self.post_run_network_instance_hook(&app, &uuid)
                        .await
                        .map_err(|e| anyhow::anyhow!(e))?;
                }
            }
            Ok(())
        }
    }
    impl RemoteClientManager<AppHandle, GUIConfig, anyhow::Error> for GUIClientManager {
        fn get_rpc_client(
            &self,
            _: AppHandle,
        ) -> Option<Box<dyn WebClientService<Controller = BaseController> + Send>> {
            Some(
                self.rpc_manager
                    .rpc_client()
                    .scoped_client::<WebClientServiceClientFactory<BaseController>>(
                        1,
                        1,
                        "".to_string(),
                    ),
            )
        }

        fn get_storage(&self) -> &impl Storage<AppHandle, GUIConfig, anyhow::Error> {
            &self.storage
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{PersistedConfigSource, StoredGuiConfig};
        use easytier::proto::api::manage::NetworkConfig;

        #[test]
        fn stored_gui_config_defaults_missing_source_to_legacy() {
            let stored: StoredGuiConfig = serde_json::from_value(serde_json::json!({
                "config": NetworkConfig::default(),
            }))
            .unwrap();
            assert_eq!(stored.source, PersistedConfigSource::Legacy);
        }

        #[test]
        fn stored_gui_config_deserializes_webhook_source_as_web() {
            let stored: StoredGuiConfig = serde_json::from_value(serde_json::json!({
                "config": NetworkConfig::default(),
                "source": "webhook",
            }))
            .unwrap();
            assert_eq!(stored.source, PersistedConfigSource::Web);
        }

        #[test]
        fn stored_gui_config_defaults_unknown_source_to_legacy() {
            let stored: StoredGuiConfig = serde_json::from_value(serde_json::json!({
                "config": NetworkConfig::default(),
                "source": "unknown",
            }))
            .unwrap();
            assert_eq!(stored.source, PersistedConfigSource::Legacy);
        }

        #[test]
        fn persisted_source_merge_keeps_legacy_and_web_over_ambiguous_user() {
            assert_eq!(
                PersistedConfigSource::Legacy.merge_persisted(PersistedConfigSource::User),
                PersistedConfigSource::Legacy
            );
            assert_eq!(
                PersistedConfigSource::Web.merge_persisted(PersistedConfigSource::User),
                PersistedConfigSource::Web
            );
            assert_eq!(
                PersistedConfigSource::Legacy.merge_persisted(PersistedConfigSource::Web),
                PersistedConfigSource::Web
            );
        }

        #[test]
        fn only_web_configs_are_web_like() {
            assert!(!PersistedConfigSource::Legacy.is_web_like());
            assert!(!PersistedConfigSource::User.is_web_like());
            assert!(PersistedConfigSource::Web.is_web_like());
        }
    }
}

#[cfg(not(target_os = "android"))]
mod service {
    use anyhow::Context;

    #[derive(Clone, serde::Serialize, serde::Deserialize)]
    pub struct ServiceOptions {
        pub(super) config_dir: String,
        pub(super) rpc_portal: String,
        pub(super) file_log_level: String,
        pub(super) file_log_dir: String,
        pub(super) config_server: Option<String>,
    }
    impl ServiceOptions {
        fn to_args_vec(&self) -> Vec<std::ffi::OsString> {
            let mut args = vec![
                "--config-dir".into(),
                self.config_dir.clone().into(),
                "--rpc-portal".into(),
                self.rpc_portal.clone().into(),
                "--file-log-level".into(),
                self.file_log_level.clone().into(),
                "--file-log-dir".into(),
                self.file_log_dir.clone().into(),
                "--daemon".into(),
            ];

            if let Some(config_server) = &self.config_server {
                args.push("--config-server".into());
                args.push(config_server.clone().into());
            }

            args
        }
    }

    #[cfg(target_os = "macos")]
    fn service_environment() -> Option<Vec<(String, String)>> {
        // System LaunchDaemons run as root but launchd does not provide HOME.
        Some(vec![("HOME".to_string(), "/var/root".to_string())])
    }

    #[cfg(not(target_os = "macos"))]
    fn service_environment() -> Option<Vec<(String, String)>> {
        None
    }

    pub fn install(opts: ServiceOptions) -> anyhow::Result<()> {
        let service = easytier::service_manager::Service::new(env!("CARGO_PKG_NAME").to_string())?;
        let options = easytier::service_manager::ServiceInstallOptions {
            program: super::get_exe_path().into(),
            args: opts.to_args_vec(),
            work_directory: std::env::current_dir()?,
            environment: service_environment(),
            disable_autostart: false,
            description: Some("EasyTier Gui Service".to_string()),
            display_name: Some("EasyTier Gui Service".to_string()),
            disable_restart_on_failure: false,
        };
        service
            .install(&options)
            .with_context(|| "Failed to install service")?;
        Ok(())
    }

    pub fn uninstall() -> anyhow::Result<()> {
        let service = easytier::service_manager::Service::new(env!("CARGO_PKG_NAME").to_string())?;
        service.uninstall()?;
        Ok(())
    }

    pub fn set_status(enable: bool) -> anyhow::Result<()> {
        use easytier::service_manager::*;
        let service = Service::new(env!("CARGO_PKG_NAME").to_string())?;
        let status = service.status()?;
        if enable && status != ServiceStatus::Running {
            service.start().with_context(|| "Failed to start service")?;
        } else if !enable && status == ServiceStatus::Running {
            service.stop().with_context(|| "Failed to stop service")?;
        } else if status == ServiceStatus::NotInstalled {
            return Err(anyhow::anyhow!("Service not installed"));
        }
        Ok(())
    }

    pub fn status() -> anyhow::Result<easytier::service_manager::ServiceStatus> {
        let service = easytier::service_manager::Service::new(env!("CARGO_PKG_NAME").to_string())?;
        service.status()
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn service_environment_matches_platform() {
            #[cfg(target_os = "macos")]
            assert_eq!(
                super::service_environment(),
                Some(vec![("HOME".to_string(), "/var/root".to_string())])
            );

            #[cfg(not(target_os = "macos"))]
            assert_eq!(super::service_environment(), None);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_gui() -> std::process::ExitCode {
    #[cfg(not(target_os = "android"))]
    if !check_sudo() {
        use std::process;
        process::exit(0);
    }

    setup_panic_handler();

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app.webview_windows()
                .values()
                .next()
                .expect("Sorry, no window found")
                .set_focus()
                .expect("Can't Bring Window to Focus");
        }));
    }

    builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_vpnservice::init());

    let app = builder
        .setup(|app| {
            // for logging config
            let Ok(log_dir) = get_log_dir(app.app_handle()) else {
                return Ok(());
            };
            let config = LoggingConfig::builder()
                .file_logger(FileLoggerConfig {
                    dir: Some(log_dir.to_string_lossy().to_string()),
                    level: cfg!(target_os = "android").then(|| "info".to_string()),
                    file: None,
                    size_mb: cfg!(target_os = "android").then_some(5),
                    count: cfg!(target_os = "android").then_some(3),
                })
                .build();
            let Ok(_) = log::init(&config, true) else {
                return Ok(());
            };
            tracing::info!(target: "mobile_vpn", pid = std::process::id(),
                version = easytier::VERSION, "application logging initialized");

            // for tray icon, menu need to be built in js
            #[cfg(not(target_os = "android"))]
            let _tray_menu = TrayIconBuilder::with_id("main")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        toggle_window_visibility(app);
                    }
                })
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/icon.png"
                ))?)
                .icon_as_template(true)
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_network_config,
            generate_network_config,
            run_network_instance,
            collect_network_info,
            get_vpn_portal_info,
            patch_vpn_portal_clients,
            set_logging_level,
            set_tun_fd,
            easytier_version,
            set_dock_visibility,
            list_network_instance_ids,
            remove_network_instance,
            update_network_config_state,
            save_network_config,
            validate_config,
            get_config,
            load_configs,
            get_network_metas,
            init_service,
            set_service_status,
            get_service_status,
            init_rpc_connection,
            is_client_running,
            init_web_client,
            mobile_connection_enabled,
            set_mobile_connection_enabled,
            restart_mobile_network,
            log_mobile_vpn_diagnostic,
            is_web_client_connected,
            get_log_dir_path,
        ])
        .on_window_event(|_win, event| match event {
            #[cfg(not(target_os = "android"))]
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = _win.hide();
                let _ = set_dock_visibility(_win.app_handle().clone(), false);
                api.prevent_close();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .unwrap();

    app.run(|_app, _event| {});

    std::process::ExitCode::SUCCESS
}

pub fn run_cli() -> std::process::ExitCode {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { easytier::core::main().await })
}
