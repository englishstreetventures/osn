import Foundation
import Testing
@testable import PulseFeature

private let start = Date(timeIntervalSince1970: 1_700_000_000) // 20231114T221320Z
private let end = Date(timeIntervalSince1970: 1_700_007_200) // 20231115T001320Z
private let stamp = Date(timeIntervalSince1970: 1_699_999_000) // 20231114T215640Z

private func makeEvent(
    id: String = "evt_1",
    title: String = "Rooftop Session",
    description: String? = nil,
    location: String? = nil,
    venue: String? = nil,
    coordinate: PulseCoordinate? = nil,
    category: String? = nil,
    endTime: Date? = nil,
    status: PulseEvent.Status = .upcoming,
    price: PulsePrice? = nil
) -> PulseEvent {
    PulseEvent(
        id: id,
        title: title,
        description: description,
        location: location,
        venue: venue,
        venueId: nil,
        coordinate: coordinate,
        category: category,
        startTime: start,
        endTime: endTime,
        status: status,
        imageUrl: nil,
        price: price,
        visibility: .public,
        guestListVisibility: .public,
        joinPolicy: .open,
        allowInterested: true,
        commsChannels: "none",
        chatId: nil,
        seriesId: nil,
        instanceOverride: false,
        createdByProfileId: "prf_1",
        createdByName: nil,
        createdByAvatar: nil,
        cancelledAt: nil,
        hardDeleteAt: nil,
        cancellationReason: nil,
        createdAt: start,
        updatedAt: start
    )
}

/// Undo the 75-octet folding, so a test can assert on whole property values
/// without caring where the line happened to break.
private func unfolded(_ document: String) -> String {
    document.replacingOccurrences(of: "\r\n ", with: "")
}

private func lines(_ document: String) -> [String] {
    unfolded(document).components(separatedBy: "\r\n").filter { !$0.isEmpty }
}

@Test func documentCarriesTheEventWithNoEndTime() {
    let ics = PulseCalendarInvite(event: makeEvent(), stamp: stamp).text
    let properties = lines(ics)
    #expect(properties.first == "BEGIN:VCALENDAR")
    #expect(properties.last == "END:VCALENDAR")
    #expect(properties.contains("UID:pulse-event-evt_1"))
    #expect(properties.contains("DTSTAMP:20231114T215640Z"))
    #expect(properties.contains("DTSTART:20231114T221320Z"))
    #expect(properties.contains("SUMMARY:Rooftop Session"))
    #expect(properties.contains("STATUS:CONFIRMED"))
    // The whole point of writing the document by hand: an event with no end
    // time gets no DTEND, rather than an invented duration.
    #expect(properties.contains { $0.hasPrefix("DTEND") } == false)
}

@Test func anEndTimeBecomesDtend() {
    let ics = PulseCalendarInvite(event: makeEvent(endTime: end), stamp: stamp).text
    #expect(lines(ics).contains("DTEND:20231115T001320Z"))
}

@Test func everyLineEndsWithCrlf() {
    let ics = PulseCalendarInvite(event: makeEvent(), stamp: stamp).text
    #expect(ics.hasSuffix("\r\n"))
    // A bare LF anywhere would be a line break RFC 5545 doesn't allow.
    #expect(ics.components(separatedBy: "\n").dropLast().allSatisfy { $0.hasSuffix("\r") })
}

@Test func textValuesAreEscaped() {
    let event = makeEvent(
        title: "Drinks, snacks; maybe a \\ or two",
        description: "First line\nSecond line"
    )
    let properties = lines(PulseCalendarInvite(event: event, stamp: stamp).text)
    #expect(properties.contains(#"SUMMARY:Drinks\, snacks\; maybe a \\ or two"#))
    #expect(properties.contains(#"DESCRIPTION:First line\nSecond line"#))
}

/// GEO is a structured value, so its semicolon separates the pair rather than
/// being part of a text run — escaping it would break the property.
@Test func coordinatesAreNotTextEscaped() {
    let event = makeEvent(coordinate: PulseCoordinate(latitude: -33.8688, longitude: 151.2093))
    #expect(lines(PulseCalendarInvite(event: event, stamp: stamp).text).contains("GEO:-33.8688;151.2093"))
}

@Test func venueAndLocationBothLandInOneLocationProperty() {
    let both = makeEvent(location: "Surry Hills", venue: "The Clock Hotel")
    #expect(lines(PulseCalendarInvite(event: both, stamp: stamp).text).contains("LOCATION:The Clock Hotel\\, Surry Hills"))

    let venueOnly = makeEvent(venue: "The Clock Hotel")
    #expect(lines(PulseCalendarInvite(event: venueOnly, stamp: stamp).text).contains("LOCATION:The Clock Hotel"))

    let neither = makeEvent()
    #expect(lines(PulseCalendarInvite(event: neither, stamp: stamp).text).contains { $0.hasPrefix("LOCATION") } == false)
}

@Test func aCancelledEventSaysSo() {
    let ics = PulseCalendarInvite(event: makeEvent(status: .cancelled), stamp: stamp).text
    #expect(lines(ics).contains("STATUS:CANCELLED"))
}

@Test func longValuesFoldAtSeventyFiveOctets() {
    let event = makeEvent(description: String(repeating: "long enough to fold. ", count: 20))
    let ics = PulseCalendarInvite(event: event, stamp: stamp).text
    for line in ics.components(separatedBy: "\r\n") {
        #expect(line.utf8.count <= 75)
    }
    // Folding is only a transport detail — unfolding returns the value whole.
    #expect(unfolded(ics).contains("DESCRIPTION:\(event.description ?? "")"))
}

/// The fold counts octets, so a line of emoji has to break four times sooner
/// than a line of ASCII — and never inside a character.
@Test func foldingCountsOctetsNotCharacters() {
    let event = makeEvent(title: String(repeating: "🎉", count: 40))
    let ics = PulseCalendarInvite(event: event, stamp: stamp).text
    for line in ics.components(separatedBy: "\r\n") {
        #expect(line.utf8.count <= 75)
    }
    #expect(unfolded(ics).contains("SUMMARY:\(event.title)"))
}

@Test func filenameDropsCharactersAPathCannotHold() {
    #expect(PulseCalendarInvite(event: makeEvent(title: "Drinks: 8/10"), stamp: stamp).filename == "Drinks- 8-10.ics")
    #expect(PulseCalendarInvite(event: makeEvent(title: "///"), stamp: stamp).filename == "event.ics")
    #expect(PulseCalendarInvite(event: makeEvent(title: String(repeating: "a", count: 200)), stamp: stamp).filename.count == 64)
}

/// Minor units per major unit is a property of the currency. Dividing by 100
/// everywhere would print ¥1850 as ¥18.50.
@Test func priceScalesByTheCurrencysOwnExponent() {
    let locale = Locale(identifier: "en_AU")
    #expect(PulsePrice(minorUnits: 1850, currency: "AUD").formatted(locale: locale) == "$18.50")
    #expect(PulsePrice(minorUnits: 1850, currency: "JPY").formatted(locale: locale).contains("1,850"))
    #expect(PulsePrice(minorUnits: 1850, currency: "KWD").formatted(locale: locale).contains("1.850"))
}

@Test func zeroIsFree() {
    #expect(PulsePrice(minorUnits: 0, currency: "AUD").isFree)
    #expect(makeEvent().isFree)
    #expect(makeEvent(price: PulsePrice(minorUnits: 500, currency: "AUD")).isFree == false)
}
