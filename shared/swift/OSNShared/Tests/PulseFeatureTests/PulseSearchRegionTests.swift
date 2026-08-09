import Foundation
import MapKit
import Testing
@testable import PulseFeature

private let sydney = PulseCoordinate(latitude: -33.8688, longitude: 151.2093)

@Test func radiusClampsToWhatTheDiscoverySchemaAccepts() {
    #expect(PulseSearchRegion(center: sydney, radiusKm: 20_000).radiusKm == 500)
    #expect(PulseSearchRegion(center: sydney, radiusKm: 0).radiusKm == 0.1)
    #expect(PulseSearchRegion(center: sydney, radiusKm: 12).radiusKm == 12)
}

/// The radius has to reach the corner of the viewport, not its edge, or the
/// events in the corners of the visible map are missing from the search.
@Test func regionRadiusReachesTheCornerOfTheViewport() {
    let region = PulseSearchRegion(center: sydney, latitudeDelta: 0.2, longitudeDelta: 0.2)
    let northSouthKm = 0.1 * 111.0
    let eastWestKm = 0.1 * 111.0 * cos(sydney.latitude * .pi / 180)
    let corner = (northSouthKm * northSouthKm + eastWestKm * eastWestKm).squareRoot()
    #expect(abs(region.radiusKm - corner) < 0.001)
    #expect(region.radiusKm > northSouthKm)
}

/// A degree of longitude is narrower away from the equator, so the same span
/// covers less ground in Sydney than on the equator.
@Test func longitudeSpanShrinksWithLatitude() {
    let equator = PulseSearchRegion(
        center: PulseCoordinate(latitude: 0, longitude: 0),
        latitudeDelta: 0,
        longitudeDelta: 1
    )
    let far = PulseSearchRegion(center: sydney, latitudeDelta: 0, longitudeDelta: 1)
    #expect(far.radiusKm < equator.radiusKm)
}

@Test func mapKitRegionConvertsToTheSameSearch() {
    let mkRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: sydney.latitude, longitude: sydney.longitude),
        span: MKCoordinateSpan(latitudeDelta: 0.2, longitudeDelta: 0.2)
    )
    #expect(
        PulseSearchRegion(mkRegion)
            == PulseSearchRegion(center: sydney, latitudeDelta: 0.2, longitudeDelta: 0.2)
    )
}

@Test func aNudgeIsNotANewSearch() {
    let region = PulseSearchRegion(center: sydney, radiusKm: 10)
    // ~100 m north — a fingertip of drift at this zoom.
    let nudged = PulseSearchRegion(
        center: PulseCoordinate(latitude: sydney.latitude + 0.001, longitude: sydney.longitude),
        radiusKm: 10
    )
    #expect(nudged.isMeaningfullyDifferent(from: region) == false)
}

@Test func aRealPanIsANewSearch() {
    let region = PulseSearchRegion(center: sydney, radiusKm: 10)
    // ~11 km north, past the tenth-of-a-radius tolerance.
    let panned = PulseSearchRegion(
        center: PulseCoordinate(latitude: sydney.latitude + 0.1, longitude: sydney.longitude),
        radiusKm: 10
    )
    #expect(panned.isMeaningfullyDifferent(from: region))
}

@Test func zoomingIsANewSearchEvenWithoutMoving() {
    let region = PulseSearchRegion(center: sydney, radiusKm: 10)
    #expect(PulseSearchRegion(center: sydney, radiusKm: 20).isMeaningfullyDifferent(from: region))
    #expect(PulseSearchRegion(center: sydney, radiusKm: 10.5).isMeaningfullyDifferent(from: region) == false)
}

@Test func distanceMatchesTheServersHaversine() {
    let melbourne = PulseCoordinate(latitude: -37.8136, longitude: 144.9631)
    // Sydney–Melbourne great-circle distance is ~713 km.
    #expect(abs(distanceKm(from: sydney, to: melbourne) - 713) < 5)
    #expect(distanceKm(from: sydney, to: sydney) == 0)
}
