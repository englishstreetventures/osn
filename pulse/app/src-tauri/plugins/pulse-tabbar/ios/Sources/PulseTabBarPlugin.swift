import Tauri
import UIKit
import WebKit

class TabItemArgs: Decodable {
  let id: String
  let title: String
  let systemImage: String?
  let enabled: Bool?
}

class SetTabsArgs: Decodable {
  let tabs: [TabItemArgs]
  let selectedId: String?
  let onSelect: Channel
}

class SetSelectedTabArgs: Decodable {
  let id: String
}

/// What goes up the channel on every tap. Mirrors `TabSelected` in
/// `src/models.rs`; the webview maps the id back to a route.
private struct TabSelectedPayload: Encodable {
  let id: String
}

/// `UITabBar` sizes itself to include the bottom safe area when it sits at the
/// bottom of its superview, so its height is only known after layout — and it
/// changes on rotation. Both hooks below are the documented ones: UIKit calls
/// `safeAreaInsetsDidChange()` when the insets move, and `layoutSubviews()`
/// once the new height has been resolved.
class PulseTabBar: UITabBar {
  var onHeightChange: ((CGFloat) -> Void)?

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    invalidateIntrinsicContentSize()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    onHeightChange?(bounds.height)
  }
}

class PulseTabBarPlugin: Plugin, UITabBarDelegate {
  private weak var webview: WKWebView?

  private var bar: PulseTabBar?
  private var onSelect: Channel?
  /// Tab ids in bar order. A `UITabBarItem` carries an integer `tag`, not a
  /// string, so the tag indexes into this.
  private var tabIds: [String] = []
  /// The webview's own bottom inset before we touched it, restored on teardown.
  private var inheritedBottomInset: CGFloat?
  private var applyingInset = false

  override public func load(webview: WKWebView) {
    self.webview = webview
  }

  deinit {
    bar?.onHeightChange = nil
    bar?.removeFromSuperview()
  }

  // MARK: - Commands

  @objc public func setTabs(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetTabsArgs.self)

    DispatchQueue.main.async {
      guard let webview = self.webview else {
        invoke.reject("the tab bar plugin has no webview yet")
        return
      }

      guard !args.tabs.isEmpty else {
        self.teardown()
        invoke.resolve()
        return
      }

      let bar = self.bar ?? self.installBar(in: webview)
      self.onSelect = args.onSelect
      self.tabIds = args.tabs.map(\.id)

      bar.items = args.tabs.enumerated().map { index, tab in
        let item = UITabBarItem(
          title: tab.title,
          image: tab.systemImage.flatMap { UIImage(systemName: $0) },
          tag: index
        )
        item.isEnabled = tab.enabled ?? true
        item.accessibilityIdentifier = tab.id
        return item
      }

      if let selectedId = args.selectedId {
        self.select(id: selectedId)
      }

      invoke.resolve()
    }
  }

  @objc public func setSelectedTab(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetSelectedTabArgs.self)

    DispatchQueue.main.async {
      guard self.bar != nil else {
        invoke.reject("no native tab bar is installed")
        return
      }
      guard self.select(id: args.id) else {
        invoke.reject("no tab with id `\(args.id)`")
        return
      }
      invoke.resolve()
    }
  }

  // MARK: - UITabBarDelegate

  /// Only fires for real taps. Setting `selectedItem` in code does not call
  /// this, which is what keeps route sync from looping back on itself.
  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard tabIds.indices.contains(item.tag) else { return }
    try? onSelect?.send(TabSelectedPayload(id: tabIds[item.tag]))
  }

  // MARK: - Layout

  /// Adds the bar as a subview of the webview rather than of the window: a
  /// native view over `WKWebView` draws above the whole rendered page, and
  /// pinning to the webview's own edges means it follows every resize without
  /// a second set of constraints to keep in step.
  ///
  /// No height constraint — `UITabBar`'s intrinsic size is what supplies the
  /// correct bar height plus the bottom safe-area padding. The appearance is
  /// left entirely untouched so iOS 26 renders it with the system's Liquid
  /// Glass material; nothing here reaches for a private API to get it.
  private func installBar(in webview: WKWebView) -> PulseTabBar {
    let bar = PulseTabBar()
    bar.delegate = self
    bar.translatesAutoresizingMaskIntoConstraints = false
    webview.addSubview(bar)
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: webview.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: webview.trailingAnchor),
      bar.bottomAnchor.constraint(equalTo: webview.bottomAnchor),
    ])

    inheritedBottomInset = webview.scrollView.contentInset.bottom
    bar.onHeightChange = { [weak self] height in
      self?.applyInset(height)
    }
    self.bar = bar
    return bar
  }

  private func teardown() {
    bar?.onHeightChange = nil
    bar?.removeFromSuperview()
    bar = nil
    onSelect = nil
    tabIds = []

    if let restored = inheritedBottomInset, let sv = webview?.scrollView {
      sv.contentInset.bottom = restored
      sv.verticalScrollIndicatorInsets.bottom = restored
    }
    inheritedBottomInset = nil
  }

  @discardableResult
  private func select(id: String) -> Bool {
    guard let bar = bar, let index = tabIds.firstIndex(of: id),
      let item = bar.items?.first(where: { $0.tag == index })
    else {
      return false
    }
    bar.selectedItem = item
    return true
  }

  /// Keeps the page's last rows reachable above the bar.
  ///
  /// The naive `contentInset.bottom = height` over-insets by the bottom safe
  /// area: `contentInsetAdjustmentBehavior` defaults to `.automatic`, so the
  /// scroll view already adds the safe area on top of whatever we set, while
  /// the bar's height *includes* that same safe area. Measuring what the
  /// system added and subtracting it is exact under any adjustment behavior,
  /// including `.never`, where the delta is simply zero.
  private func applyInset(_ height: CGFloat) {
    guard !applyingInset, let sv = webview?.scrollView else { return }

    let systemAdded = sv.adjustedContentInset.bottom - sv.contentInset.bottom
    let target = max(0, height - systemAdded)

    // Writing the inset triggers another layout pass, which calls back in
    // here. Bailing on an unchanged value is what ends that cycle.
    guard abs(sv.contentInset.bottom - target) > 0.5 else { return }

    applyingInset = true
    sv.contentInset.bottom = target
    sv.verticalScrollIndicatorInsets.bottom = target
    applyingInset = false
  }
}

@_cdecl("init_plugin_pulse_tabbar")
func initPlugin() -> Plugin {
  return PulseTabBarPlugin()
}
