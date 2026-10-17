plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    jacoco
}
android {
    namespace = "com.blockheadspatcher.apktools"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
}
dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("org.mockito:mockito-core:5.14.2")
    testImplementation("org.mockito.kotlin:mockito-kotlin:5.4.0")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
}

jacoco { toolVersion = "0.8.12" }

// Robolectric loads classes through its own sandbox classloader; JaCoCo must instrument them there too.
tasks.withType<Test>().configureEach {
    extensions.configure<JacocoTaskExtension> {
        isIncludeNoLocationClasses = true
        excludes = listOf("jdk.internal.*")
    }
    // Robolectric needs the Android-all jars (cached by Gradle); a JDK 17/21 toolchain is required.
    maxHeapSize = "1g"
}

val jacocoClasses = fileTree(layout.buildDirectory.dir("tmp/kotlin-classes/debug")) {
    exclude("**/R.class", "**/R$*.class", "**/BuildConfig.*")
}
val jacocoExec = fileTree(layout.buildDirectory) { include("jacoco/testDebugUnitTest.exec", "outputs/unit_test_code_coverage/debugUnitTest/testDebugUnitTest.exec") }

tasks.register<JacocoReport>("jacocoDebugReport") {
    dependsOn("testDebugUnitTest")
    classDirectories.setFrom(jacocoClasses)
    sourceDirectories.setFrom(layout.projectDirectory.dir("src/main/java"))
    executionData.setFrom(jacocoExec)
    reports { xml.required = true; html.required = true }
}

// 100% line + branch gate (project rule). Never lower these limits.
tasks.register<JacocoCoverageVerification>("jacocoDebugVerify") {
    dependsOn("jacocoDebugReport")
    classDirectories.setFrom(jacocoClasses)
    executionData.setFrom(jacocoExec)
    violationRules {
        rule {
            limit { counter = "LINE"; value = "COVEREDRATIO"; minimum = "1.0".toBigDecimal() }
            limit { counter = "BRANCH"; value = "COVEREDRATIO"; minimum = "1.0".toBigDecimal() }
        }
    }
}
