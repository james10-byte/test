# Web-to-APK Builder

Turn any website into a standalone Android APK with a native app-like experience.

The Web-to-APK Builder provides a modern, single-page web interface where you enter your website details, customize app options (permissions, WebView features, branding colors, and app icons), and compile an Android APK locally using Gradle.

> ⭐ **Note:** If you find this project helpful, please consider giving the repository a star! Your support is greatly appreciated.

---

## Features

- **Direct Website to APK**: Loads any HTTP/HTTPS website seamlessly inside an optimized Android WebView.
- **Master Android Template**: Uses the existing Capacitor Android wrapper without ever altering the master template files.
- **Custom Branding**: Specify app name, custom package name (`com.company.app`), primary color, status bar color, and navigation bar color.
- **Automated Icon Generation**: Upload any PNG/JPG/WebP image (1024×1024 recommended) to automatically generate all Android launcher density mipmaps (`mdpi`, `hdpi`, `xhdpi`, `xxhdpi`, `xxxhdpi`, and round variants).
- **Configurable Permissions**: Fine-grained selection of Android permissions (Internet, Camera, Microphone, Location, Notifications, Bluetooth, Downloads).
- **WebView Features**: Enable or disable DOM Storage, JavaScript, File Uploads, Downloads, Fullscreen, and native Back-Button navigation history.
- **Real-Time Build Feedback**: Live progress bar, step indicators, and detailed compilation messages.
- **Instant APK Download**: One-click download upon build completion.

---

## Architecture & Project Structure

```text
web-to-apk/
│
├── android-app-wrapper/        # Master Android wrapper template
│   ├── android/                # Native Gradle project & wrapper
│   ├── node_modules/           # Capacitor Android libraries
│   ├── assets/                 # Default assets
│   └── www/                    # Web wrapper bridge
│
├── frontend/                   # Modern Dark SPA interface
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── backend/                    # Single-file Flask server & builder
│   ├── app.py                  # Main Flask application + REST API
│   └── builder.py              # Android project customization & Gradle execution
│
├── builds/                     # Ephemeral builds directory (gitignored)
├── uploads/                    # Temporary uploaded icons (gitignored)
│
├── requirements.txt
├── .env.example
├── .gitignore
└── README.md
```

---

## Requirements

1. **Python**: Python 3.10 or higher.
2. **Java JDK**: JDK 17 (e.g. Amazon Corretto 17, Eclipse Temurin 17, or Microsoft OpenJDK 17).
3. **Android SDK**: Android SDK with Command-line Tools / Build-tools installed (standard Android Studio SDK location).

---

## Installation & Setup

1. **Set up a Python Virtual Environment**:
   ```bash
   python -m venv venv
   ```

2. **Activate the Virtual Environment**:
   - On Windows (PowerShell):
     ```powershell
     .\venv\Scripts\Activate.ps1
     ```
   - On Windows (CMD):
     ```cmd
     venv\Scripts\activate.bat
     ```
   - On Linux / macOS:
     ```bash
     source venv/bin/activate
     ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

---

## JDK & Android SDK Configuration

The builder automatically discovers JDK 17 and your local Android SDK. You can also specify them in your environment or in a `.env` file:

```env
# Optional environment variables
JAVA_HOME=C:\Users\<username>\.jdks\corretto-17.0.20.1
ANDROID_HOME=C:\Users\<username>\AppData\Local\Android\Sdk
PORT=5000
```

---

## Running Locally

Run the Flask application:

```bash
python backend/app.py
```

Then open your browser at:

```text
http://localhost:5000
```

---

## How to Build an APK

1. Open `http://localhost:5000`.
2. Enter your **Website URL** (e.g., `https://example.com`).
3. Enter your **App Name** (e.g., `Weather Dashboard`).
4. Review the auto-generated **Package Name** (e.g., `com.webtoapk.weatherdashboard`) or customize it.
5. (Optional) Upload an **App Icon** (1024×1024 PNG recommended).
6. Select any required **Permissions** and **WebView Features**.
7. Pick your preferred **Primary Color**, **Status Bar Color**, and **Navigation Bar Color**.
8. Click **BUILD APK**.
9. Watch the live compilation progress.
10. Click **DOWNLOAD APK** once completed!

---

## REST API Endpoints

- `GET /api/info` - Health check and JDK/Android SDK detection info.
- `POST /api/validate` - Validates URL, package name, and suggests valid package identifiers.
- `POST /api/build` - Starts an asynchronous APK build (accepts `multipart/form-data` or JSON).
- `GET /api/status/<build_id>` - Polls build progress, steps, and completion status.
- `GET /api/download/<build_id>` - Downloads the generated `.apk` file.

---

## Troubleshooting

- **"Java compilation initialization error: invalid source release: 21"**:
  Make sure `JAVA_HOME` points to a valid JDK 17 or JDK 21 installation with `jlink.exe` and `javac.exe` present in its `bin/` directory.
- **Android SDK not found**:
  Verify that `ANDROID_HOME` or `ANDROID_SDK_ROOT` points to your Android SDK folder (e.g. `C:\Users\<User>\AppData\Local\Android\Sdk`).
- **Cannot install APK on phone**:
  By default, `assembleDebug` generates an APK signed with standard Android debug credentials that can be sideloaded directly onto any Android device with "Install unknown apps" enabled.

---

## Support & Feedback

If you find this project helpful, please consider **starring the repository** ⭐! Feel free to open an issue or contribute pull requests.

