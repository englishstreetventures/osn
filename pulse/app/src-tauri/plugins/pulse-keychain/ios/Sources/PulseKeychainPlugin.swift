import Foundation
import Security
import Tauri

// Every item written here is device-only and never syncs to iCloud Keychain.
//
// One iOS behaviour callers must plan for: keychain items outlive the app.
// Deleting Pulse does not clear this service, so a reinstall reads back the
// previous install's credentials. Whatever stores a session token here has to
// treat a found token as untrusted until the server validates it, and call
// delete() on sign-out rather than relying on uninstall to clean up.
private let keychainService = "com.osn.pulse.keychain"

class SetArgs: Decodable {
  let key: String
  let value: String
}

class KeyArgs: Decodable {
  let key: String
}

private enum PulseKeychainError: Error {
  case status(OSStatus)

  var message: String {
    switch self {
    case .status(let status):
      if let cfMessage = SecCopyErrorMessageString(status, nil) {
        return cfMessage as String
      }
      return "keychain operation failed with OSStatus \(status)"
    }
  }
}

private func baseQuery(account: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: account,
    // Pin the search to device-only items so a (never-created, but
    // hypothetically restored) synced item can never be read back here.
    kSecAttrSynchronizable as String: false,
  ]
}

class PulseKeychainPlugin: Plugin {
  @objc public func set(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetArgs.self)
    guard let data = args.value.data(using: .utf8) else {
      invoke.reject("value is not valid UTF-8")
      return
    }

    var addQuery = baseQuery(account: args.key)
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

    var status = SecItemAdd(addQuery as CFDictionary, nil)

    if status == errSecDuplicateItem {
      // Update in place rather than delete-then-add: a single atomic
      // keychain call, with no window where the item is briefly absent and
      // no risk of losing the value if an add-after-delete failed.
      let matchQuery = baseQuery(account: args.key)
      let update: [String: Any] = [
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      ]
      status = SecItemUpdate(matchQuery as CFDictionary, update as CFDictionary)
    }

    guard status == errSecSuccess else {
      invoke.reject(PulseKeychainError.status(status).message)
      return
    }

    invoke.resolve()
  }

  @objc public func get(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(KeyArgs.self)

    var query = baseQuery(account: args.key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    if status == errSecItemNotFound {
      invoke.resolve(nil as String?)
      return
    }

    guard status == errSecSuccess else {
      invoke.reject(PulseKeychainError.status(status).message)
      return
    }

    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
      invoke.reject("stored keychain item is not valid UTF-8")
      return
    }

    invoke.resolve(value)
  }

  @objc public func delete(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(KeyArgs.self)

    let query = baseQuery(account: args.key)
    let status = SecItemDelete(query as CFDictionary)

    guard status == errSecSuccess || status == errSecItemNotFound else {
      invoke.reject(PulseKeychainError.status(status).message)
      return
    }

    invoke.resolve()
  }
}

@_cdecl("init_plugin_pulse_keychain")
func initPlugin() -> Plugin {
  return PulseKeychainPlugin()
}
