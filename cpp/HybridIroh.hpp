#pragma once
#include <vector>
#include "HybridIrohSpec.hpp"

namespace margelo::nitro::iroh {
class HybridIroh : public HybridIrohSpec {
    public:
        HybridIroh() : HybridObject(TAG), HybridIrohSpec() {}
       
        double sum(double a, double b) override;
    };
} // namespace margelo::nitro::iroh
