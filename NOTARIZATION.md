# macOS Code Signing & Notarization Setup

This guide walks you through setting up code signing and notarization for Deckhand on macOS.

## Prerequisites

1. **Apple Developer Account** (you have this ✓)
2. **Xcode Command Line Tools** installed
3. **Developer ID Application Certificate** in your Keychain

## Step 1: Get Your Apple Team ID

1. Go to https://developer.apple.com/account
2. Sign in with your Apple ID
3. Your Team ID is displayed in the top right (10-character string like `ABCDE12345`)

## Step 2: Install Developer ID Certificate

If you haven't already:

1. Go to https://developer.apple.com/account/resources/certificates/list
2. Click the **+** button to create a new certificate
3. Select **Developer ID Application**
4. Follow the steps to generate a Certificate Signing Request (CSR)
5. Download and double-click the certificate to install it in your Keychain

Verify installation:
```bash
security find-identity -v -p codesigning
```

You should see a line like:
```
1) ABCDEF1234567890... "Developer ID Application: Your Name (TEAM_ID)"
```

## Step 3: Generate App-Specific Password

1. Go to https://appleid.apple.com
2. Sign in with your Apple ID
3. In the **Security** section, click **App-Specific Passwords**
4. Click **Generate an app-specific password**
5. Give it a label like "Deckhand Notarization"
6. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

**Important**: Save this password securely! You won't be able to see it again.

## Step 4: Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your values:
   ```bash
   APPLE_TEAM_ID=YOUR_TEAM_ID
   APPLE_ID=your.email@example.com
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

3. **Never commit `.env` to git!** (already in `.gitignore`)

## Step 5: Build with Notarization

Build for macOS:
```bash
npm run build:mac
```

The build process will:
1. Code sign the app with your Developer ID certificate
2. Upload the app to Apple for notarization
3. Wait for Apple's approval (usually 1-5 minutes)
4. Staple the notarization ticket to the app

## Troubleshooting

### "No identity found"
- Make sure your Developer ID certificate is installed in Keychain
- Run `security find-identity -v -p codesigning` to verify

### "Authentication failed"
- Double-check your `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`
- Make sure you're using an app-specific password, not your regular Apple ID password

### Notarization timeout
- Apple's servers can be slow sometimes
- The build will wait up to 30 minutes by default
- Check status at https://developer.apple.com/account/resources/notarization/list

### "Hardened Runtime" errors
- The entitlements file (`build/entitlements.mac.plist`) allows necessary exceptions
- Required for Electron apps using JIT compilation and native modules

## CI/CD Setup

For automated builds (GitHub Actions, etc.):

1. Store secrets as environment variables in your CI system
2. For the certificate, you'll need to:
   - Export it from Keychain as a `.p12` file
   - Base64 encode it
   - Store as `CSC_LINK` (base64 string) and `CSC_KEY_PASSWORD` (p12 password)

Example GitHub Actions:
```yaml
- name: Build macOS app
  env:
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    CSC_LINK: ${{ secrets.CSC_LINK }}
    CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
  run: npm run build:mac
```

## What's Been Configured

- ✓ App ID changed to `com.deckhand.app`
- ✓ Hardened Runtime enabled
- ✓ Notarization configured in `electron-builder.yml`
- ✓ Entitlements file for necessary exceptions
- ✓ Environment variable template in `.env.example`
- ✓ `.env` added to `.gitignore`

## References

- [Apple Notarization Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [electron-builder Code Signing](https://www.electron.build/code-signing)
- [electron-notarize](https://github.com/electron/notarize)
