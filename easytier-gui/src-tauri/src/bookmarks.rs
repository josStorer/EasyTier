use std::{io, net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, OnceCell},
    task::JoinSet,
};

static PROXY_PORT: OnceCell<u16> = OnceCell::const_new();
static OPEN_LOCK: Mutex<()> = Mutex::const_new(());

#[tauri::command]
pub async fn open_bookmark(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Bookmarks can only be opened from the main window".into());
    }
    let id = uuid::Uuid::parse_str(&id)
        .map_err(|_| "Invalid bookmark ID")?
        .to_string();
    let _opening = OPEN_LOCK.lock().await;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        use tauri_plugin_vpnservice::VpnserviceExt;
        let port = *PROXY_PORT
            .get_or_try_init(start_proxy)
            .await
            .map_err(|_| "Could not start bookmark transport")?;
        let app = window.app_handle();
        // Native activities own the one-page-per-bookmark rule. A failed Tauri
        // window can outlive its activity, so never reuse a failed window label.
        let label = format!("bookmark-{id}-{}", uuid::Uuid::new_v4());
        tracing::info!(bookmark_id = %id, window_label = %label, "bookmark launch requested");
        let prepared = app
            .vpnservice()
            .prepare_bookmark(id.clone(), label.clone(), port)
            .map_err(|e| {
                tracing::warn!(window_label = %label, error = %e, "bookmark preparation failed");
                e.to_string()
            })?;
        if prepared.resumed {
            tracing::info!(bookmark_id = %id, "bookmark activity resumed");
            return Ok(());
        }
        let url = prepared
            .url
            .as_deref()
            .ok_or("Missing bookmark URL")?
            .parse::<url::Url>()
            .map_err(|_| "Invalid URL")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Only HTTP(S) pages are supported".into());
        }
        let gui_origin = window.url().map_err(|e| e.to_string())?.origin();
        let result =
            tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
                .title(prepared.name.as_deref().unwrap_or("Bookmark"))
                // Tao prefixes the application package and matches the parent
                // using Activity.getLocalClassName(), not a fully qualified name.
                .activity_name("BookmarkActivity")
                .created_by_activity_name("MainActivity")
                .on_navigation(move |url| {
                    (matches!(url.scheme(), "http" | "https") && url.origin() != gui_origin)
                        || url.as_str() == "about:blank"
                })
                .build();
        let page = match result {
            Ok(page) => page,
            Err(error) => {
                let _ = app.vpnservice().cancel_bookmark(label.clone());
                tracing::warn!(window_label = %label, error = %error, "bookmark window creation failed");
                return Err(error.to_string());
            }
        };
        // build() returning is not proof that the Android WebView attached.
        if let Err(error) = app.vpnservice().await_bookmark(id, label.clone()) {
            let _ = app.vpnservice().cancel_bookmark(label.clone());
            let _ = page.destroy();
            tracing::warn!(window_label = %label, error = %error, "bookmark activity failed to become ready");
            return Err(error.to_string());
        }
        tracing::info!(window_label = %label, "bookmark activity ready");
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = id;
        Err("Bookmark activities are available on Android".into())
    }
}

// Android excludes EasyTier's UID from its own VPN. WebView requests therefore
// use this loopback-only SOCKS bridge into the core, rather than changing VPN
// routing for the transport sockets. Public destinations fall back to host TCP.
async fn start_proxy() -> io::Result<u16> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                accepted = listener.accept(), if tasks.len() < 64 => {
                    let Ok((mut stream, _)) = accepted else { break };
                    tasks.spawn(async move {
                        let target = tokio::time::timeout(Duration::from_secs(10), socks_target(&mut stream)).await;
                        let Ok(Ok((host, target_port))) = target else { return };
                        let connected = tokio::time::timeout(Duration::from_secs(12), connect(&host, target_port, port)).await;
                        let Ok(Ok(mut remote)) = connected else {
                            let _ = stream.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                            return;
                        };
                        if stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_ok() {
                            let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
                        }
                    });
                }
            }
        }
        tasks.abort_all();
    });
    Ok(port)
}

trait ProxyStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ProxyStream for T {}

async fn connect(host: &str, port: u16, proxy_port: u16) -> anyhow::Result<Box<dyn ProxyStream>> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await?.collect();
    let manager = super::INSTANCE_MANAGER.read().await.clone();
    for address in addresses {
        if address.ip().is_loopback() && address.port() == proxy_port {
            continue;
        }
        // Core data-plane TCP currently supports IPv4. IPv6 websites continue
        // through the host network instead of failing before IPv4 fallback.
        if let Some(manager) = &manager
            && address.is_ipv4()
        {
            for id in manager.instance_ids() {
                let Some(instance) = manager.instance(id) else {
                    continue;
                };
                match instance
                    .data_plane_tcp_connect(address, Duration::from_secs(10))
                    .await
                {
                    Ok(stream) => return Ok(Box::new(stream)),
                    Err(error)
                        if error.kind()
                            == easytier_core::gateway::DataPlaneErrorKind::NoOverlayRoute => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        if let Ok(Ok(stream)) =
            tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(address)).await
        {
            return Ok(Box::new(stream));
        }
    }
    anyhow::bail!("Bookmark destination is unavailable")
}

async fn socks_target(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
) -> io::Result<(String, u16)> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Invalid SOCKS CONNECT request");
    if stream.read_u8().await? != 5 {
        return Err(invalid());
    }
    let count = stream.read_u8().await? as usize;
    let mut methods = vec![0; count];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 255]).await?;
        return Err(invalid());
    }
    stream.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    if header[..3] != [5, 1, 0] {
        return Err(invalid());
    }
    let host = match header[3] {
        1 => {
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).await?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            stream.read_exact(&mut bytes).await?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let size = stream.read_u8().await? as usize;
            if size == 0 {
                return Err(invalid());
            }
            let mut bytes = vec![0; size];
            stream.read_exact(&mut bytes).await?;
            String::from_utf8(bytes).map_err(|_| invalid())?
        }
        _ => return Err(invalid()),
    };
    let port = stream.read_u16().await?;
    if port == 0 {
        return Err(invalid());
    }
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bookmark_socks_forwards_real_http_without_an_overlay() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = server.local_addr().unwrap().port();
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
        let serving = tokio::spawn(async move {
            let (mut stream, _) = server.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"GET / HTTP/1.1"));
            stream.write_all(response).await.unwrap();
        });
        let port = start_proxy().await.unwrap();
        let mut browser = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        browser.write_all(&[5, 1, 0]).await.unwrap();
        let mut auth = [0; 2];
        browser.read_exact(&mut auth).await.unwrap();
        assert_eq!(auth, [5, 0]);
        browser
            .write_all(&[5, 1, 0, 1, 127, 0, 0, 1])
            .await
            .unwrap();
        browser.write_u16(target_port).await.unwrap();
        let mut accepted = [0; 10];
        browser.read_exact(&mut accepted).await.unwrap();
        assert_eq!(accepted[1], 0);
        browser
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut received = vec![0; response.len()];
        tokio::time::timeout(Duration::from_secs(3), browser.read_exact(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received, response);
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn bookmark_socks_stream_parses_fragmented_requests_and_preserves_payload() {
        let (mut browser, mut proxy) = tokio::io::duplex(128);
        let request = tokio::spawn(async move {
            browser.write_all(&[5, 1, 0]).await.unwrap();
            let mut response = [0; 2];
            browser.read_exact(&mut response).await.unwrap();
            assert_eq!(response, [5, 0]);
            for byte in [5, 1, 0, 1, 10, 144, 0, 1, 16, 221] {
                browser.write_u8(byte).await.unwrap();
            }
            browser.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        });
        assert_eq!(
            socks_target(&mut proxy).await.unwrap(),
            ("10.144.0.1".into(), 4317)
        );
        let mut payload = Vec::new();
        proxy.read_to_end(&mut payload).await.unwrap();
        assert_eq!(payload, b"GET / HTTP/1.1\r\n");
        request.await.unwrap();
    }

    #[tokio::test]
    async fn bookmark_socks_rejects_udp_and_unsupported_authentication() {
        for request in [&[5, 1, 2][..], &[5, 1, 0, 5, 3, 0, 1][..]] {
            let (mut browser, mut proxy) = tokio::io::duplex(128);
            browser.write_all(request).await.unwrap();
            assert!(socks_target(&mut proxy).await.is_err());
        }
    }
}
