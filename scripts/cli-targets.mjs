/**
 * Every platform the compiled `atlarix` CLI ships for — one table for the
 * release matrix's archives, the npm platform packages and the installers.
 * `bun` is Bun's --target; `npm` is the package's os/cpu/libc.
 */
export const CLI_TARGETS = [
  { name: "darwin-arm64", bun: "bun-darwin-arm64", npm: { os: "darwin", cpu: "arm64" }, exe: "atlarix" },
  { name: "darwin-x64", bun: "bun-darwin-x64", npm: { os: "darwin", cpu: "x64" }, exe: "atlarix" },
  { name: "linux-x64", bun: "bun-linux-x64", npm: { os: "linux", cpu: "x64", libc: "glibc" }, exe: "atlarix" },
  { name: "linux-arm64", bun: "bun-linux-arm64", npm: { os: "linux", cpu: "arm64", libc: "glibc" }, exe: "atlarix" },
  { name: "linux-x64-musl", bun: "bun-linux-x64-musl", npm: { os: "linux", cpu: "x64", libc: "musl" }, exe: "atlarix" },
  { name: "linux-arm64-musl", bun: "bun-linux-arm64-musl", npm: { os: "linux", cpu: "arm64", libc: "musl" }, exe: "atlarix" },
  { name: "windows-x64", bun: "bun-windows-x64", npm: { os: "win32", cpu: "x64" }, exe: "atlarix.exe" },
];
