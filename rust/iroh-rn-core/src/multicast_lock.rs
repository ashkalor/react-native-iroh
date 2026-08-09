//! Holds an Android `WifiManager.MulticastLock` for the lifetime of mDNS.
//!
//! Android drops inbound multicast/broadcast Wi-Fi packets to save power unless
//! an app holds a [`MulticastLock`]. The `swarm-discovery` sockets underneath
//! [`crate::mdns`] speak DNS-SD over multicast, so without the lock a device
//! neither answers nor hears `_irohv1._udp.local` on the LAN. The library owns
//! the lock (rather than the consumer) because the library is what turns mDNS
//! on; it ships the matching `CHANGE_WIFI_MULTICAST_STATE` permission in its own
//! manifest.
//!
//! The lock is acquired through the JNI context the C++ layer installed into
//! `ndk_context` (see [`crate::android_context`]) and released when the guard is
//! dropped, which is tied to endpoint close (the guard lives in the endpoint's
//! mDNS state). It is reference-counted, so nested acquisitions are balanced.
//!
//! Foreground-only: under Doze / app standby the OS may still suspend Wi-Fi and
//! multicast regardless of this lock, so discovery is only dependable while the
//! app is in the foreground.
//!
//! On non-Android targets (the host build, iOS) [`acquire`] is a no-op: only
//! Android gates multicast behind a lock, and the whole module compiles only
//! under the `mdns` feature.

/// A held multicast lock. Releasing happens on drop.
pub(crate) struct MulticastLockGuard {
    #[cfg(target_os = "android")]
    inner: android::Held,
}

/// Acquires the multicast lock, returning a guard that releases it on drop, or
/// `None` when no lock is needed or one could not be taken.
///
/// A failure to acquire (no JNI context yet, a JNI error) is logged and degrades
/// to `None` rather than failing endpoint creation: mDNS then still runs, just
/// without multicast reception until a lock is held, which is strictly better
/// than refusing to create the endpoint.
#[cfg(target_os = "android")]
pub(crate) fn acquire() -> Option<MulticastLockGuard> {
    match android::acquire() {
        Ok(inner) => Some(MulticastLockGuard { inner }),
        Err(detail) => {
            tracing::warn!("could not acquire Wi-Fi multicast lock for mDNS: {detail}");
            None
        }
    }
}

/// No-op on non-Android targets: nothing gates multicast there.
#[cfg(not(target_os = "android"))]
pub(crate) fn acquire() -> Option<MulticastLockGuard> {
    None
}

#[cfg(target_os = "android")]
mod android {
    use jni::{
        objects::{GlobalRef, JObject, JValue},
        JavaVM,
    };

    /// The tag passed to `createMulticastLock`; shows up in dumpsys.
    const LOCK_TAG: &str = "iroh-mdns";

    /// A held lock plus the VM needed to release it on drop.
    pub(super) struct Held {
        vm: JavaVM,
        lock: GlobalRef,
    }

    /// Reaches the installed JNI context, creates a reference-counted
    /// `WifiManager.MulticastLock`, and acquires it.
    pub(super) fn acquire() -> Result<Held, String> {
        let ctx = ndk_context::android_context();
        // SAFETY: the C++ layer installed a real `JavaVM*` and a JNI global ref
        // to the Application context (see `crate::android_context`), both valid
        // for the process lifetime.
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("java vm unavailable: {e}"))?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach thread: {e}"))?;

        let service = env
            .new_string("wifi")
            .map_err(|e| format!("wifi service name: {e}"))?;
        let wifi_manager = env
            .call_method(
                &context,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&service).into()],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("getSystemService(wifi): {e}"))?;
        if wifi_manager.is_null() {
            return Err("WifiManager is unavailable on this device".into());
        }

        let tag = env
            .new_string(LOCK_TAG)
            .map_err(|e| format!("lock tag: {e}"))?;
        let lock = env
            .call_method(
                &wifi_manager,
                "createMulticastLock",
                "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
                &[(&tag).into()],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("createMulticastLock: {e}"))?;

        env.call_method(&lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(1)])
            .map_err(|e| format!("setReferenceCounted: {e}"))?;
        env.call_method(&lock, "acquire", "()V", &[])
            .map_err(|e| format!("acquire: {e}"))?;

        let lock = env
            .new_global_ref(&lock)
            .map_err(|e| format!("retain lock: {e}"))?;
        tracing::debug!("acquired Wi-Fi multicast lock for mDNS");
        Ok(Held { vm, lock })
    }

    impl Drop for Held {
        fn drop(&mut self) {
            let mut env = match self.vm.attach_current_thread() {
                Ok(env) => env,
                Err(e) => {
                    tracing::warn!("could not attach to release multicast lock: {e}");
                    return;
                }
            };
            if let Err(e) = env.call_method(self.lock.as_obj(), "release", "()V", &[]) {
                tracing::warn!("releasing multicast lock failed: {e}");
            } else {
                tracing::debug!("released Wi-Fi multicast lock");
            }
        }
    }
}
