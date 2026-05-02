# Windows Desktop

Windows-specific desktop files live here.

- `assets/icon.ico` is the Windows app icon generated from `desktop/shared/assets/logo.jpg`.
- `scripts/install-electron-better-sqlite3.mjs` repairs and probes the packaged Windows `better-sqlite3` native module after Electron Builder creates `release/win-unpacked`.

Current Windows entrypoint:

```sh
npm run app:build:windows
```

Run that command on Windows. It builds the shared desktop bundle, packages an unpacked Windows Electron app, installs the Electron ABI prebuild for `better-sqlite3`, and launches the packaged executable in `ELECTRON_RUN_AS_NODE` mode to confirm SQLite opens.

The root package also defines Windows installer metadata for NSIS and portable targets. The first conversion milestone is the unpacked app smoke path; installer artifact automation should come after the unpacked app passes on a real Windows machine.
