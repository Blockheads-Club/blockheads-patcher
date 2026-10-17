//! Process entry glue: needs the real `generate_context!()` and a native event loop, which cannot run
//! under unit tests. Everything testable lives in `lib.rs` (`configure`). This file is excluded from the
//! coverage gate by name (see scripts/coverage-rust.sh) and must stay logic-free.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::configure(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Blockheads Patcher");
}
