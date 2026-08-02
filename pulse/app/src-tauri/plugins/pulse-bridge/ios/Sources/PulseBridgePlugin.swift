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

class GlassPanel: Decodable {
  let id: String
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat
  let cornerRadius: CGFloat
}

class UpdateGlassPanelsArgs: Decodable {
  let panels: [GlassPanel]
}

/// Hosts the native glass panels directly as subviews of the webview, the
/// same placement `SafeAreaSentinelView` uses. A `UIView` subview of a
/// `WKWebView` draws above that webview's whole rendered page (one layer
/// tree) — there is no z-order/opacity arrangement where glass above the
/// webview both samples the live map underneath AND leaves DOM content in
/// its own rect sharp. So each panel builds its real UIKit controls inside
/// its own `contentView`: per Apple's `UIVisualEffectView` contract, content
/// added there composites above the effect, not through it, so it stays
/// crisp while the effect still blurs the map beneath. The DOM equivalents
/// are removed from the render tree entirely on iOS (see `ExploreMap.tsx`);
/// this view is the only thing left to draw or handle input for them.
///
/// iOS 26+: each registered panel is a `UIVisualEffectView(UIGlassEffect)`
/// nested inside one `UIVisualEffectView(UIGlassContainerEffect)` that spans
/// the whole webview — per `UIGlassEffect.h`, glass elements nested in a
/// container effect's `contentView` render as one merged/morphing group.
/// Below iOS 26: each panel is an independent `UIBlurEffect` view; there is no
/// container-merging concept pre-26.
class GlassPanelHost: UIView {
  private var containerEffectView: UIVisualEffectView?
  private var panelViews: [String: UIVisualEffectView] = [:]

  var onZoomIn: (() -> Void)?
  var onZoomOut: (() -> Void)?
  var onHourChanged: ((Int) -> Void)?

  func update(_ panels: [GlassPanel]) {
    if #available(iOS 26.0, *) {
      updateGlass(panels)
    } else {
      updateBlur(panels)
    }
  }

  @available(iOS 26.0, *)
  private func updateGlass(_ panels: [GlassPanel]) {
    let container: UIVisualEffectView
    if let existing = containerEffectView {
      container = existing
    } else {
      container = UIVisualEffectView(effect: UIGlassContainerEffect())
      container.isUserInteractionEnabled = true
      container.translatesAutoresizingMaskIntoConstraints = false
      addSubview(container)
      NSLayoutConstraint.activate([
        container.topAnchor.constraint(equalTo: topAnchor),
        container.bottomAnchor.constraint(equalTo: bottomAnchor),
        container.leadingAnchor.constraint(equalTo: leadingAnchor),
        container.trailingAnchor.constraint(equalTo: trailingAnchor),
      ])
      containerEffectView = container
    }

    reconcile(panels, into: container.contentView) {
      let effect = UIGlassEffect(style: .regular)
      effect.isInteractive = true
      return UIVisualEffectView(effect: effect)
    }
  }

  private func updateBlur(_ panels: [GlassPanel]) {
    reconcile(panels, into: self) {
      UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    }
  }

  private func reconcile(
    _ panels: [GlassPanel], into parent: UIView, makeView: () -> UIVisualEffectView
  ) {
    let ids = Set(panels.map { $0.id })
    for (id, view) in panelViews where !ids.contains(id) {
      view.removeFromSuperview()
      panelViews.removeValue(forKey: id)
    }

    for panel in panels {
      let view: UIVisualEffectView
      if let existing = panelViews[panel.id] {
        view = existing
      } else {
        view = makeView()
        view.isUserInteractionEnabled = true
        view.clipsToBounds = true
        parent.addSubview(view)
        panelViews[panel.id] = view
        buildContent(for: panel.id, in: view.contentView)
      }
      view.frame = CGRect(x: panel.x, y: panel.y, width: panel.width, height: panel.height)
      view.layer.cornerRadius = panel.cornerRadius
    }
  }

  /// Builds a panel's real controls exactly once, the first time its id is
  /// seen — never torn down and rebuilt on later rect pushes.
  private func buildContent(for id: String, in contentView: UIView) {
    switch id {
    case "zoom-controls":
      buildZoomControls(in: contentView)
    case "time-scrubber":
      buildTimeScrubber(in: contentView)
    default:
      break
    }
  }

  private func buildZoomControls(in contentView: UIView) {
    let plusButton = UIButton(type: .system)
    plusButton.setImage(UIImage(systemName: "plus"), for: .normal)
    plusButton.tintColor = .label
    plusButton.addAction(UIAction { [weak self] _ in self?.onZoomIn?() }, for: .touchUpInside)

    let minusButton = UIButton(type: .system)
    minusButton.setImage(UIImage(systemName: "minus"), for: .normal)
    minusButton.tintColor = .label
    minusButton.addAction(UIAction { [weak self] _ in self?.onZoomOut?() }, for: .touchUpInside)

    let divider = UIView()
    divider.backgroundColor = .separator
    divider.translatesAutoresizingMaskIntoConstraints = false
    divider.heightAnchor.constraint(equalToConstant: 1).isActive = true

    let stack = UIStackView(arrangedSubviews: [plusButton, divider, minusButton])
    stack.axis = .vertical
    stack.distribution = .fillEqually
    stack.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: contentView.topAnchor),
      stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
    ])
  }

  private func buildTimeScrubber(in contentView: UIView) {
    let captionLabel = UILabel()
    captionLabel.text = "HEAT AT"
    captionLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    captionLabel.textColor = .secondaryLabel

    let hourLabel = UILabel()
    hourLabel.font = .systemFont(ofSize: 19, weight: .regular)
    hourLabel.textColor = .label

    let headerRow = UIStackView(arrangedSubviews: [captionLabel, hourLabel])
    headerRow.axis = .horizontal
    headerRow.distribution = .equalSpacing
    headerRow.alignment = .center

    let slider = UISlider()
    slider.minimumValue = 0
    slider.maximumValue = 23
    let now = Calendar.current.component(.hour, from: Date())
    slider.value = Float(now)
    hourLabel.text = Self.hourText(now)
    slider.addAction(
      UIAction { [weak self, weak slider, weak hourLabel] _ in
        guard let slider else { return }
        let hour = Int(slider.value.rounded())
        hourLabel?.text = Self.hourText(hour)
        self?.onHourChanged?(hour)
      }, for: .valueChanged)

    let tickRow = UIStackView(
      arrangedSubviews: ["12AM", "6", "NOON", "6", "11PM"].map { text in
        let label = UILabel()
        label.text = text
        label.font = .monospacedSystemFont(ofSize: 9.5, weight: .regular)
        label.textColor = .secondaryLabel
        return label
      })
    tickRow.axis = .horizontal
    tickRow.distribution = .equalSpacing

    let stack = UIStackView(arrangedSubviews: [headerRow, slider, tickRow])
    stack.axis = .vertical
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),
      stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
    ])
  }

  private static func hourText(_ hour: Int) -> String {
    let h = hour % 24
    let ampm = h >= 12 ? "pm" : "am"
    let disp = h % 12 == 0 ? 12 : h % 12
    return "\(disp):00 \(ampm)"
  }

  /// Touches land on a real panel's controls; everywhere else on this
  /// full-webview overlay must pass straight through to the map/DOM beneath,
  /// exactly like when the host had `isUserInteractionEnabled = false`.
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    for view in panelViews.values where view.frame.contains(point) {
      return view.hitTest(convert(point, to: view), with: event)
    }
    return nil
  }

  func clear() {
    for view in panelViews.values { view.removeFromSuperview() }
    panelViews.removeAll()
    containerEffectView?.removeFromSuperview()
    containerEffectView = nil
  }
}

class PulseBridgePlugin: Plugin {
  private weak var observedWebView: WKWebView?
  private var sentinel: SafeAreaSentinelView?
  private var glassHost: GlassPanelHost?

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

    let glassHost = GlassPanelHost()
    glassHost.isUserInteractionEnabled = true
    glassHost.backgroundColor = .clear
    glassHost.translatesAutoresizingMaskIntoConstraints = false
    webview.addSubview(glassHost)
    NSLayoutConstraint.activate([
      glassHost.topAnchor.constraint(equalTo: webview.topAnchor),
      glassHost.bottomAnchor.constraint(equalTo: webview.bottomAnchor),
      glassHost.leadingAnchor.constraint(equalTo: webview.leadingAnchor),
      glassHost.trailingAnchor.constraint(equalTo: webview.trailingAnchor),
    ])
    glassHost.onZoomIn = { [weak self] in self?.trigger("zoomIn", data: JSObject()) }
    glassHost.onZoomOut = { [weak self] in self?.trigger("zoomOut", data: JSObject()) }
    glassHost.onHourChanged = { [weak self] hour in
      self?.trigger("hourChanged", data: ["hour": hour])
    }
    self.glassHost = glassHost
  }

  deinit {
    sentinel?.onChange = nil
    sentinel?.removeFromSuperview()
    glassHost?.clear()
    glassHost?.removeFromSuperview()
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

  @objc public func updateGlassPanels(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(UpdateGlassPanelsArgs.self)
    DispatchQueue.main.async { [weak self] in
      self?.glassHost?.update(args.panels)
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_pulse_bridge")
func initPlugin() -> Plugin {
  return PulseBridgePlugin()
}
