//! The crate's own FFI surface.
//!
//! All `unsafe` and every symbol exported to C++ lives here. The
//! nitrogen-generated method shims (in the `iroh_rust` crate) already wrap
//! trait calls in `catch_unwind`; this module guards the object factory the
//! same way so no panic can ever unwind across the boundary.

use std::sync::Arc;

use iroh_rust::hybrid_iroh_spec::HybridIrohSpec;

use crate::HybridIroh;

/// Factory called by the nitrogen-generated C++ bridge (`IrohOnLoad.cpp`) to
/// instantiate the Rust-backed `Iroh` HybridObject.
///
/// Returns a `Box<Arc<dyn HybridIrohSpec>>`: the outer Box provides a stable
/// thin pointer for C++, the inner Arc enables shared ownership. This function
/// never returns null: the generated consumer (`IrohOnLoad.cpp`) dereferences
/// the pointer in its destructor and method shims without a null check, so a
/// null return would be latent UB. The `catch_unwind` guards against a future
/// fallible constructor, but on panic the only sound response is to abort the
/// process rather than hand the consumer a null it cannot handle.
// SAFETY: `unsafe(no_mangle)` only asserts the symbol name is unique in the
// final binary; the exact name `create_HybridIrohSpec` is what the generated
// bridge resolves, and nothing else in the link defines it.
#[unsafe(no_mangle)]
pub extern "C" fn create_HybridIrohSpec() -> *mut std::ffi::c_void {
    let result = std::panic::catch_unwind(|| {
        let obj: Arc<dyn HybridIrohSpec> = Arc::new(HybridIroh::new());
        Box::into_raw(Box::new(obj)) as *mut std::ffi::c_void
    });
    match result {
        Ok(ptr) => ptr,
        Err(_) => {
            // The consumer does not null-check, so returning null is unsound.
            // Abort is the only safe failure mode.
            tracing::error!("panic while constructing HybridIroh; aborting");
            std::process::abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_returns_a_usable_object_pointer() {
        let ptr = create_HybridIrohSpec();
        assert!(!ptr.is_null());
        // SAFETY: `ptr` was produced by `Box::into_raw(Box::new(Arc<dyn ...>))`
        // just above; reconstructing the Box exactly once frees it correctly.
        let obj = unsafe { Box::from_raw(ptr as *mut Arc<dyn HybridIrohSpec>) };
        assert_eq!(obj.memory_size(), 0);
    }
}
