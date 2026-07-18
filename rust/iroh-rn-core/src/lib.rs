// The crate is named `Iroh_rust` so cargo emits `libIroh_rust.a`, which the
// nitrogen-generated CMake links by that exact name.
#![allow(non_snake_case)]

mod hybrid_iroh;

use std::sync::Arc;

use iroh_rust::hybrid_iroh_spec::HybridIrohSpec;

pub use hybrid_iroh::HybridIroh;

/// Factory called by the nitrogen-generated C++ bridge (`IrohOnLoad.cpp`) to
/// instantiate the Rust-backed `Iroh` HybridObject.
///
/// Returns a `Box<Arc<dyn HybridIrohSpec>>` — the outer Box provides a stable
/// thin pointer for C++, the inner Arc enables shared ownership.
#[unsafe(no_mangle)]
pub extern "C" fn create_HybridIrohSpec() -> *mut std::ffi::c_void {
    let obj: Arc<dyn HybridIrohSpec> = Arc::new(HybridIroh::new());
    Box::into_raw(Box::new(obj)) as *mut std::ffi::c_void
}
