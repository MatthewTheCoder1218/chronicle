# 📚 DevChronicle

*Track your code journey with smart commit reminders.*

[![VSCode Marketplace](https://img.shields.io/badge/VSCode-Chronicles-blue)](https://marketplace.visualstudio.com/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

**DevChronicle helps you auto-commit your code on file save, idle, and track your progress.**

## 🎯 Features

* Auto-commit on file save
* Auto-commit on idle (configurable)
* Configurable file types (.js, .ts, .jsx, .tsx, .css, .scss, .html)
* Pause & resume auto-commits
* Shows commit stats (files & commits per session)
* Auto-generate commit messages

## 🚀 Installation

1. Open **VSCode**
2. Go to **Extensions** (Ctrl+Shift+X)
3. Search for `DevChronicle` and install it
4. Configure settings in `settings.json` or via command palette

## 📖 Usage

* Auto-commit triggers:

  * On file save
  * On idle (2–5 min configurable)
* Commands:

  * `DevChronicle: Commit Now`
  * `DevChronicle: Pause Auto-Commit`
  * `DevChronicle: Resume Auto-Commit`
  * `DevChronicle: Open Settings`

> Auto-commit will only run if the workspace is a git repository.

## ⚙️ Configuration

```json
"chronicle": {
  "autoCommit": true,
  "autoPush": true,
  "idleMinutes": 2,
  "fileExtensions": [".js", ".ts", ".jsx", ".tsx", ".css", ".scss", ".html"],
  "showNotifications": true
}
```

## 🛠️ Contributing

Open issues or PRs if you have ideas or find bugs!

**Made with ❤️ by Little Prince**

## 📄 License

ISC © Little Prince
