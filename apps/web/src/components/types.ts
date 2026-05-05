export interface EventSummary {
  id: string;
  name: string;
  date: string;
  location: string;
  description: string;
}

export interface ClaimResult {
  guestName: string;
  events: EventSummary[];
}

export interface DressCodeInfo {
  description: string;
  palette: { name: string; color: string }[];
}
