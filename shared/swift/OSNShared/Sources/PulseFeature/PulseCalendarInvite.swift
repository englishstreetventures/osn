import Foundation

/// An event as an `.ics` document, ready to hand to a share sheet.
///
/// Why a document and not EventKit. Writing straight into the user's calendar
/// needs `NSCalendarsWriteOnlyAccessUsageDescription`, a permission prompt and
/// a new entitlement — and `EKEvent` requires an `endDate`. Pulse events are
/// allowed to have no end time (`endTime` is nullable in
/// `pulse/db/src/schema/events.ts`), so EventKit would force a made-up
/// duration onto every one of them. RFC 5545 §3.6.1 lets a `VEVENT` carry
/// `DTSTART` with no `DTEND`, meaning exactly what the server means: the
/// start is known and the end is not.
///
/// Calendar.app also shows the user what it is before anything is saved, and
/// this type is pure Swift — no UIKit, so it compiles against the macOS SDK
/// and is testable without a simulator.
///
/// No `URL` property is written. The document would need a public event page
/// to point at, and no Pulse web host is deployed yet — inventing a hostname
/// here would put a dead link in the user's calendar forever.
public struct PulseCalendarInvite: Equatable, Sendable {
    /// Suggested filename, including the `.ics` extension.
    public let filename: String
    /// The full document, CRLF-delimited per RFC 5545 §3.1.
    public let text: String

    public init(event: PulseEvent, stamp: Date = Date()) {
        filename = Self.filename(for: event)
        text = Self.document(for: event, stamp: stamp)
    }

    private static func document(for event: PulseEvent, stamp: Date) -> String {
        var lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            // The `-//` prefix marks a non-registered product id, which is
            // what RFC 5545 §3.7.3 asks of anyone not in the IANA registry.
            "PRODID:-//OSN//Pulse//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "BEGIN:VEVENT",
            // Uniqueness comes from the event id, which is already unique
            // across Pulse. The usual `uid@host` spelling is skipped for the
            // same reason `URL` is: there is no host to name.
            "UID:pulse-event-\(event.id)",
            "DTSTAMP:\(timestamp(stamp))",
            "DTSTART:\(timestamp(event.startTime))",
        ]
        if let endTime = event.endTime {
            lines.append("DTEND:\(timestamp(endTime))")
        }
        lines.append("SUMMARY:\(escaped(event.title))")
        if let description = event.description, !description.isEmpty {
            lines.append("DESCRIPTION:\(escaped(description))")
        }
        if let location = location(for: event) {
            lines.append("LOCATION:\(escaped(location))")
        }
        if let coordinate = event.coordinate {
            // GEO is a structured value, not TEXT — the separator is a real
            // semicolon and must not be escaped (RFC 5545 §3.8.1.6).
            lines.append("GEO:\(coordinate.latitude);\(coordinate.longitude)")
        }
        if let category = event.category, !category.isEmpty {
            lines.append("CATEGORIES:\(escaped(category))")
        }
        lines.append("STATUS:\(event.status == .cancelled ? "CANCELLED" : "CONFIRMED")")
        lines.append(contentsOf: ["END:VEVENT", "END:VCALENDAR"])
        return lines.map(folded).joined(separator: "\r\n") + "\r\n"
    }

    /// `venue` and `location` are different columns and both are free text —
    /// `venue` names the place, `location` says where it is — so a calendar
    /// entry wants whichever of the two exists, and both when both do.
    private static func location(for event: PulseEvent) -> String? {
        let parts = [event.venue, event.location]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private static func filename(for event: PulseEvent) -> String {
        let allowed = CharacterSet.alphanumerics.union(.whitespaces).union(CharacterSet(charactersIn: "-_"))
        let cleaned = String(
            event.title.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        )
        // Trim the replacements too, or a title that is all punctuation
        // becomes a filename of nothing but dashes.
        .trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "-")))
        let stem = cleaned.isEmpty ? "event" : String(cleaned.prefix(60))
        return "\(stem).ics"
    }
}

/// UTC, in the `DATE-TIME` form RFC 5545 §3.3.5 calls form 2.
///
/// Built from calendar components rather than a `DateFormatter`, which is not
/// `Sendable` and could not be shared from a static context without unchecked
/// escapes.
private func timestamp(_ date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    return String(
        format: "%04d%02d%02dT%02d%02d%02dZ",
        parts.year ?? 0,
        parts.month ?? 0,
        parts.day ?? 0,
        parts.hour ?? 0,
        parts.minute ?? 0,
        parts.second ?? 0
    )
}

/// TEXT escaping per RFC 5545 §3.3.11. A colon is deliberately not escaped —
/// only backslash, semicolon, comma and newlines are.
private func escaped(_ value: String) -> String {
    var result = ""
    for character in value {
        switch character {
        case "\\": result += "\\\\"
        case ";": result += "\\;"
        case ",": result += "\\,"
        // A CRLF in the source collapses to one escaped newline; the lone
        // carriage return is dropped so it can't reappear as a line break.
        case "\n": result += "\\n"
        case "\r": continue
        default: result.append(character)
        }
    }
    return result
}

/// Line folding per RFC 5545 §3.1: no line over 75 octets, continuations
/// begin with a single space.
///
/// The limit counts octets, not characters, so the width of each character is
/// its UTF-8 length — an emoji in a title is four, and folding on character
/// count would let a line past the limit. Folding between characters (never
/// inside one) also keeps every continuation valid UTF-8.
private func folded(_ line: String) -> String {
    let limit = 75
    var result = ""
    var octets = 0
    for character in line {
        let width = String(character).utf8.count
        if octets + width > limit {
            result += "\r\n "
            octets = 1
        }
        result.append(character)
        octets += width
    }
    return result
}
