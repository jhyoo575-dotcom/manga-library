plugins {
    id("com.android.application")
    kotlin("android")
}

/*
 * Template build file.
 *
 * In a real Mihon/Keiyoushi extension repository, use that repository's
 * extension Gradle plugin/module conventions instead of this standalone file.
 */

android {
    namespace = "eu.kanade.tachiyomi.extension.all.mangalibrary"
    compileSdk = 35

    defaultConfig {
        applicationId = "eu.kanade.tachiyomi.extension.all.mangalibrary"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }
}

