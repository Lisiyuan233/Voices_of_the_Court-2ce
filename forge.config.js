
const path = require('path');
const { execSync } = require('child_process');

module.exports = {
  outDir: process.platform === 'win32' ? 'C:/tmp' : 'out',
  packagerConfig: {
    icon: './build/icons/icon', // Electron Forge will automatically use .ico for Windows and .icns for Mac
    //"asar":true
    // P5/F18: ships the Rust save-parser sidecar (build/stageSaveParser.js
    // stages the exe into build/save-parser/win32-x64/; saveParserPath.ts
    // resolves it from process.resourcesPath in packaged builds) plus the
    // third-party notices for the bundled sidecar (checked by
    // build/checkPackagedSaveParser.js at package time).
    extraResource: ['./build/save-parser', './THIRD_PARTY_NOTICES.md'],
    ignore: /^(\/out|\/tests|\/logs|\/debug|\/\.)/
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { loadingGif: path.join(__dirname, 'build', 'icons', 'installerPic.png')}
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        name: 'VOTC-2_0-CE_macOS',
        title: 'VOTC-2_0-CE_macOS'
      }
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  hooks: {
    postPackage: (forgeConfig, packageResult) => {
      // This hook is used to remove the quarantine attribute from the app bundle on macOS
      // which causes the "damaged file" error.
      if (packageResult.platform === 'darwin') {
        const appPath = packageResult.outputPaths[0];
        console.log(`Running xattr -cr on ${appPath} to prevent "damaged file" error.`);
        try {
          execSync(`xattr -cr "${appPath}"`);
          console.log('Successfully removed quarantine attribute.');
        } catch (error) {
          console.error('Failed to remove quarantine attribute:', error);
        }
      }
    }
  },
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'szmania',
          name: 'Voices_of_the_Court'
        },
        prerelease: true
      }
    }
  ]
};
