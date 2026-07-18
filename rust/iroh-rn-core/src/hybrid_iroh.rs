use iroh_rust::hybrid_iroh_spec::HybridIrohSpec;

/// Phase 0 stub implementation of the `Iroh` HybridObject.
/// Will hold a real iroh endpoint in later phases.
pub struct HybridIroh;

impl HybridIroh {
    pub fn new() -> Self {
        Self
    }
}

impl HybridIrohSpec for HybridIroh {
    fn node_id(&self) -> Result<String, String> {
        Ok("stub-node-id-phase0".to_owned())
    }
}
