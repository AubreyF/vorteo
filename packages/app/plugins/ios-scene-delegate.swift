// SDK 54 compatibility until Expo's scene runtime is adopted during an SDK upgrade.
// Keep one React runtime and forward scene events through the existing Expo subscribers.
@objc(VorteoSceneDelegate)
final class VorteoSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate {
    guard let delegate = UIApplication.shared.delegate as? AppDelegate else {
      preconditionFailure("Missing Vorteo application delegate")
    }
    return delegate
  }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    if let existingWindow = appDelegate.window {
      window = existingWindow
      existingWindow.windowScene = windowScene
      existingWindow.makeKeyAndVisible()
      self.scene(scene, openURLContexts: connectionOptions.urlContexts)
      for activity in connectionOptions.userActivities {
        self.scene(scene, continue: activity)
      }
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    var launchOptions = appDelegate.initialLaunchOptions ?? [:]
    if let context = connectionOptions.urlContexts.first {
      launchOptions[.url] = context.url
      launchOptions[.sourceApplication] = context.options.sourceApplication
      launchOptions[.annotation] = context.options.annotation
    }
    if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }
    if let response = connectionOptions.notificationResponse {
      launchOptions[.remoteNotification] = response.notification.request.content.userInfo
    }

    appDelegate.startScene(in: window, launchOptions: launchOptions)
    appDelegate.initialLaunchOptions = nil
    // The development launcher must be ready before receiving a launch URL.
    // RN also receives this URL in launchOptions for Linking.getInitialURL().
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    for activity in connectionOptions.userActivities {
      self.scene(scene, continue: activity)
    }
    if let shortcut = connectionOptions.shortcutItem {
      self.windowScene(windowScene, performActionFor: shortcut, completionHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace
      ]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate.application(UIApplication.shared, continue: userActivity,
                               restorationHandler: { _ in })
  }

  func scene(_ scene: UIScene, willContinueUserActivityWithType activityType: String) {
    _ = appDelegate.application(UIApplication.shared, willContinueUserActivityWithType: activityType)
  }

  func scene(_ scene: UIScene, didFailToContinueUserActivityWithType activityType: String,
             error: Error) {
    appDelegate.application(UIApplication.shared,
                            didFailToContinueUserActivityWithType: activityType, error: error)
  }

  func scene(_ scene: UIScene, didUpdate userActivity: NSUserActivity) {
    appDelegate.application(UIApplication.shared, didUpdate: userActivity)
  }

  func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                   completionHandler: @escaping (Bool) -> Void) {
    appDelegate.application(UIApplication.shared, performActionFor: shortcutItem,
                            completionHandler: completionHandler)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate.applicationWillResignActive(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate.applicationDidEnterBackground(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate.applicationWillEnterForeground(UIApplication.shared)
  }
}
