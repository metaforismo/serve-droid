plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.servedroid.fixture"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.servedroid.fixture"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
}
