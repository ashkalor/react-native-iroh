//! Handle registry: maps opaque `u64` handles to live objects.
//!
//! The FFI boundary never passes Rust objects to the host language: it passes
//! numeric handles allocated by a [`Registry`]. Handles start at `1` (so `0`
//! can safely mean "no handle" on the JS side) and are never reused.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
};

use crate::error::{IrohError, Result};

/// A concurrent map from opaque `u64` handles to shared objects.
#[derive(Debug)]
pub struct Registry<T> {
    items: RwLock<HashMap<u64, Arc<T>>>,
    next: AtomicU64,
}

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Registry<T> {
    /// Creates an empty registry. The first allocated handle is `1`.
    pub fn new() -> Self {
        Self {
            items: RwLock::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }

    /// Stores `value` and returns its freshly allocated handle.
    pub fn insert(&self, value: T) -> u64 {
        let handle = self.next.fetch_add(1, Ordering::Relaxed);
        self.write().insert(handle, Arc::new(value));
        handle
    }

    /// Returns the object for `handle`, or [`IrohError::InvalidHandle`].
    pub fn get(&self, handle: u64) -> Result<Arc<T>> {
        self.read()
            .get(&handle)
            .cloned()
            .ok_or(IrohError::InvalidHandle(handle))
    }

    /// Removes and returns the object for `handle`, or
    /// [`IrohError::InvalidHandle`]. The handle is invalid from this point on.
    pub fn remove(&self, handle: u64) -> Result<Arc<T>> {
        self.write()
            .remove(&handle)
            .ok_or(IrohError::InvalidHandle(handle))
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<u64, Arc<T>>> {
        // A poisoned lock means a panic while holding the guard; the map
        // itself (insert/remove of Arcs) cannot be left in a torn state.
        self.items.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<u64, Arc<T>>> {
        self.items.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_then_get_returns_same_object() {
        let registry = Registry::new();
        let handle = registry.insert("endpoint".to_owned());
        assert_eq!(*registry.get(handle).unwrap(), "endpoint");
    }

    #[test]
    fn handles_start_at_one_and_are_unique() {
        let registry = Registry::new();
        let a = registry.insert(1);
        let b = registry.insert(2);
        assert_eq!(a, 1);
        assert_ne!(a, b);
    }

    #[test]
    fn get_unknown_handle_is_invalid_handle_error() {
        let registry = Registry::<u8>::new();
        match registry.get(99) {
            Err(IrohError::InvalidHandle(99)) => {}
            other => panic!("expected InvalidHandle(99), got {other:?}"),
        }
    }

    #[test]
    fn remove_invalidates_handle_without_reuse() {
        let registry = Registry::new();
        let handle = registry.insert("x");
        registry.remove(handle).unwrap();
        assert!(matches!(
            registry.get(handle),
            Err(IrohError::InvalidHandle(_))
        ));
        // A later insert must not resurrect the old handle.
        let fresh = registry.insert("y");
        assert_ne!(fresh, handle);
    }
}
