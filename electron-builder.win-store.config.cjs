const displayName =
  process.env.WINDOWS_STORE_DISPLAY_NAME || 'Twig Presentation Editor'
const publisherDisplayName =
  process.env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME || '朱晨瑞'
const identityName =
  process.env.WINDOWS_STORE_IDENTITY_NAME || 'FF08CC69.TwigPresentationEditor'
const publisher =
  process.env.WINDOWS_STORE_PUBLISHER || 'CN=76F716C7-82A7-4940-8AF7-087E05524817'
const applicationId =
  process.env.WINDOWS_STORE_APPLICATION_ID || 'TwigPresentationEditor'

const msix = {
  artifactName: '${name}-${version}.${ext}',
  displayName,
  publisherDisplayName,
  identityName,
  publisher,
  applicationId,
  // electron-builder resolves AppX tile assets from build/appx/*.png.
  backgroundColor: '#282B33',
  languages: ['en-US', 'zh-CN'],
}

module.exports = {
  appId: 'com.twig.app',
  productName: 'twig',
  directories: {
    buildResources: 'build',
  },
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!svelte.config.mjs',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}',
  ],
  electronLanguages: ['en-US', 'zh-CN'],
  asarUnpack: ['resources/**'],
  fileAssociations: [
    {
      ext: 'tb',
      name: 'Twig Presentation',
      description: 'Twig Presentation File',
      mimeType: 'application/x-twig',
      icon: 'build/icon',
      role: 'Editor',
    },
  ],
  win: {
    executableName: 'twig',
    target: [
      {
        target: 'appx',
        arch: ['x64'],
      },
    ],
  },
  appx: msix,
  mac: {
    bundleShortVersion: '1.0.0',
    bundleVersion: '1.0.14',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSDocumentsFolderUsageDescription:
        'twig needs access to your Documents folder to open and save presentations.',
      NSDownloadsFolderUsageDescription:
        'twig needs access to your Downloads folder to open and save presentations.',
      CFBundleLocalizations: ['en', 'zh-CN'],
    },
    notarize: true,
  },
  dmg: {
    artifactName: '${name}-${version}.${ext}',
  },
  mas: {
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    provisioningProfile: 'build/twig.provisionprofile',
    identity: 'Apple Distribution: Chenrui Zhu (65ZLJ987GH)',
    artifactName: '${name}-${version}-mas.${ext}',
    extendInfo: {
      NSDocumentsFolderUsageDescription:
        'twig needs access to your Documents folder to open and save presentations.',
      NSDownloadsFolderUsageDescription:
        'twig needs access to your Downloads folder to open and save presentations.',
      CFBundleLocalizations: ['en', 'zh-CN'],
    },
    notarize: false,
  },
  linux: {
    target: ['AppImage', 'deb'],
    maintainer: 'boomzero',
    category: 'Utility',
    icon: 'build/icons/png',
  },
  appImage: {
    artifactName: '${name}-${version}.${ext}',
  },
  npmRebuild: false,
  publish: {
    provider: 'github',
    owner: 'boomzero',
    repo: 'twig',
    releaseType: 'draft',
  },
}
