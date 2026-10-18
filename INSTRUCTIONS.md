# Web-to-APK Setup & Build Instructions

This guide provides step-by-step instructions to configure, run, and maintain the Web-to-APK builder environment.

---

## 1. System Prerequisites

### A. Java Development Kit (JDK)
* **Required Version:** **JDK 17** (LTS) *(e.g., Amazon Corretto 17, Eclipse Temurin 17, or Microsoft OpenJDK 17)*.
* **Requirements:**
  * Must contain `bin/javac.exe` and `bin/keytool.exe`.
  * **Environment Variable:** `JAVA_HOME` must point to your JDK 17 root folder.
  * **Verify Installation:**
    ```powershell
    java -version
    javac -version
    echo $env:JAVA_HOME
    ```

### B. Android SDK & Build Tools
* **Required SDK Location:** Standard Android Studio SDK directory (or standalone Android command-line tools).
  * Example on Windows: `C:\Users\<username>\AppData\Local\Android\Sdk`
* **Required Components (via Android SDK Manager):**
  * Android SDK Platform 34 or 36
  * Android SDK Build-Tools (version 34.x, 35.x, or 36.x)
  * Android SDK Platform-Tools
* **Environment Variables:**
  * Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the Android SDK directory.
  * Add `build-tools/<version>` and `platform-tools` to your system `PATH`.
* **Verify Installation:**
  ```powershell
  echo $env:ANDROID_HOME
  where apksigner
  ```

### C. Node.js & npm
* **Node.js:** Node.js LTS (v18, v20, or v22).
* **npm:** npm v10+.
* **Verify Installation:**
  ```powershell
  node -v
  npm -v
  ```

### D. Python
* **Python:** Python 3.10, 3.11, 3.12, or 3.13.
* **Verify Installation:**
  ```powershell
  python --version
  ```

### E. Gradle
* **Version:** **Gradle 8.14.3** (Gradle Wrapper is pre-configured and bundled inside `android-app-wrapper/android/gradlew.bat`; no global Gradle install is required).

---

## 2. Setting Up Environment Variables

Create or update your environment variables (in system settings or via a `.env` file in the project root):

```env
# Path to your JDK 17 installation
JAVA_HOME=C:\Users\<username>\.jdks\corretto-17.0.20.1

# Path to your Android SDK
ANDROID_HOME=C:\Users\<username>\AppData\Local\Android\Sdk
ANDROID_SDK_ROOT=C:\Users\<username>\AppData\Local\Android\Sdk

# Server port
PORT=5000
```

> **Note for Windows PowerShell:** You can set them temporarily in your current session:
> ```powershell
> $env:JAVA_HOME = "C:\Users\<username>\.jdks\corretto-17.0.20.1"
> $env:ANDROID_HOME = "C:\Users\<username>\AppData\Local\Android\Sdk"
> ```

---

## 3. Configuring the Master Android Wrapper (`android-app-wrapper`)

The `android-app-wrapper` folder is the master template copied for each build.

### Step 1: Install Capacitor Dependencies
Open a terminal in the project root and navigate to `android-app-wrapper`:

```powershell
cd android-app-wrapper
npm install
```

### Step 2: Ensure Java 17 Compatibility
Ensure `android-app-wrapper/android/app/capacitor.build.gradle` has Java 17 compatibility configured:

```groovy
android {
  compileOptions {
      sourceCompatibility JavaVersion.VERSION_17
      targetCompatibility JavaVersion.VERSION_17
  }
}
```

### Step 3: Verify Capacitor Environment
Inside `android-app-wrapper`, run:

```powershell
npx cap doctor
```
*Expected output: `[success] Android looking great! 👌`*

### Step 4: Verify Gradle Wrapper
Navigate into `android-app-wrapper\android` and test the Gradle wrapper:

```powershell
cd android
.\gradlew.bat --version
```
*(Notice the `.\` prefix required by PowerShell)*.  
*Expected output: `Gradle 8.14.3` running on JVM 17 or 21.*

Return to the project root:
```powershell
cd ..\..
```

---

## 4. Running the Web-to-APK Application

From the project root:

```powershell
python backend/app.py
```

Open your browser and navigate to:
```text
http://localhost:5000
```

---

## 5. Building an APK (Step-by-Step)

1. Open `http://localhost:5000` in your web browser.
2. **Website URL**: Enter the complete website URL (e.g., `https://example.com`).
3. **App Name**: Enter your application name (e.g., `My Portfolio`).
4. **Package Identifier**: Verify or customize the package name (e.g., `com.company.portfolio`).
5. **App Icon** *(Optional)*: Upload a 1024×1024 PNG or JPG icon.
6. **Permissions & Features**: Select any required Android permissions (Camera, Location, Storage, etc.) and WebView preferences.
7. **Color Scheme**: Choose branding, Status Bar, and Navigation Bar colors.
8. Click **BUILD APK**.
9. The backend will compile the APK, sign it with release credentials, verify the APK signature using `apksigner`, and present a **DOWNLOAD APK** button when completed.

---

## 6. Common Troubleshooting

### A. `error: invalid source release: 21`
* **Cause:** Gradle is compiling with JDK 17 while build scripts specify `VERSION_21`.
* **Fix:** Ensure `sourceCompatibility` and `targetCompatibility` in `android-app-wrapper/android/app/capacitor.build.gradle` are set to `JavaVersion.VERSION_17`.

### B. `The term 'gradlew.bat' is not recognized`
* **Cause:** Running `gradlew.bat` without `.\` or outside the `android\` subfolder.
* **Fix:** Run `cd android-app-wrapper\android` and use `.\gradlew.bat <command>`.

### C. `Release build finished, but no release APK was found`
* **Cause:** An incomplete build or missing subproject directories.
* **Fix:** Ensure `android-app-wrapper/node_modules` is populated by running `npm install` inside `android-app-wrapper`.

---

> ⭐ **Note:** If you find this project helpful, please consider **starring the repository** on GitHub!

