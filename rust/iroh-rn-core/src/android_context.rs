//! Installs the Android JNI context that the iroh stack reads DNS config from.
//!
//! `iroh-dns` asks `ndk_context::android_context()` for the `JavaVM` and
//! `Context` so it can read the system resolver. `ndk_context` **panics** when
//! nothing has installed one ("android context was not initialized"), and that
//! panic happens inside whichever task triggered the lookup. On this stack the
//! consequence is not a failed lookup: the task dies mid-flight, and if it was
//! holding blob-store state that state is left unloadable, after which
//! `iroh-blobs` marks it poisoned and every later request for that hash panics.
//!
//! Changing networks is what makes it bite, because that forces a fresh resolve.
//! Without a context installed, iroh only warns on the happy path (falling back
//! to Google's resolvers, which silently degrades discovery) and panics on the
//! unhappy one.
//!
//! The C++ side owns the JNI handles, because that is where `JNI_OnLoad` hands
//! over the `JavaVM`; this module is only the doorway into `ndk_context`.

/// Receives the `JavaVM` and Android `Context` from the JNI layer.
///
/// Both pointers must outlive the process: `ndk_context` stores them for the
/// program's lifetime, so the caller is required to pass a `JavaVM` (which is
/// process-global) and a JNI **global** reference to the context.
///
/// # Safety
///
/// `vm` must be a valid `JavaVM*` and `context` a valid JNI global reference to
/// an `android.content.Context`. Passing a local reference, or a null pointer,
/// leaves the iroh stack dereferencing freed or absent JNI state.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn iroh_rn_install_android_context(
    vm: *mut std::os::raw::c_void,
    context: *mut std::os::raw::c_void,
) {
    if vm.is_null() || context.is_null() {
        tracing::error!("refusing to install a null Android context");
        return;
    }
    // `initialize_android_context` panics if called twice, and the host may load
    // the library more than once in a process (React Native reloads do this).
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        ndk_context::initialize_android_context(vm, context);
        tracing::debug!("android JNI context installed; system DNS config is readable");
    });
}
