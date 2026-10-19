import { describe, expect, it } from "vitest";

const {
  configureSceneAppDelegate,
  configureSceneManifest,
  configureScenePodfile,
} = require("./with-ios-scenes");
const { configurePasteInputAppDelegate } = require("./with-paste-input");

const template = `public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  func application() {
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
  // Linking API
}`;

describe("iOS scene generation", () => {
  it("moves startup to the scene while preserving paste registration in either plugin order", () => {
    const before = configureSceneAppDelegate(configurePasteInputAppDelegate(template));
    const after = configurePasteInputAppDelegate(configureSceneAppDelegate(template));
    expect(after).toBe(before);
    expect(configureSceneAppDelegate(before)).toBe(before);
    expect(before).not.toContain("UIScreen.main.bounds");
    expect(before.match(/factory.startReactNative\(/g)).toHaveLength(1);
    expect(before).toContain("UIWindow(windowScene: windowScene)");
    expect(before).toContain("appDelegate.startScene(in: window, launchOptions: launchOptions)");
    expect(before).toContain("launchOptions: launchOptions)\n    PasteInputModule.setup");
    expect(before).toContain(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
    );
  });

  it("registers one scene without replacing unrelated plist settings", () => {
    const configured = configureSceneManifest({ UIAppFonts: ["Barlow-400.ttf"] });
    expect(configured).toEqual({
      UIAppFonts: ["Barlow-400.ttf"],
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: "Default Configuration",
              UISceneDelegateClassName: "VorteoSceneDelegate",
            },
          ],
        },
      },
    });
    expect(configureSceneManifest(configured)).toEqual(configured);
  });

  it("refuses unknown startup and existing scene configurations", () => {
    expect(() => configureSceneAppDelegate("custom native startup")).toThrow("SDK 54");
    expect(() => configureSceneManifest({ UIApplicationSceneManifest: {} })).toThrow("overwrite");
  });

  it("retains the React Native pod hook and applies the deployment floor once", () => {
    const source =
      "  post_install do |installer|\n    react_native_post_install(\n      installer,\n    )\n  end";
    const configured = configureScenePodfile(source);
    expect(configured).toContain("react_native_post_install(\n      installer,\n    )");
    expect(configureScenePodfile(configured)).toBe(configured);
    expect(() => configureScenePodfile("custom pod hook")).toThrow("post-install");
  });
});
