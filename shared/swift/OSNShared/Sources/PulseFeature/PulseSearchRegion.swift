import Foundation
import MapKit

/// A map viewport expressed the way `discoverEvents` wants it: a centre plus
/// a radius in kilometres.
///
/// `lat`, `lng` and `radiusKm` are a triangle on the wire — the discovery
/// schema rejects a request carrying one or two of them ("Location triangle"
/// in `pulse/api/src/services/discovery.ts`). Holding all three in one value
/// means a half-built filter can't reach the server by accident.
///
/// Nothing here touches CoreLocation. The search follows the map the user is
/// looking at, not the device, so Pulse needs no location permission and no
/// new entitlement.
public struct PulseSearchRegion: Equatable, Sendable {
    /// Matches `RadiusKm` in the discovery schema. Outside this range the
    /// request is a 422, so a zoomed-right-out map clamps to 500 km and
    /// searches what fits rather than asking for the impossible.
    public static let radiusRangeKm: ClosedRange<Double> = 0.1...500

    public let center: PulseCoordinate
    public let radiusKm: Double

    public init(center: PulseCoordinate, radiusKm: Double) {
        self.center = center
        self.radiusKm = min(max(radiusKm, Self.radiusRangeKm.lowerBound), Self.radiusRangeKm.upperBound)
    }

    /// The circle covering a viewport given as a centre and its full spans in
    /// degrees: the distance from the centre to a corner, so nothing on
    /// screen falls outside the search.
    ///
    /// The server's bounding box clamps `cos(lat)` away from zero to stay
    /// conservative. This uses the real cosine instead — near the poles a
    /// degree of longitude genuinely is short, and inflating it here would
    /// search a band the user cannot see.
    public init(center: PulseCoordinate, latitudeDelta: Double, longitudeDelta: Double) {
        let northSouthKm = (latitudeDelta / 2) * kmPerDegreeLatitude
        let eastWestKm = (longitudeDelta / 2) * kmPerDegreeLatitude * cos(center.latitude * degreesToRadians)
        self.init(
            center: center,
            radiusKm: (northSouthKm * northSouthKm + eastWestKm * eastWestKm).squareRoot()
        )
    }

    public init(_ region: MKCoordinateRegion) {
        self.init(
            center: PulseCoordinate(latitude: region.center.latitude, longitude: region.center.longitude),
            latitudeDelta: region.span.latitudeDelta,
            longitudeDelta: region.span.longitudeDelta
        )
    }

    /// Whether this viewport sits far enough from `other` to be worth another
    /// search.
    ///
    /// `onMapCameraChange` reports the end of every gesture, including the
    /// nudge that moves the map by a few points and returns the same events.
    /// A tenth of the current radius is about the smallest move that can pull
    /// something new in at the edge, so anything smaller is dropped.
    public func isMeaningfullyDifferent(from other: PulseSearchRegion) -> Bool {
        let tolerance = other.radiusKm / 10
        if abs(radiusKm - other.radiusKm) > tolerance { return true }
        return distanceKm(from: center, to: other.center) > tolerance
    }
}

/// ~111 km per degree of latitude — the constant the server's bounding box
/// uses, so the client's idea of the visible circle matches the one being
/// searched.
private let kmPerDegreeLatitude = 111.0
private let earthRadiusKm = 6371.0
private let degreesToRadians = Double.pi / 180

/// Great-circle distance, mirroring `haversineKm` in the discovery service.
func distanceKm(from: PulseCoordinate, to: PulseCoordinate) -> Double {
    let deltaLat = (to.latitude - from.latitude) * degreesToRadians
    let deltaLng = (to.longitude - from.longitude) * degreesToRadians
    let a =
        (sin(deltaLat / 2) * sin(deltaLat / 2))
        + cos(from.latitude * degreesToRadians) * cos(to.latitude * degreesToRadians)
        * (sin(deltaLng / 2) * sin(deltaLng / 2))
    return 2 * earthRadiusKm * asin(min(1, a.squareRoot()))
}
