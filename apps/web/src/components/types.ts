export interface EventSummary {
  id: string;
  name: string;
  date: string;
  location: string;
  description: string;
}

export interface FamilyMember {
  firstName: string;
  lastName: string;
  eventIds: string[];
}

export interface ClaimResult {
  publicId: string;
  familyName: string;
  members: FamilyMember[];
  events: EventSummary[];
}

export interface DressCodeInfo {
  description: string;
  palette: { name: string; color: string }[];
}
