plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun requiredProperty(name: String): String =
    providers.gradleProperty(name).orNull ?: throw GradleException("Missing build property $name")

fun quoted(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "dev.inconnuboy.apkbuilder.template"
    compileSdk = 34

    defaultConfig {
        applicationId = requiredProperty("inconnu.applicationId")
        minSdk = 24
        targetSdk = 34
        versionCode = requiredProperty("inconnu.versionCode").toInt()
        versionName = requiredProperty("inconnu.versionName")
        manifestPlaceholders["screenOrientation"] = requiredProperty("inconnu.orientation")
        buildConfigField("String", "START_URL", quoted(requiredProperty("inconnu.startUrl")))
        buildConfigField("String", "ALLOWED_HOST", quoted(requiredProperty("inconnu.allowedHost")))
        buildConfigField("boolean", "REMOTE", requiredProperty("inconnu.remote").toBoolean().toString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
