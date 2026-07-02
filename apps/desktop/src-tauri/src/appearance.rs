//! Native window appearance control (macOS).
//!
//! The app's light/dark theme is driven in the webview (CSS/daisyUI via the
//! `data-theme` attribute). macOS window **vibrancy** (`NSVisualEffectView`,
//! applied via the `window-vibrancy` crate) is a *native* layer that renders
//! according to the window's *effective* `NSAppearance` — which by default
//! follows the **system** light/dark setting, not our in-app theme. So if the
//! user picks Dark in-app while macOS is in Light mode, the translucent
//! background renders light (wrong).
//!
//! The fix is to set the main `NSWindow`'s `appearance` to match the in-app
//! theme, and to clear the override (set it to `nil`) for "system" mode so it
//! follows the OS again. The vibrancy material adapts to the effective
//! appearance automatically, so setting the window appearance is enough.

/// Set the main window's native appearance to match the in-app theme.
///
/// `theme` is one of `"light"`, `"dark"`, or `"system"`:
/// - `"light"`  → `NSAppearanceNameAqua`
/// - `"dark"`   → `NSAppearanceNameDarkAqua`
/// - `"system"` → clear the override (`nil`) so the window follows the OS.
///
/// macOS-only effect; a no-op on other platforms (see the stub below) so the
/// cross-platform build still compiles and the frontend can call it
/// unconditionally.
#[tauri::command]
pub fn set_window_appearance(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::set_window_appearance(&window, &theme)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Silence unused-variable warnings on non-macOS targets.
        let _ = (window, theme);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceName, NSAppearanceNameAqua,
        NSAppearanceNameDarkAqua, NSWindow,
    };

    /// Cast the Tauri window's `ns_window()` (a `*mut c_void` pointing at the
    /// underlying `NSWindow`) to an AppKit `NSWindow` and set its appearance.
    pub fn set_window_appearance(window: &tauri::WebviewWindow, theme: &str) -> Result<(), String> {
        // Resolve the desired appearance first so an unknown theme errors out
        // before we touch any native state. `None` => clear the override.
        let appearance: Option<Retained<NSAppearance>> = match theme {
            // SAFETY: these are AppKit-provided static `NSString` constants.
            "light" => named_appearance(unsafe { NSAppearanceNameAqua }),
            "dark" => named_appearance(unsafe { NSAppearanceNameDarkAqua }),
            "system" => None,
            other => return Err(format!("unknown theme: {other:?}")),
        };

        // `ns_window()` returns the raw NSWindow pointer for this window.
        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("failed to get ns_window: {e}"))?;
        if ns_window_ptr.is_null() {
            return Err("ns_window pointer was null".into());
        }

        // SAFETY: Tauri guarantees `ns_window()` returns a valid pointer to the
        // window's `NSWindow` for the lifetime of the window. We only borrow it
        // for the duration of this call (set the appearance and return) and do
        // not retain it, so the borrow can't outlive the window. AppKit
        // appearance APIs must run on the main thread; Tauri commands taking a
        // `WebviewWindow` are dispatched on the main thread.
        let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };

        // `setAppearance:` comes from the `NSAppearanceCustomization` protocol
        // (which `NSWindow` implements). Passing `None` clears the override so
        // the window follows the system appearance again.
        ns_window.setAppearance(appearance.as_deref());
        Ok(())
    }

    /// Look up a named system appearance (e.g. Aqua / DarkAqua). Returns `None`
    /// if AppKit doesn't recognise the name (shouldn't happen for the two
    /// built-in names we use, but we degrade gracefully rather than panic).
    fn named_appearance(name: &NSAppearanceName) -> Option<Retained<NSAppearance>> {
        // `appearanceNamed:` is a simple class lookup; it returns a retained
        // NSAppearance or nil. (objc2 exposes it as a safe method.)
        NSAppearance::appearanceNamed(name)
    }
}
