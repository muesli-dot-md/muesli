fn main() {
    // The `screencapturekit` / `apple-*` crates link Swift, whose binary
    // references `@rpath/libswift_Concurrency.dylib`. macOS 12+ ships that
    // library in the OS Swift runtime (dyld shared cache) under
    // `/usr/lib/swift`, but that directory is not a default rpath, so the
    // executable fails to launch with a dyld "Library not loaded" error.
    // Add `/usr/lib/swift` to the binary's rpath so it resolves from the OS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build()
}
