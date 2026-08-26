// OSNTesting: fixtures, fakes and traits shared by the app test targets.
//
// A source target rather than a test target, because SwiftPM shares source
// targets across test targets and shares nothing between test targets — which
// is why `MockURLProtocol` lived in five copies before it moved here.
//
// Depends on OSNKit since fakes here stand in for its client/session types.
import OSNKit
