'use strict';

// electron-builder skips signing entirely when mac.identity is null, and skips
// the afterSign hook with it ("no signing occurred"). afterPack is the last
// hook that runs before the DMG/ZIP is assembled, so the ad-hoc signature
// applied here is what ships.
const { execFileSync } = require('node:child_process');

exports.default = async ({ appOutDir, packager, electronPlatformName }) => {
  if (electronPlatformName !== 'darwin') return;
  const app = `${appOutDir}/${packager.appInfo.productFilename}.app`;
  execFileSync('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-',
    '--identifier', 'dev.openmaicong.studio', app
  ], { stdio: 'inherit' });
};
