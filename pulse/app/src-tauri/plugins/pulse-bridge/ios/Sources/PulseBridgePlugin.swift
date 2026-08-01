import Tauri
import UIKit
import WebKit

class ImpactOptions: Decodable {
  let style: ImpactStyle?
}

enum ImpactStyle: String, Decodable {
  case light, medium, heavy, soft, rigid

  func toUIKit() -> UIImpactFeedbackGenerator.FeedbackStyle {
    switch self {
    case .light: return .light
    case .medium: return .medium
    case .heavy: return .heavy
    case .soft: return .soft
    case .rigid: return .rigid
    }
  }
}

class SafeAreaInsets: Encodable {
  let top: CGFloat
  let right: CGFloat
  let bottom: CGFloat
  let left: CGFloat

  init(_ insets: UIEdgeInsets) {
    self.top = insets.top
    self.right = insets.right
    self.bottom = insets.bottom
    self.left = insets.left
  }
}

/// An inert view pinned to its superview's edges. UIKit calls
/// `safeAreaInsetsDidChange()` on every view whose insets change, and that is
/// the documented hook for this. `UIView.safeAreaInsets` is a derived property
/// and is not documented as KVO-compliant, so observing it is not dependable.
/// Because this view matches the webview exactly, its insets are the webview's.
class SafeAreaSentinelView: UIView {
  var onChange: ((UIEdgeInsets) -> Void)?

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    onChange?(safeAreaInsets)
  }
}

class PulseBridgePlugin: Plugin {
  private weak var observedWebView: WKWebView?
  private var sentinel: SafeAreaSentinelView?

  override public func load(webview: WKWebView) {
    observedWebView = webview

    let sentinel = SafeAreaSentinelView()
    sentinel.isUserInteractionEnabled = false
    sentinel.backgroundColor = .clear
    sentinel.translatesAutoresizingMaskIntoConstraints = false
    webview.addSubview(sentinel)
    NSLayoutConstraint.activate([
      sentinel.topAnchor.constraint(equalTo: webview.topAnchor),
      sentinel.bottomAnchor.constraint(equalTo: webview.bottomAnchor),
      sentinel.leadingAnchor.constraint(equalTo: webview.leadingAnchor),
      sentinel.trailingAnchor.constraint(equalTo: webview.trailingAnchor),
    ])
    sentinel.onChange = { [weak self] insets in
      self?.pushSafeAreaInsets(insets)
    }
    self.sentinel = sentinel

    pushSafeAreaInsets(webview.safeAreaInsets)
  }

  deinit {
    sentinel?.onChange = nil
    sentinel?.removeFromSuperview()
  }

  private func pushSafeAreaInsets(_ insets: UIEdgeInsets) {
    guard let webview = observedWebView else { return }
    let js = """
      document.documentElement.style.setProperty('--safe-area-inset-top', '\(insets.top)px');
      document.documentElement.style.setProperty('--safe-area-inset-right', '\(insets.right)px');
      document.documentElement.style.setProperty('--safe-area-inset-bottom', '\(insets.bottom)px');
      document.documentElement.style.setProperty('--safe-area-inset-left', '\(insets.left)px');
      """
    webview.evaluateJavaScript(js)
  }

  @objc public func impact(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ImpactOptions.self)
    let style = (args.style ?? .medium).toUIKit()
    DispatchQueue.main.async {
      let generator = UIImpactFeedbackGenerator(style: style)
      generator.prepare()
      generator.impactOccurred()
      invoke.resolve()
    }
  }

  @objc public func getSafeAreaInsets(_ invoke: Invoke) throws {
    guard let webview = observedWebView else {
      invoke.resolve(SafeAreaInsets(.zero))
      return
    }
    invoke.resolve(SafeAreaInsets(webview.safeAreaInsets))
  }
}

@_cdecl("init_plugin_pulse_bridge")
func initPlugin() -> Plugin {
  return PulseBridgePlugin()
}
