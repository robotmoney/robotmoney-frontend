// scripts/release/stage-browser-lib.ts — where the web release's headless
// browser lives on the stage host, and what the owner runs once as root so its
// sandbox can start (D81 amendment, owner 2026-11-11; release-runbooks.md §12).
// Pure: no I/O. ./stage-browser.ts installs and drives it; ./web-release-lib.ts
// names the owner's commands when W01's probe finds the sandbox refused.
//
// The browser runs on the stage host, never on the control machine: the
// control machine holds the operator's production ssh access and a gh token
// with admin rights, and the pages load third-party scripts and member content.
// Chromium keeps its sandbox on (web-browser-smoke.ts LAUNCH_OPTIONS).
//
// Ubuntu 24.04 (stage-2 runs 24.04.4) sets kernel.apparmor_restrict_unprivileged_userns=1,
// which denies Chromium's sandbox the user namespace it needs. The narrow fix is
// an AppArmor profile that grants `userns` to the installed headless shell alone,
// the same shape Ubuntu ships for Google Chrome. The profile attaches by path; the
// glob covers every Playwright browser revision, so a Playwright bump needs no
// new root step. The binary sits in stage-server's home, which stage-server can
// rewrite; stage-server is in the docker group and so already root-equivalent on
// stage, so a root-owned copy would add no protection there.

/** The stage host's browser install. Outside the stage target's HOME, so `stage-target.ts down` keeps it. */
export const STAGE_BROWSER = Object.freeze({
  host: "rm-frontend-stage-2",
  home: "/home/stage-server",
  dir: "/home/stage-server/rm-web-browser",
  browsers: "/home/stage-server/rm-web-browser/browsers",
  bundle: "/home/stage-server/rm-web-browser/web-browser-smoke.js",
  profileFile: "/home/stage-server/rm-web-browser/rm-web-browser.apparmor",
  /** The stage user's Bun first: /usr/local/bin's Bun is older (stage-target.ts HOST_PATH). */
  path: "/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
});

/** The AppArmor profile's name and its installed path. */
export const APPARMOR_PROFILE_NAME = "rm-web-browser";
export const APPARMOR_PROFILE_PATH = `/etc/apparmor.d/${APPARMOR_PROFILE_NAME}`;

/** PURE. The profile: `userns` for the Playwright headless shell under STAGE_BROWSER.browsers, nothing else. */
export const APPARMOR_PROFILE = [
  "# rm-web-browser: lets the web release's headless Chromium start its sandbox on stage-2",
  "# (scripts/release/stage-browser-lib.ts). Ubuntu 24.04 denies unprivileged user namespaces;",
  "# this grants one to the Playwright headless shell only, as Ubuntu's own chrome profile does.",
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "",
  `profile ${APPARMOR_PROFILE_NAME} ${STAGE_BROWSER.browsers}/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {`,
  "  userns,",
  "",
  `  include if exists <local/${APPARMOR_PROFILE_NAME}>`,
  "}",
  "",
].join("\n");

/** The owner's one-time root step on stage-2, after `bun scripts/release/stage-browser.ts install` copied the profile there. */
export const OWNER_SANDBOX_COMMANDS: readonly string[] = Object.freeze([
  `sudo install -m 0644 -o root -g root ${STAGE_BROWSER.profileFile} ${APPARMOR_PROFILE_PATH}`,
  `sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`,
]);

/** The host-wide fallback, acceptable on stage only (it holds no key production accepts and no gh token). */
export const OWNER_SANDBOX_FALLBACK = "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (and the same line in a file under /etc/sysctl.d/ to survive a reboot)";

/** What the remote browser prints when it has not been installed. */
export const NOT_INSTALLED = "the stage browser is not installed";

/** PURE. W01's refusal when the stage browser does not start. */
export function stageBrowserProblem(message: string): string {
  if (message.includes(NOT_INSTALLED)) {
    return `the headless browser is not installed on ${STAGE_BROWSER.host}: run bun scripts/release/stage-browser.ts install`;
  }
  if (/sandbox/i.test(message)) {
    return `the headless browser on ${STAGE_BROWSER.host} cannot start Chromium's sandbox (Playwright: "Chromium sandboxing failed"): ` +
      "Ubuntu 24.04's kernel.apparmor_restrict_unprivileged_userns=1 denies it a user namespace. The owner runs, once, as root on " +
      `${STAGE_BROWSER.host}: ${OWNER_SANDBOX_COMMANDS.join(" && ")}. The sandbox is never turned off to get past this`;
  }
  return `the headless browser on ${STAGE_BROWSER.host} does not start (${message.split("\n")[0]}): run bun scripts/release/stage-browser.ts install`;
}
