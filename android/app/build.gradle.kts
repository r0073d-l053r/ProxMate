plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app's version follows the ProxMate release it was built from.
val proxmateVersion: String = rootProject.file("../backend/package.json")
    .takeIf { it.isFile }
    ?.readText()
    ?.let { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)?.groupValues?.get(1) }
    ?: "1.3.0"

// Release signing comes from the environment (set by CI from repository secrets);
// without it, assembleRelease produces an unsigned APK.
val releaseKeystore: java.io.File? = System.getenv("ANDROID_KEYSTORE_PATH")
    ?.takeIf { it.isNotBlank() }
    ?.let { file(it) }
    ?.takeIf { it.isFile }

android {
    namespace = "host.proxmate.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "host.proxmate.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = proxmateVersion
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseKeystore != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    testImplementation("junit:junit:4.13.2")
    // The real org.json for JVM unit tests (android.jar only has stubs).
    testImplementation("org.json:json:20240303")
}
