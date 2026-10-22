//! What the update check needs to know about this install (the web side picks the release file from it).

use serde::Serialize;

/// The running build: OS and CPU architecture as Rust names them (`std::env::consts`), and whether the app runs
/// from an AppImage (Linux), which is the only Linux bundle that can be updated by downloading one file.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct UpdateTarget {
    pub os: &'static str,
    pub arch: &'static str,
    pub appimage: bool,
}

/// Maps `std::env::consts::OS` to the names the web side uses.
pub fn target_for(os: &'static str, arch: &'static str, appimage: bool) -> UpdateTarget {
    let os = match os {
        "windows" => "windows",
        "macos" => "macos",
        "android" => "android",
        _ => "linux",
    };
    UpdateTarget {
        os,
        arch,
        appimage: os == "linux" && appimage,
    }
}

#[tauri::command]
pub fn update_target() -> UpdateTarget {
    target_for(
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::var_os("APPIMAGE").is_some(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_os_names() {
        assert_eq!(
            target_for("windows", "x86_64", true),
            UpdateTarget {
                os: "windows",
                arch: "x86_64",
                appimage: false
            }
        );
        assert_eq!(target_for("macos", "aarch64", false).os, "macos");
        assert_eq!(target_for("android", "arm", false).os, "android");
        assert_eq!(
            target_for("linux", "x86_64", true),
            UpdateTarget {
                os: "linux",
                arch: "x86_64",
                appimage: true
            }
        );
        assert_eq!(target_for("freebsd", "x86_64", false).os, "linux");
    }

    #[test]
    fn reports_this_build() {
        let t = update_target();
        assert_eq!(t.arch, std::env::consts::ARCH);
    }
}
