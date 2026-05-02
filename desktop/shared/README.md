# Desktop Shared

Shared desktop code lives here.

- `src/` is the TypeScript runtime, local setup server, Twitch bot modules, and static setup UI.
- `electron/` is the Electron main process used by desktop packaging.

This code should stay platform-neutral unless a platform boundary is unavoidable. Platform-specific icons, installers, signing, and release scripts belong under `desktop/<platform>/`.
