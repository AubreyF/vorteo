const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { withAppDelegate, withInfoPlist, withPodfile } = require("expo/config-plugins");

const marker = "// Vorteo single-scene lifecycle";
const launchSubscribers =
  "super.application(application, didFinishLaunchingWithOptions: launchOptions)";
const sceneSource = fs.readFileSync(path.join(__dirname, "ios-scene-delegate.swift"), "utf8");

function configureSceneAppDelegate(source) {
  if (source.includes(marker)) return source;
  const startup =
    /#if os\(iOS\) \|\| os\(tvOS\)\n    window = UIWindow\(frame: UIScreen.main.bounds\)\n([\s\S]*?)\n#endif/;
  const match = source.match(startup);
  if (
    !match ||
    !source.includes("  // Linking API") ||
    !source.includes(`return ${launchSubscribers}`)
  ) {
    throw new Error("Scene migration requires the Expo SDK 54 Swift AppDelegate template");
  }
  const start = match[1];
  return source
    .replace(
      "  var window: UIWindow?",
      "  var window: UIWindow?\n  var initialLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?",
    )
    .replace(startup, "    initialLaunchOptions = launchOptions")
    .replace(
      "  // Linking API",
      `  func startScene(in window: UIWindow, launchOptions: [UIApplication.LaunchOptionsKey: Any]) {\n    guard let factory = reactNativeFactory else {\n      preconditionFailure("React Native factory was not initialized")\n    }\n#if os(iOS) || os(tvOS)\n${start}\n#endif\n    NotificationCenter.default.post(name: Notification.Name("VorteoReactSceneReady"), object: window)\n  }\n\n  // Linking API`,
    )
    .concat(`\n${marker}\n${sceneSource}`);
}

function configureSceneManifest(infoPlist) {
  const manifest = {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [
        {
          UISceneConfigurationName: "Default Configuration",
          UISceneDelegateClassName: "VorteoSceneDelegate",
        },
      ],
    },
  };
  const existing = infoPlist.UIApplicationSceneManifest;
  if (existing && !isDeepStrictEqual(existing, manifest)) {
    throw new Error("Scene migration refuses to overwrite an existing scene configuration");
  }
  return { ...infoPlist, UIApplicationSceneManifest: manifest };
}

function configureScenePodfile(source) {
  const podMarker = "# Vorteo: align dependency deployment targets with the app";
  if (source.includes(podMarker)) return source;
  const postInstall = /    react_native_post_install\([\s\S]*?\n    \)/;
  if (!postInstall.test(source))
    throw new Error("Cannot locate React Native's pod post-install hook");
  return source.replace(
    postInstall,
    (call) => `${call}
    ${podMarker}
    minimum = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current) < minimum
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum.to_s
        end
      end
    end`,
  );
}

function withIOSScenes(config) {
  config = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") throw new Error("Scene migration requires Swift");
    mod.modResults.contents = configureSceneAppDelegate(mod.modResults.contents);
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults = configureSceneManifest(mod.modResults);
    return mod;
  });
  return withPodfile(config, (mod) => {
    mod.modResults.contents = configureScenePodfile(mod.modResults.contents);
    return mod;
  });
}

module.exports = withIOSScenes;
module.exports.configureSceneAppDelegate = configureSceneAppDelegate;
module.exports.configureSceneManifest = configureSceneManifest;
module.exports.configureScenePodfile = configureScenePodfile;
