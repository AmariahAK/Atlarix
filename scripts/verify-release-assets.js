#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

/**
 * Verifies that all expected binary assets are present in the GitHub release
 * for the version specified in package.json
 */
async function verifyReleaseAssets() {
  try {
    // Read version from package.json
    const packagePath = path.join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const version = packageJson.version;

    console.log(`🔍 Verifying release assets for version ${version}...`);

    // GitHub API configuration
    const owner = "AmariahAK";
    const repo = "atlarix-releases";
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is required");
    }

    // Fetch all releases (including drafts)
    const tagName = `v${version}`;

    console.log(`📡 Fetching all releases to find: ${tagName}`);

    const allReleasesUrl = `https://api.github.com/repos/${owner}/${repo}/releases`;
    const response = await fetch(allReleasesUrl, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "atlarix-release-verifier",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`,
      );
    }

    const allReleases = await response.json();
    const release = allReleases.find((r) => r.tag_name === tagName);

    if (!release) {
      throw new Error(
        `Release ${tagName} not found in published releases or drafts. Make sure the release exists.`,
      );
    }

    const assets = release.assets || [];

    console.log(`📦 Found ${assets.length} assets in release ${tagName}`);
    console.log(`📄 Release status: ${release.draft ? "DRAFT" : "PUBLISHED"}`);

    // Handle different beta naming conventions across platforms
    const normalizeVersionForPlatform = (version, platform) => {
      if (!version.includes("beta")) {
        return version;
      }

      switch (platform) {
        case "rpm":
        case "deb":
          // RPM and DEB use dots: 0.14.0-beta.1 -> 0.14.0.beta.1
          return version.replace("-beta.", ".beta.");
        case "nupkg":
          // NuGet removes the dot: 0.14.0-beta.1 -> 0.14.0-beta1
          return version.replace("-beta.", "-beta");
        default:
          // Windows installer and macOS zips keep original format
          return version;
      }
    };

    // Define expected assets with platform-specific version handling.
    //
    // Names are compared case-INSENSITIVELY below. Forge emits the Squirrel and
    // darwin-zip artifacts capitalised ("Atlarix-…"), so an exact match reported
    // three assets missing on every release even though all were uploaded — the
    // gate failed 100% of the time and therefore checked nothing.
    const expectedAssets = [
      `atlarix-${normalizeVersionForPlatform(version, "rpm")}-1.x86_64.rpm`,
      `atlarix-${normalizeVersionForPlatform(version, "nupkg")}-full.nupkg`,
      `atlarix-${version}.Setup.exe`,
      `atlarix-darwin-arm64-${version}.zip`,
      `atlarix-darwin-x64-${version}.zip`,
      `atlarix_${normalizeVersionForPlatform(version, "deb")}_amd64.deb`,
      "RELEASES",
      // The installers people actually download. Omitting them meant a release
      // missing, say, the Intel DMG would have passed verification.
      `atlarix-${version}-arm64.dmg`,
      `atlarix-${version}-x64.dmg`,
      `atlarix-${version}-x64.AppImage`,
      // electron-updater feeds — absent these, auto-update cannot see the release.
      "latest-mac.yml",
      "latest-linux.yml",
    ];

    console.log("📋 Expected assets:");
    expectedAssets.forEach((asset) => console.log(`  - ${asset}`));
    console.log("");

    // Get actual asset names
    const actualAssets = assets.map((asset) => asset.name);

    console.log("📋 Actual assets:");
    actualAssets.forEach((asset) => console.log(`  - ${asset}`));
    console.log("");

    // Asset names are unique regardless of case, so fold both sides rather than
    // trying to predict each maker's capitalisation.
    const actualByLower = new Map(actualAssets.map((n) => [n.toLowerCase(), n]));

    // Check for missing assets
    const missingAssets = expectedAssets.filter(
      (expected) => !actualByLower.has(expected.toLowerCase()),
    );

    if (missingAssets.length > 0) {
      console.error("❌ VERIFICATION FAILED!");
      console.error("📭 Missing assets:");
      missingAssets.forEach((asset) => console.error(`  - ${asset}`));
      console.error("");
      console.error(
        "Please ensure all platforms have completed their builds and uploads.",
      );
      process.exit(1);
    }

    // Check for unexpected assets (optional warning)
    const expectedLower = new Set(expectedAssets.map((a) => a.toLowerCase()));
    const unexpectedAssets = actualAssets.filter(
      (actual) => !expectedLower.has(actual.toLowerCase()),
    );

    if (unexpectedAssets.length > 0) {
      console.warn("⚠️  Unexpected assets found:");
      unexpectedAssets.forEach((asset) => console.warn(`  - ${asset}`));
      console.warn("");
    }

    console.log("✅ VERIFICATION PASSED!");
    console.log(
      `🎉 All ${expectedAssets.length} expected assets are present in release ${tagName}`,
    );
    console.log("");
    console.log("📊 Release Summary:");
    console.log(`  Release: ${release.name || tagName}`);
    console.log(`  Tag: ${release.tag_name}`);
    console.log(`  Published: ${release.published_at}`);
    console.log(`  URL: ${release.html_url}`);
  } catch (error) {
    console.error("❌ Error verifying release assets:", error.message);
    process.exit(1);
  }
}

// Run the verification
verifyReleaseAssets();
