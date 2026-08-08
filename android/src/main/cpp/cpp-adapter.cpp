#include <jni.h>
#include <fbjni/fbjni.h>
#include <android/log.h>
#include "IrohOnLoad.hpp"

// Implemented in rust/iroh-rn-core/src/android_context.rs.
extern "C" void iroh_rn_install_android_context(void* vm, void* context);

namespace {

/// Hands the Rust core a `JavaVM` and the process's Application object.
///
/// The iroh stack reads the system DNS config through `ndk_context`, which
/// panics outright if no context was installed, so this has to happen before any
/// endpoint exists. The Application is fetched via
/// `ActivityThread.currentApplication()` rather than passed down from Kotlin:
/// `JNI_OnLoad` is the only hook guaranteed to run before the core is reachable,
/// and it receives no context of its own.
void installAndroidContext(JavaVM* vm, JNIEnv* env) {
  jclass activityThread = env->FindClass("android/app/ActivityThread");
  if (activityThread == nullptr) {
    env->ExceptionClear();
    __android_log_write(ANDROID_LOG_ERROR, "IrohRust",
                        "ActivityThread not found; system DNS config stays unreadable");
    return;
  }
  jmethodID currentApplication = env->GetStaticMethodID(
      activityThread, "currentApplication", "()Landroid/app/Application;");
  if (currentApplication == nullptr) {
    env->ExceptionClear();
    __android_log_write(ANDROID_LOG_ERROR, "IrohRust",
                        "ActivityThread.currentApplication() not found");
    return;
  }
  jobject application = env->CallStaticObjectMethod(activityThread, currentApplication);
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
    application = nullptr;
  }
  if (application == nullptr) {
    // The library can be loaded before the Application is constructed. iroh then
    // keeps its warn-and-fall-back-to-Google-DNS behaviour, which is degraded
    // but not fatal.
    __android_log_write(ANDROID_LOG_WARN, "IrohRust",
                        "no Application yet; system DNS config stays unreadable");
    return;
  }
  // ndk_context keeps both pointers for the life of the process, so the context
  // reference has to be global rather than the local ref returned above.
  jobject global = env->NewGlobalRef(application);
  env->DeleteLocalRef(application);
  iroh_rn_install_android_context(vm, global);
}

} // namespace

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [vm]() {
    margelo::nitro::iroh::registerAllNatives();
    JNIEnv* env = facebook::jni::Environment::current();
    if (env != nullptr) {
      installAndroidContext(vm, env);
    }
  });
}
