# Desktop

Desktop apps are organized by shared runtime code plus platform-specific packaging.

- `shared/` contains the Electron shell, setup UI, bot runtime, and local server code used by desktop builds.
- `macOS/` contains macOS assets and packaging scripts for the current app.
- `windows/` is reserved for the Windows conversion work.
- `linux/` is reserved for the Linux conversion work.

Root `npm` scripts remain the stable entrypoints while the platform folders settle.
