use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    tauri_build::build();

    // steam_api64.dll must sit next to the .exe (Windows loads it at process start).
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let target_dir = manifest_dir.join("target").join(&profile);

    for name in ["steam_api64.dll", "steam_appid.txt"] {
        let src = manifest_dir.join(name);
        if !src.exists() {
            println!("cargo:warning=Missing {} — Steam builds need this file in src-tauri/", name);
            continue;
        }
        let _ = fs::create_dir_all(&target_dir);
        let dst = target_dir.join(name);
        if let Err(e) = fs::copy(&src, &dst) {
            println!("cargo:warning=Could not copy {} → {:?}: {}", name, dst, e);
        }
    }

    println!("cargo:rerun-if-changed=steam_api64.dll");
    println!("cargo:rerun-if-changed=steam_appid.txt");
    println!("cargo:rerun-if-changed=windows/hooks.nsh");

    // Help the linker find steam_api64.lib if present next to the redistributable.
    let lib_dir = find_steam_lib_dir(&manifest_dir);
    if let Some(dir) = lib_dir {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }
}

fn find_steam_lib_dir(manifest: &Path) -> Option<PathBuf> {
    // Prefer local copy folder
    if manifest.join("steam_api64.dll").exists() {
        return Some(manifest.to_path_buf());
    }
    None
}
