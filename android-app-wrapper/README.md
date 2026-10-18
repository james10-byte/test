Android App wrapper

An Android wrapper for the  web application, built using Capacitor. It converts the existing web application into a standalone Android app with a native app-like experience, without displaying browser UI such as the address bar or tabs.

🌐 Live Website

[AQI Analysis & Visualization](https://aqi-analysis-and-visualization.vercel.app/)

🌐 Application Demo

[AQI Analysis & Visualization Android Application Download Link](https://github.com/gauravjha-codes/aqi-analysis-android/actions/runs/35237218141/artifacts/10504280338)

✨ Features

📱 Standalone Android application

🚫 No browser address bar or tabs

🎨 Custom app name and icon

🔐 HTTPS-based web loading

📦 APK generation

🤖 Automated builds using GitHub Actions

💻 Development using VS Code and terminal

🛠️ Tech Stack

Capacitor 8

Android WebView

Gradle

Node.js & npm

GitHub Actions

Vercel

📂 Project Structure
```
AQI-Android-App/
├── android/
├── assets/
│   └── icon.png
├── www/
│   └── index.html
├── .github/
│   └── workflows/
│       └── android.yml
├── capacitor.config.json
├── package.json
└── README.md
```

⚙️ Configuration

The app loads the deployed Vercel website directly through Capacitor. Your capacitor.config.json should look like this:
```
{
  "appId": "com.glitchartiste.aqianalysis",
  "appName": "AQI Analysis",
  "webDir": "www",
  "server": {
    "url": "your-web-application-url",
    "cleartext": false
  }
}
```

🚀 Setup

First, install the required dependencies:
```
npm install
```

Sync the Capacitor project with the Android folder:
```
npx cap sync android
```

Generate the Android app icon and splash screen assets:
```
npx @capacitor/assets generate --android
```

📦 APK Build

The Android APK is automatically built using GitHub Actions. The build flow is:
```
Website → Capacitor → Android WebView → Gradle → APK
```
After a successful workflow run, you can download the generated APK from the Artifacts section of the GitHub Actions tab in your repository.

⚠️ Note

Because this Android app acts as a wrapper that directly loads the live web application from Vercel, an internet connection is required to use the app.

AQI Analysis & Visualization — Android wrapper powered by Capacitor.
