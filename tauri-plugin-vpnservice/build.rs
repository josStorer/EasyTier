const COMMANDS: &[&str] = &[
    "ping",
    "prepare_vpn",
    "start_vpn",
    "stop_vpn",
    "get_vpn_status",
    "consume_vpn_tile_action",
    "registerListener",
    "list_bookmarks",
    "save_bookmark",
    "select_bookmark",
    "delete_bookmark",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
