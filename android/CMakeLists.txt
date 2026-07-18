project(Iroh)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME Iroh)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

# Enable Raw Props parsing in react-native (for Nitro Views)
add_compile_options(-DRN_SERIALIZABLE_STATE=1)

# Define C++ library and add all sources
add_library(${PACKAGE_NAME} SHARED
	src/main/cpp/cpp-adapter.cpp
)

# Add Nitrogen specs :)
# The Iroh implementation itself lives in Rust (rust/iroh-rn-core); the
# generated cmake below builds it with cargo and links the static library.
#
# Place the cargo-built static library inside the per-ABI CMake build dir so
# Ninja sees one consistent path for both the custom-command output and the
# link input. The generated default ("${CMAKE_SOURCE_DIR}/../target/<ABI>")
# contains a ".." segment that CMake normalizes differently in the two
# contexts, which breaks the dependency edge ("missing and no known rule").
set(NITRO_RUST_LIB_DIR "${CMAKE_CURRENT_BINARY_DIR}/rust")
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/Iroh+autolinking.cmake)

# Set up local includes
include_directories(
        "src/main/cpp"
)

find_library(LOG_LIB log)

# Link all libraries together
target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android                                   # <-- Android core
)
