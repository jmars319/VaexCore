# Desktop Shared

Shared desktop code lives here.

- `src/` is the TypeScript runtime, local setup server, Twitch bot modules, and static setup UI.
- `electron/` is the Electron main process used by desktop packaging.
- `assets/` contains shared artwork used by the desktop UI and copied into packaged builds.

This code should stay platform-neutral unless a platform boundary is unavoidable. Platform-specific icons, installers, signing, and release scripts belong under `desktop/<platform>/`.
